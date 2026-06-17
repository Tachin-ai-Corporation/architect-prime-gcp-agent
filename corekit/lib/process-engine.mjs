// corekit/lib/process-engine.mjs — Process registry, plan lifecycle, deterministic executor
// Extracted from agent-brain.mjs Phase 1B
//
// Manages process definitions (load from disk + Firestore), plan CRUD
// (create/approve/stamp/amend), and the mechanical sequential executor
// that walks a stamped M→C→T hierarchy without Cortex involvement.
//
// All Firestore access uses injected wrappers (firestoreWrite/firestoreRead).
// No raw FIRESTORE_BASE references — plan CRUD uses getGceToken + REST.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { getGceToken } from './gce-auth.mjs';
import { smartTruncate } from './vertex-text.mjs';
import { firestoreEncode, firestoreDecode } from './firestore.mjs';
import { extractVerdict, extractFailRecommendation } from './verdict.mjs';

/**
 * Create a process engine instance.
 *
 * @param {object} deps
 * @param {object} deps.vertexText           - vertex-text.mjs instance (summarize, generateTitle)
 * @param {object} deps.projects             - projects.mjs instance (getDefaultId, get, buildContext, checkCompletion, activateDependents, checkDependencies)
 * @param {function} deps.agentDispatcher    - async (agentId, taskEnvelope, contextString) => { success, output, error, durationMs }
 * @param {function} [deps.logger]           - (level, msg) function
 * @param {object} deps.config
 * @param {string} deps.config.coreDir       - e.g. '/opt/corekit'
 * @param {string} deps.config.primeId       - e.g. 'chuck'
 * @param {string} deps.config.agentId       - e.g. 'stan'
 * @param {string} [deps.config.agentEmail]  - e.g. 'stan@...'
 * @param {string} deps.config.gcpProject    - e.g. 'architect-prime-beta'
 * @param {function} deps.generateId         - (prefix) => string
 * @param {function} deps.writeHistory       - async (envelopeId, prevStatus, newStatus, actor, detail) => void
 * @param {function} deps.recallMemory       - async (query) => string
 * @param {function} deps.firestoreWrite     - async (collection, docId, data) => result
 * @param {function} deps.firestoreRead      - async (collection, docId) => data
 * @param {function} deps.firestoreQuery     - async (collection, filters) => results[]
 * @param {function} deps.sendNotification   - async (type, data) => void
 * @param {function} deps.createCT           - async (parentId, opts) => checkpointId
 * @param {function} [deps.mergeContextPackets] - (parentCtx, childCtx) => merged
 * @param {function} [deps.extractCurrentMessage] - (intakeText) => string
 * @param {function} [deps.buildProjectContext]   - (projectId, ctx) => string|null
 * @param {function} [deps.summarizeForDelivery]  - async (type, text, ctx) => string
 * @param {function} [deps.writeMemory]           - async (envelope) => void
 * @param {function} [deps.publishArtifacts]      - async (envelope) => Array
 * @param {function} [deps.cleanupSharedWorkspace] - async (envelopeId) => void
 * @param {function} [deps.fireEventResponsibilities] - async (eventType, ctx) => void
 * @param {function} [deps.suggestContextPromotions]  - async (envelope) => void
 * @param {object}   [deps.contextBudgets]  - { dispatchSuccess, dispatchFailure, agentStep, cortexStep }
 * @returns {object} Process engine API
 */
export function createProcessEngine(deps) {
  const {
    vertexText,
    projects,
    agentDispatcher,
    config,
    generateId,
    writeHistory,
    recallMemory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    sendNotification,
    createCT,
    mergeContextPackets: _mergeCtx,
    extractCurrentMessage: _extractMsg,
    buildProjectContext: _buildProjCtx,
    summarizeForDelivery: _summarizeDelivery,
    writeMemory: _writeMemory,
    publishArtifacts: _publishArtifacts,
    cleanupSharedWorkspace: _cleanupWs,
    fireEventResponsibilities: _fireEventResp,
    suggestContextPromotions: _suggestPromo,
    contextBudgets = {},
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[process-engine] ${level}: ${msg}`));

  const {
    coreDir = '/opt/corekit',
    primeId,
    agentId,
    agentEmail = '',
    gcpProject,
  } = config;

  // Firestore REST base for direct plan/process/approval CRUD
  const FIRESTORE_BASE = gcpProject
    ? `https://firestore.googleapis.com/v1/projects/${gcpProject}/databases/(default)/documents`
    : null;

  // Context budgets
  const CTX_AGENT_STEP = contextBudgets.agentStep || 8000;

  // ---- Internal helpers ----

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  /** Get a GCE auth token (for REST calls to plans/processes/approvals). */
  async function getAuthToken() {
    return getGceToken();
  }

  /**
   * Merge two context packets (maps of key→entry). Child wins on key collision.
   * Uses injected mergeContextPackets if available, else simple shallow merge.
   */
  function mergeContextPackets(parentCtx, childCtx) {
    if (_mergeCtx) return _mergeCtx(parentCtx, childCtx);
    if (!parentCtx && !childCtx) return {};
    if (!parentCtx) return { ...(childCtx || {}) };
    if (!childCtx) return { ...(parentCtx || {}) };
    return { ...parentCtx, ...childCtx };
  }

  /**
   * Delegate to vertexText.summarize with brain's smartSummarize signature.
   * @param {string} text - Text to summarize
   * @param {number} budget - Character budget
   * @param {string} prompt - Summarization instruction
   * @returns {Promise<string>} Summarized text
   */
  async function smartSummarize(text, budget, prompt) {
    return vertexText.summarize(text, prompt, { budget });
  }

  // ---- Process registry state ----
  let PROCESSES = {};            // keyed by process id
  let _processesLoadedAt = 0;
  const PROCESSES_REFRESH_MS = 60_000;

  // ---- Process registry functions ----

  /**
   * Load standard processes bundled with CoreKit (on-disk JSON files).
   * Internal — reads from procDir on the local filesystem.
   * @returns {object} Map of processId → process definition
   */
  function loadLocalProcesses() {
    const localProcs = {};
    const procDir = coreDir + '/corekit/processes';
    try {
      if (!existsSync(procDir)) return localProcs;
      for (const file of readdirSync(procDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const p = JSON.parse(readFileSync(`${procDir}/${file}`, 'utf8'));
          if (p.id && p.status !== 'deprecated') {
            localProcs[p.id] = p;
          }
        } catch (e) {
          log('WARN', `Failed to parse local process ${file}: ${e.message}`);
        }
      }
    } catch (e) {
      log('DEBUG', `Local processes dir not found: ${e.message}`);
    }
    return localProcs;
  }

  /**
   * Load processes from both local files and Firestore.
   * Firestore definitions override local ones with the same ID.
   */
  async function loadProcesses() {
    // 1. Load standard processes from local CoreKit files (always available)
    const localProcs = loadLocalProcesses();

    // 2. Load user-defined processes from Firestore (may override local by ID)
    const firestoreProcs = {};
    try {
      const token = await getAuthToken();
      if (token && FIRESTORE_BASE) {
        const url = `${FIRESTORE_BASE}/primes/${primeId}/processes`;
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          for (const doc of (data.documents || [])) {
            const p = firestoreDecode(doc.fields || {});
            if (p.id && p.status !== 'deprecated') {
              firestoreProcs[p.id] = p;
            }
          }
        }
      }
    } catch (e) {
      log('WARN', `Failed to load Firestore processes: ${e.message}`);
    }

    // 3. Merge: Firestore overrides local (same ID), local provides baseline
    PROCESSES = { ...localProcs, ...firestoreProcs };
    _processesLoadedAt = Date.now();
    const localCount = Object.keys(localProcs).length;
    const fsCount = Object.keys(firestoreProcs).length;
    if (localCount + fsCount > 0) {
      log('INFO', `Processes loaded: ${Object.keys(PROCESSES).join(', ')} (${localCount} local, ${fsCount} firestore)`);
    }
  }

  /**
   * Ensure processes are loaded (load-once gate with periodic refresh).
   * Reloads if the cache is older than PROCESSES_REFRESH_MS.
   */
  async function ensureProcessesLoaded() {
    if (Date.now() - _processesLoadedAt > PROCESSES_REFRESH_MS) {
      await loadProcesses();
    }
  }

  // ---- Plan lifecycle ----

  /**
   * Convert a Process definition into a checkpoint_plan decision payload.
   * Groups steps by checkpointBoundary markers into checkpoints.
   * Substitutes parameters into step titles, descriptions, and context.
   *
   * @param {object} process - Process definition
   * @param {object} [parameters={}] - Parameter values for substitution
   * @returns {object|null} Checkpoint plan or null if no steps
   */
  function processToCheckpointPlan(process, parameters = {}) {
    const steps = process.steps || [];
    if (steps.length === 0) return null;

    // Substitute parameters in strings
    function substitute(text) {
      if (!text || typeof text !== 'string') return text;
      let result = text;
      for (const [key, value] of Object.entries(parameters)) {
        result = result.replace(new RegExp(`\\$\\{${key}\\}|\\{\\{${key}\\}\\}`, 'g'), String(value));
      }
      return result;
    }

    // Expand sub_process references into flat steps (with circular ref protection)
    function expandSteps(steps, visited = new Set()) {
      const expanded = [];
      for (const step of steps) {
        if (step.sub_process) {
          if (visited.has(step.sub_process)) {
            log('WARN', `Circular sub_process reference detected: ${step.sub_process} — skipping`);
            continue;
          }
          const subProc = PROCESSES[step.sub_process];
          if (!subProc || !subProc.steps) {
            log('WARN', `Sub-process '${step.sub_process}' not found — skipping`);
            continue;
          }
          visited.add(step.sub_process);
          expanded.push(...expandSteps(subProc.steps, visited));
        } else {
          expanded.push(step);
        }
      }
      return expanded;
    }

    const expandedSteps = expandSteps(steps);

    // Group steps into checkpoints (split on checkpointBoundary: true)
    const checkpoints = [];
    let currentTasks = [];
    let cpIndex = 1;

    for (let i = 0; i < expandedSteps.length; i++) {
      const step = expandedSteps[i];
      const task = {
        agent: step.agent || 'motor',
        task: substitute(step.description || step.title),
        accept_criteria: substitute(step.accept_criteria || ''),
        intent: step.intent || 'execute',
        // Carry process metadata for special step types
        _step_type: step.type || 'standard',
        _optional: step.optional || false,
        _specialty: step.specialty || null,
        _approval_message: substitute(step.approval_message || null),
      };
      currentTasks.push(task);

      // Create checkpoint boundary
      if (step.checkpointBoundary || i === expandedSteps.length - 1) {
        checkpoints.push({
          instruction: substitute(step.checkpointBoundary
            ? `Checkpoint ${cpIndex}: ${step.title || 'Steps ' + (i - currentTasks.length + 2) + '-' + (i + 1)}`
            : `Process Steps`),
          accept_criteria: '',
          tasks: currentTasks,
        });
        currentTasks = [];
        cpIndex++;
      }
    }

    return {
      action: 'checkpoint_plan',
      checkpoints,
      process_id: process.id,
      process_name: process.name,
      process_version: process.version || 1,
    };
  }

  /**
   * Create a Plan from a process definition. Stores the plan layout without
   * stamping any work envelopes. Plan starts in 'draft' status.
   *
   * @param {string} processId - Process definition ID
   * @param {object} parameters - Parameter values for the process
   * @param {string} [projectId] - Project to associate (defaults to default project)
   * @param {string} [instruction] - Human-readable instruction/description
   * @returns {Promise<object>} The created Plan document
   */
  async function createPlan(processId, parameters, projectId, instruction) {
    await ensureProcessesLoaded();
    const process = PROCESSES[processId];
    if (!process) throw new Error(`Process not found: ${processId}`);

    const cpPlan = processToCheckpointPlan(process, parameters);
    if (!cpPlan || !cpPlan.checkpoints || cpPlan.checkpoints.length === 0) {
      throw new Error(`Process '${processId}' produces no checkpoints`);
    }

    const defaultProjectId = projects ? projects.getDefaultId() : null;
    const planId = generateId('plan');
    const plan = {
      id: planId,
      project_id: projectId || defaultProjectId,
      name: `${process.name}: ${(instruction || '').substring(0, 100)}`,
      process_id: processId,
      process_version: process.version || 1,
      parameters,
      layout: {
        mission: {
          instruction: instruction || `Execute process: ${process.name}`,
          accept_criteria: `Process '${process.name}' completes all steps successfully.`,
          owner: agentEmail || agentId,
        },
        checkpoints: cpPlan.checkpoints.map(cp => ({
          instruction: cp.instruction,
          accept_criteria: cp.accept_criteria || '',
          tasks: (cp.tasks || []).map(t => ({
            instruction: t.task,
            accept_criteria: t.accept_criteria || '',
            agent: t.agent || 'motor',
          })),
        })),
      },
      mission_id: null,
      amendments: [],
      status: 'draft',
      approved_by: null,
      approved_at: null,
      created_at: now(),
      updated_at: now(),
    };

    // Write to Firestore
    const token = await getAuthToken();
    if (token && FIRESTORE_BASE) {
      const url = `${FIRESTORE_BASE}/primes/${primeId}/plans/${planId}`;
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: firestoreEncode(plan) }),
      });
    }

    log('INFO', `Plan created: ${planId} (process: ${processId}, ${cpPlan.checkpoints.length} checkpoints)`);
    return plan;
  }

  /**
   * Approve a Plan. Transitions from 'draft' to 'approved' and records the approver.
   *
   * @param {string} planId - Plan ID to approve
   * @param {string} approvedBy - Who approved
   * @returns {Promise<object>} The updated Plan document
   */
  async function approvePlan(planId, approvedBy) {
    const token = await getAuthToken();
    if (!token) throw new Error('No auth token');

    const url = `${FIRESTORE_BASE}/primes/${primeId}/plans/${planId}`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Plan not found: ${planId}`);
    const plan = firestoreDecode((await resp.json()).fields || {});

    if (plan.status !== 'draft') {
      throw new Error(`Plan ${planId} is '${plan.status}', cannot approve`);
    }

    plan.status = 'approved';
    plan.approved_by = approvedBy;
    plan.approved_at = now();
    plan.updated_at = now();

    await fetch(url, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: firestoreEncode(plan) }),
    });

    log('INFO', `Plan approved: ${planId} by ${approvedBy}`);
    return plan;
  }

  /**
   * Stamp a Plan: create the full M→C→T envelope hierarchy from the plan layout
   * and begin execution. Transitions plan to 'executing'.
   *
   * @param {string} planId - Plan ID to stamp
   * @param {object|null} intake - The intake that triggered this
   * @param {object} memoryContext - Memory context for agent dispatches
   * @returns {Promise<object>} { plan, mission, checkpointEnvelopes }
   */
  async function stampPlan(planId, intake, memoryContext) {
    const token = await getAuthToken();
    if (!token) throw new Error('No auth token');

    const url = `${FIRESTORE_BASE}/primes/${primeId}/plans/${planId}`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Plan not found: ${planId}`);
    const plan = firestoreDecode((await resp.json()).fields || {});

    if (plan.status !== 'approved') {
      throw new Error(`Plan ${planId} is '${plan.status}', must be 'approved' to stamp`);
    }

    const layout = plan.layout;
    if (!layout || !layout.checkpoints || layout.checkpoints.length === 0) {
      throw new Error(`Plan ${planId} has no checkpoints in layout`);
    }

    const defaultProjectId = projects ? projects.getDefaultId() : null;

    // Create Mission envelope
    const missionId = generateId('w');
    const mission = {
      id: missionId,
      type: 'M',
      parent_id: null,
      owner: layout.mission.owner || agentEmail || agentId,
      status: 'active',
      intent: 'plan_execution',
      title: await vertexText.generateTitle(layout.mission.instruction, 'mission'),
      instruction: layout.mission.instruction,
      accept_criteria: layout.mission.accept_criteria,
      context_summary: `Executing plan: ${plan.name}`,
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: intake?.source || 'plan',
      source_meta: intake?.source_meta || { plan_id: planId },
      project_id: plan.project_id || defaultProjectId,
      plan_id: planId,
      process_id: plan.process_id,
      process_version: plan.process_version,
      created_at: now(),
      started_at: now(),
      completed_at: null,
      updated_at: now(),
      iteration: 0,
      memory_context: memoryContext || null,
      delivery_status: 'internal',
    };

    // Create Checkpoint + Task envelopes
    const checkpointEnvelopes = [];
    for (let ci = 0; ci < layout.checkpoints.length; ci++) {
      const cp = layout.checkpoints[ci];
      const cpId = generateId('w');
      const cEnvelope = {
        id: cpId,
        type: 'C',
        parent_id: missionId,
        owner: agentEmail || agentId,
        status: 'pending',
        intent: 'checkpoint',
        title: await vertexText.generateTitle(cp.instruction || `Checkpoint ${ci + 1}`, 'checkpoint'),
        instruction: cp.instruction,
        accept_criteria: cp.accept_criteria || '',
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: 'plan',
        source_meta: { plan_id: planId, checkpoint: ci + 1, checkpoint_total: layout.checkpoints.length },
        project_id: plan.project_id || defaultProjectId,
        plan_id: planId,
        created_at: now(),
        started_at: null,
        completed_at: null,
        updated_at: now(),
        iteration: 0,
      };

      const tEnvelopes = [];
      for (let ti = 0; ti < (cp.tasks || []).length; ti++) {
        const task = cp.tasks[ti];
        const tId = generateId('w');
        const tEnvelope = {
          id: tId,
          type: 'T',
          parent_id: cpId,
          owner: agentEmail || agentId,
          status: 'pending',
          intent: 'execute',
          title: await vertexText.generateTitle(task.instruction || `Task ${ci + 1}.${ti + 1}`, 'task'),
          instruction: task.instruction,
          accept_criteria: task.accept_criteria || '',
          output: null,
          children: [],
          context_forward: null,
          error: null,
          source_channel: 'plan',
          source_meta: {
            plan_id: planId,
            step_type: 'standard',
            step_index: ti,
            checkpoint_index: ci,
            agent: task.agent || 'motor',
            optional: false,
          },
          project_id: plan.project_id || defaultProjectId,
          plan_id: planId,
          created_at: now(),
          started_at: null,
          completed_at: null,
          updated_at: now(),
          iteration: 0,
        };
        tEnvelopes.push(tEnvelope);
        cEnvelope.children.push(tId);
      }

      checkpointEnvelopes.push({ cEnvelope, tEnvelopes });
      mission.children.push(cpId);
    }

    // Write everything to Firestore
    await firestoreWrite('work', missionId, mission);
    await writeHistory(missionId, null, 'active', 'brain', `Plan stamped: ${plan.name} (${checkpointEnvelopes.length} checkpoints)`);

    for (const { cEnvelope, tEnvelopes } of checkpointEnvelopes) {
      await firestoreWrite('work', cEnvelope.id, cEnvelope);
      await writeHistory(cEnvelope.id, null, 'pending', 'brain', `Checkpoint created (plan: ${planId})`);
      for (const tEnv of tEnvelopes) {
        await firestoreWrite('work', tEnv.id, tEnv);
        await writeHistory(tEnv.id, null, 'pending', 'brain', `Task created (plan: ${planId})`);
      }
    }

    // Update plan with mission link
    plan.mission_id = missionId;
    plan.status = 'executing';
    plan.updated_at = now();
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: firestoreEncode(plan) }),
    });

    log('INFO', `Plan stamped: ${planId} → mission ${missionId} (${checkpointEnvelopes.length} checkpoints, ${checkpointEnvelopes.reduce((s, c) => s + c.tEnvelopes.length, 0)} tasks)`);
    return { plan, mission, checkpointEnvelopes };
  }

  /**
   * Amend a Plan layout. Records the amendment and updates remaining unstamped work.
   *
   * @param {string} planId - Plan ID to amend
   * @param {string} reason - Why the amendment is being made
   * @param {string|object} changes - Description or structured changes
   * @param {string} [amendedBy] - Who made the amendment
   * @returns {Promise<object>} The updated Plan document
   */
  async function amendPlan(planId, reason, changes, amendedBy) {
    const token = await getAuthToken();
    if (!token) throw new Error('No auth token');

    const url = `${FIRESTORE_BASE}/primes/${primeId}/plans/${planId}`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Plan not found: ${planId}`);
    const plan = firestoreDecode((await resp.json()).fields || {});

    if (plan.status !== 'draft' && plan.status !== 'approved' && plan.status !== 'executing') {
      throw new Error(`Plan ${planId} is '${plan.status}', cannot amend`);
    }

    plan.amendments = plan.amendments || [];
    plan.amendments.push({
      timestamp: now(),
      reason,
      changes: typeof changes === 'string' ? changes : JSON.stringify(changes),
      amended_by: amendedBy || agentEmail || agentId,
    });
    plan.updated_at = now();

    await fetch(url, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: firestoreEncode(plan) }),
    });

    log('INFO', `Plan amended: ${planId} — ${reason}`);
    return plan;
  }

  // ---- Deterministic Process Executor ----

  /**
   * Execute a process deterministically.
   * Creates the full M → C → T envelope hierarchy upfront, then runs
   * each task sequentially. No Cortex involvement in structure or flow.
   *
   * @param {object|null} intake - The intake that triggered this (null if from decide loop)
   * @param {object} decision - Cortex classify/decide result with process info
   * @param {object} memoryContext - Memory context for agent dispatches
   * @param {string} processId - The process ID to execute
   * @param {object|null} [existingEnvelope=null] - If called from decide loop, the existing envelope to use as mission
   */
  async function executeProcess(intake, decision, memoryContext, processId, existingEnvelope = null) {
    await ensureProcessesLoaded();
    const process = PROCESSES[processId];
    if (!process) {
      log('ERROR', `executeProcess: process '${processId}' not found`);
      return;
    }

    const parameters = decision.parameters || {};

    // Validate required parameters
    const requiredParams = Object.entries(process.parameters || {})
      .filter(([, def]) => def && typeof def === 'object' && def.required && !def.default)
      .map(([key]) => key);
    const missingParams = requiredParams.filter(k => !(k in parameters));
    if (missingParams.length > 0) {
      // Auto-fill missing params from intake/decision text when obvious
      // When called from follow_process (decide loop), intake is null and decision.instruction
      // may have been stripped by enforceSchema. Fall back to the existing envelope's instruction.
      const sourceText = decision.instruction || intake?.text || existingEnvelope?.instruction || '';
      for (const param of [...missingParams]) {
        if (sourceText && !parameters[param]) {
          parameters[param] = sourceText;
          missingParams.splice(missingParams.indexOf(param), 1);
          log('INFO', `executeProcess: auto-filled parameter '${param}' from intake text (${sourceText.length} chars)`);
        }
      }
      if (missingParams.length > 0) {
        log('WARN', `executeProcess: missing required parameters after auto-fill: ${missingParams.join(', ')} — falling back to decide loop`);
        return 'fallback_to_decide';
      }
    }

    // Fill defaults for missing optional parameters
    for (const [key, def] of Object.entries(process.parameters || {})) {
      if (!(key in parameters) && def && typeof def === 'object' && def.default !== undefined) {
        parameters[key] = def.default;
      }
    }

    // Convert process to checkpoint structure
    const cpPlan = processToCheckpointPlan(process, parameters);
    if (!cpPlan || !cpPlan.checkpoints || cpPlan.checkpoints.length === 0) {
      log('ERROR', `executeProcess: process '${processId}' has no steps`);
      return;
    }

    log('INFO', `executeProcess: '${process.name}' v${process.version || 1} — ${cpPlan.checkpoints.length} checkpoints, stamping hierarchy`);

    const defaultProjectId = projects ? projects.getDefaultId() : null;

    // ---- Step 1: Create or reuse Mission envelope ----
    let mission;
    if (existingEnvelope) {
      mission = existingEnvelope;
      mission.process_id = processId;
      mission.process_version = process.version || 1;
      mission.status = 'active';
      mission.started_at = mission.started_at || now();
      mission.updated_at = now();
    } else {
      const missionId = generateId('w');
      // Extract raw user message for source_text preservation
      const sourceText = intake?.text && _extractMsg ? _extractMsg(intake.text) : null;
      mission = {
        id: missionId,
        type: 'M',
        parent_id: null,
        owner: agentEmail || agentId,
        status: 'active',
        intent: 'process_execution',
        title: await vertexText.generateTitle(decision.instruction || process.description || process.name, 'mission'),
        instruction: decision.instruction || intake?.text || `Execute process: ${process.name}`,
        accept_criteria: decision.accept_criteria || `Process '${process.name}' completes all steps successfully.`,
        context_summary: decision.context_summary || process.description || null,
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: intake?.source || 'system',
        source_meta: intake?.source_meta || {},
        project_id: decision.project_id || defaultProjectId,
        context: decision.context || null,
        source_text: sourceText || null, // Raw user message — preserved verbatim for child dispatches
        process_id: processId,
        process_version: process.version || 1,
        created_at: now(),
        started_at: now(),
        completed_at: null,
        updated_at: now(),
        iteration: 0,
        memory_context: memoryContext,
        delivery_status: 'internal',
      };
    }

    // Merge process context template into mission context
    if (process.contextTemplate && typeof process.contextTemplate === 'object') {
      const templateCtx = {};
      for (const [key, entry] of Object.entries(process.contextTemplate)) {
        if (entry && typeof entry === 'object') {
          const processed = { ...entry };
          if (processed.name) processed.name = processed.name.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
          if (processed.summary) processed.summary = processed.summary.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
          templateCtx[key] = processed;
        }
      }
      mission.context = mergeContextPackets(mission.context, templateCtx);
    }

    // ---- Step 2: Stamp all C and T envelopes upfront ----
    const checkpointEnvelopes = []; // { cEnvelope, tEnvelopes[] }

    for (let ci = 0; ci < cpPlan.checkpoints.length; ci++) {
      const cp = cpPlan.checkpoints[ci];
      const cpId = generateId('w');
      const cpNum = ci + 1;

      const cEnvelope = {
        id: cpId,
        type: 'C',
        parent_id: mission.id,
        owner: agentEmail || agentId,
        status: 'pending',
        intent: 'checkpoint',
        title: await vertexText.generateTitle(cp.instruction || `Checkpoint ${cpNum}`, 'checkpoint'),
        instruction: cp.instruction || `Checkpoint ${cpNum}`,
        accept_criteria: cp.accept_criteria || '',
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: mission.source_channel || 'system',
        source_meta: {},
        project_id: mission.project_id || null,
        process_id: processId,
        created_at: now(),
        started_at: null,
        completed_at: null,
        updated_at: now(),
        iteration: 0,
      };

      const tEnvelopes = [];
      for (let ti = 0; ti < (cp.tasks || []).length; ti++) {
        const task = cp.tasks[ti];
        const tId = generateId('w');
        const taskNum = ti + 1;
        const stepType = task._step_type || 'standard';

        const tEnvelope = {
          id: tId,
          type: 'T',
          parent_id: cpId,
          owner: agentEmail || agentId,
          status: 'pending',
          intent: stepType === 'approval_gate' ? 'approval_gate' : (task.intent || 'execute'),
          title: await vertexText.generateTitle(task.task || `Step ${cpNum}.${taskNum}`, 'task'),
          instruction: task.task || '',
          accept_criteria: task.accept_criteria || '',
          output: null,
          children: [],
          context_forward: null,
          error: null,
          source_channel: mission.source_channel || 'system',
          source_meta: {
            step_type: stepType,
            step_index: ti,
            checkpoint_index: ci,
            agent: task.agent || 'motor',
            optional: task._optional || false,
            specialty: task._specialty || null,
            approval_message: task._approval_message || null,
          },
          project_id: mission.project_id || null,
          process_id: processId,
          created_at: now(),
          started_at: null,
          completed_at: null,
          updated_at: now(),
          iteration: 0,
        };

        tEnvelopes.push(tEnvelope);
        cEnvelope.children.push(tId);
      }

      checkpointEnvelopes.push({ cEnvelope, tEnvelopes });
      mission.children.push(cpId);
    }

    // ---- Step 3: Write everything to Firestore ----
    await firestoreWrite('work', mission.id, mission);
    if (!existingEnvelope) {
      await writeHistory(mission.id, null, 'active', 'brain', `Process '${process.name}' — stamped full hierarchy`);
    }

    for (const { cEnvelope, tEnvelopes } of checkpointEnvelopes) {
      await firestoreWrite('work', cEnvelope.id, cEnvelope);
      await writeHistory(cEnvelope.id, null, 'pending', 'brain', `Checkpoint created (process: ${process.name})`);
      for (const tEnv of tEnvelopes) {
        await firestoreWrite('work', tEnv.id, tEnv);
        await writeHistory(tEnv.id, null, 'pending', 'brain', `Task created (${tEnv.source_meta.step_type})`);
      }
    }

    // Increment process execution count
    try {
      const token = await getAuthToken();
      if (token && FIRESTORE_BASE) {
        const procUrl = `${FIRESTORE_BASE}/primes/${primeId}/processes/${processId}`;
        const currentCount = process.execution_count || 0;
        await fetch(procUrl + '?updateMask.fieldPaths=execution_count&updateMask.fieldPaths=last_executed_at', {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            execution_count: { integerValue: String(currentCount + 1) },
            last_executed_at: { stringValue: now() },
          }}),
        });
      }
    } catch (e) { log('DEBUG', `Process execution count update failed: ${e.message}`); }

    log('INFO', `executeProcess: hierarchy stamped — M:${mission.id}, ${checkpointEnvelopes.length} checkpoints, ${checkpointEnvelopes.reduce((s, c) => s + c.tEnvelopes.length, 0)} tasks`);

    // ---- Pre-flight workspace cleanup ----
    const processDoc = PROCESSES[processId];
    const preFlight = processDoc?.pre_flight;
    if (preFlight) {
      log('INFO', `Process ${processId}: running pre-flight check`);
      const preFlightResult = await agentDispatcher('motor', {
        instruction: `[PRE-FLIGHT CHECK]\n${preFlight}`,
        accept_criteria: 'Pre-flight checks completed, workspace ready',
        _missionId: mission.id,
      });
      log('INFO', `Process ${processId}: pre-flight ${preFlightResult.success ? 'passed' : 'FAILED'} (${preFlightResult.durationMs}ms)`);
    }

    // ---- Step 4: Execute the plan ----
    await runProcessPlan(mission, checkpointEnvelopes, memoryContext);
  }

  /**
   * Mechanical sequential executor for a stamped process plan.
   * Walks through C → T envelopes, dispatches to agents, handles approval gates.
   * No Cortex involvement — purely deterministic.
   *
   * @param {object} mission - The M-envelope
   * @param {Array} checkpointEnvelopes - Array of { cEnvelope, tEnvelopes[] }
   * @param {object} memoryContext - Memory context for agent dispatches
   * @param {number} [startCpIndex=0] - Checkpoint index to start from (for resumption)
   * @param {number} [startTaskIndex=0] - Task index within the starting checkpoint (for resumption)
   */
  async function runProcessPlan(mission, checkpointEnvelopes, memoryContext, startCpIndex = 0, startTaskIndex = 0) {
    let allResults = [];
    let planFailed = false;

    for (let ci = startCpIndex; ci < checkpointEnvelopes.length; ci++) {
      const { cEnvelope, tEnvelopes } = checkpointEnvelopes[ci];
      const cpNum = ci + 1;
      const taskStartIdx = (ci === startCpIndex) ? startTaskIndex : 0;

      // Mark checkpoint active
      cEnvelope.status = 'active';
      cEnvelope.started_at = cEnvelope.started_at || now();
      cEnvelope.updated_at = now();
      await firestoreWrite('work', cEnvelope.id, cEnvelope);
      if (taskStartIdx === 0) {
        await writeHistory(cEnvelope.id, 'pending', 'active', 'brain', `Checkpoint ${cpNum} started`);
      }

      log('INFO', `Process CP${cpNum}/${checkpointEnvelopes.length}: ${tEnvelopes.length} tasks`);

      let cpFailed = false;
      let cpResults = [];

      for (let ti = taskStartIdx; ti < tEnvelopes.length; ti++) {
        const tEnv = tEnvelopes[ti];
        const taskNum = ti + 1;
        const stepType = tEnv.source_meta?.step_type || 'standard';
        const taskAgent = tEnv.source_meta?.agent || 'motor';
        const isOptional = tEnv.source_meta?.optional || false;

        // ---- Approval Gate ----
        if (stepType === 'approval_gate') {
          log('INFO', `Process CP${cpNum} Task ${taskNum}: Approval gate — pausing`);

          const approvalId = generateId('apr');

          // Write approval doc
          try {
            const token = await getAuthToken();
            if (token && FIRESTORE_BASE) {
              const approvalUrl = `${FIRESTORE_BASE}/primes/${primeId}/approvals/${approvalId}`;
              await fetch(approvalUrl, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: {
                  envelopeId: { stringValue: mission.id },
                  checkpointId: { stringValue: cEnvelope.id },
                  taskIndex: { integerValue: String(ti) },
                  checkpointIndex: { integerValue: String(ci) },
                  title: { stringValue: (tEnv.title || '').substring(0, 200) },
                  description: { stringValue: tEnv.instruction || tEnv.title || '' },
                  processId: { stringValue: mission.process_id || '' },
                  processName: { stringValue: PROCESSES[mission.process_id]?.name || '' },
                  planId: { stringValue: mission.plan_id || '' },
                  status: { stringValue: 'pending' },
                  requestedAt: { stringValue: now() },
                }}),
              });
            }
          } catch (e) { log('WARN', `Failed to write approval doc: ${e.message}`); }

          // Mark task as awaiting approval
          tEnv.status = 'awaiting_approval';
          tEnv.started_at = now();
          tEnv.updated_at = now();
          tEnv.source_meta.approval_id = approvalId;
          await firestoreWrite('work', tEnv.id, tEnv);
          await writeHistory(tEnv.id, 'pending', 'awaiting_approval', 'brain', `Approval gate: ${tEnv.title}`);

          // Mark checkpoint as awaiting
          cEnvelope.status = 'awaiting_approval';
          cEnvelope.updated_at = now();
          await firestoreWrite('work', cEnvelope.id, cEnvelope);
          await writeHistory(cEnvelope.id, 'active', 'awaiting_approval', 'brain', `Paused at approval gate`);

          // Mark mission as awaiting with resume state
          mission.status = 'awaiting_approval';
          mission.updated_at = now();
          mission.source_meta = {
            ...mission.source_meta,
            paused_approval_id: approvalId,
            paused_checkpoint_index: ci,
            paused_task_index: ti,
          };
          await firestoreWrite('work', mission.id, mission);
          await writeHistory(mission.id, 'active', 'awaiting_approval', 'brain', `Process paused — approval gate`);

          // Build context summary from completed steps
          const priorSteps = [...allResults, ...cpResults];
          const rawStepData = priorSteps.map(r => ({
            step: r.step, agent: r.agent, success: r.success,
            result: (r.result || '').substring(0, 1500),
          }));

          // Use custom approval_message from process definition if available
          const customMessage = tEnv.source_meta?.approval_message || '';
          const approvalTitle = tEnv.title || tEnv.instruction || 'Approval needed';

          // Basic fallback text (used if LLM summarization fails)
          const fallbackText = [
            `⏸ **Approval needed**`,
            ``,
            `**${approvalTitle.substring(0, 200)}**`,
            customMessage ? `\n${customMessage}` : '',
            ``,
            `Approve or reject from the dashboard, or reply \`approve\` / \`reject\` here.`,
          ].filter(Boolean).join('\n');

          // LLM summarization for clean, self-contained approval notification
          let cleanSummary = fallbackText;
          if (_summarizeDelivery) {
            cleanSummary = await _summarizeDelivery('approval_request', fallbackText, {
              steps: rawStepData,
              title: approvalTitle,
              processName: PROCESSES[mission.process_id]?.name || '',
              customMessage,
            });
          }

          const notifOutput = [
            `⏸ **Approval needed**`,
            ``,
            cleanSummary,
            ``,
            `Reply \`approve\` or \`reject\` here, or use the dashboard.`,
          ].join('\n');

          // Send notification
          const notifId = generateId('w');
          await firestoreWrite('work', notifId, {
            id: notifId,
            type: 'T',
            parent_id: null, // Must be null for Mouth to deliver (it skips child envelopes)
            owner: agentEmail || agentId,
            status: 'complete',
            intent: 'notification',
            instruction: 'Approval gate notification',
            output: notifOutput,
            source_channel: mission.source_channel || 'system',
            source_meta: { approval_id: approvalId, notification_type: 'approval_gate' },
            created_at: now(),
            started_at: now(),
            completed_at: now(),
            updated_at: now(),
            children: [],
            accept_criteria: null,
            context_summary: null,
            context_forward: null,
            error: null,
            iteration: 0,
            delivery_status: 'pending',
          });

          log('INFO', `Process paused at CP${cpNum} task ${taskNum} — awaiting approval ${approvalId}`);
          return; // Exit — approval handler will resume
        }

        // ---- Standard / spawn_responsibility / delegation task ----
        log('INFO', `Process CP${cpNum} Task ${taskNum}/${tEnvelopes.length}: ${taskAgent} — ${(tEnv.title || '').substring(0, 60)}`);

        // Mark task active
        tEnv.status = 'active';
        tEnv.started_at = now();
        tEnv.updated_at = now();
        await firestoreWrite('work', tEnv.id, tEnv);
        await writeHistory(tEnv.id, 'pending', 'active', 'brain', `Dispatching to ${taskAgent}`);

        // Build instruction with prior results context
        let instruction = tEnv.instruction || '';

        // Add prior results for context
        const priorContext = allResults.length > 0
          ? allResults.map(r => `Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n\n')
          : null;

        // Dispatch to agent
        const buildProjCtx = _buildProjCtx || (projects ? (pid, ctx) => projects.buildContext(pid, ctx, coreDir) : null);
        const dispatchProjCtx = mission.project_id
          ? (buildProjCtx?.(mission.project_id, mission.context) || null)
          : null;
        const dispatchEnvelope = {
          instruction,
          accept_criteria: tEnv.accept_criteria || '',
          context_summary: tEnv.instruction || '',
          prior_results_context: priorContext,
          memory_context: typeof memoryContext === 'object' ? memoryContext.recalled : memoryContext,
          _missionId: mission.id,
          _projectContext: dispatchProjCtx,
          _sourceText: mission.source_text || null,
        };

        const result = await agentDispatcher(taskAgent, dispatchEnvelope);

        // Record result
        const stepResult = {
          step: `${cpNum}.${taskNum}`,
          agent: taskAgent,
          task: (tEnv.title || tEnv.instruction || '').substring(0, 150),
          result: result.success
            ? smartTruncate(result.output || '', CTX_AGENT_STEP)
            : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', CTX_AGENT_STEP)}`,
          success: result.success,
          durationMs: result.durationMs,
        };
        cpResults.push(stepResult);

        // Update task envelope
        tEnv.output = result.success
          ? smartTruncate(result.output || '', CTX_AGENT_STEP)
          : result.error || 'Task failed';
        tEnv.status = result.success ? 'complete' : 'failed';
        tEnv.completed_at = now();
        tEnv.updated_at = now();
        if (result.error) tEnv.error = result.error;
        await firestoreWrite('work', tEnv.id, tEnv);
        await writeHistory(tEnv.id, 'active', tEnv.status, 'brain',
          `${taskAgent}: ${result.success ? 'completed' : 'failed'} (${result.durationMs}ms)`);

        log('INFO', `Process CP${cpNum} Task ${taskNum} ${result.success ? 'completed' : 'FAILED'} (${result.durationMs}ms)`);

        // Retry once on failure (for non-optional tasks)
        if (!result.success && !isOptional) {
          log('INFO', `Process CP${cpNum} Task ${taskNum}: retrying once`);
          const retryResult = await agentDispatcher(taskAgent, {
            ...dispatchEnvelope,
            instruction: `[RETRY — previous attempt failed: ${result.error}]\n\n${instruction}`,
            prior_results_context: [
              priorContext,
              `[PREVIOUS ATTEMPT FAILED] ${result.error}\nOutput: ${smartTruncate(result.output || '', 500)}`,
            ].filter(Boolean).join('\n\n'),
          });

          if (retryResult.success) {
            log('INFO', `Process CP${cpNum} Task ${taskNum}: retry succeeded`);
            cpResults[cpResults.length - 1] = {
              ...stepResult,
              result: smartTruncate(retryResult.output || '', CTX_AGENT_STEP),
              success: true,
              durationMs: result.durationMs + retryResult.durationMs,
            };
            tEnv.output = smartTruncate(retryResult.output || '', CTX_AGENT_STEP);
            tEnv.status = 'complete';
            tEnv.error = null;
            tEnv.completed_at = now();
            tEnv.updated_at = now();
            await firestoreWrite('work', tEnv.id, tEnv);
            await writeHistory(tEnv.id, 'failed', 'complete', 'brain', `Retry succeeded (${retryResult.durationMs}ms)`);
          } else {
            // Hard failure
            cpFailed = true;
            break;
          }
        }
      }

      // Mark checkpoint complete/failed
      allResults.push(...cpResults);
      cEnvelope.status = cpFailed ? 'failed' : 'complete';
      cEnvelope.completed_at = now();
      cEnvelope.updated_at = now();
      await firestoreWrite('work', cEnvelope.id, cEnvelope);
      await writeHistory(cEnvelope.id, 'active', cEnvelope.status, 'brain',
        `Checkpoint ${cpNum} ${cpFailed ? 'failed' : 'complete'} (${cpResults.length} tasks)`);

      log('INFO', `Process CP${cpNum} ${cpFailed ? 'FAILED' : 'complete'} (${cpResults.length} tasks)`);

      // ---- Automatic checkpoint verification ----
      if (!cpFailed && cpResults.length > 0) {
        const verifySummary = cpResults.map(r => `Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${(r.result || '').substring(0, 500)}`).join('\n\n');

        log('INFO', `Process CP${cpNum}: running automatic verification`);
        const verifyResult = await agentDispatcher('cerebellum', {
          instruction: [
            `[CHECKPOINT VERIFICATION]`,
            `Verify the following completed checkpoint against the acceptance criteria.`,
            `Read the verification SKILL.md before rendering your verdict.`,
            ``,
            `## Acceptance Criteria`,
            cEnvelope.accept_criteria || 'All tasks completed successfully with correct outcomes.',
            ``,
            `## Task Results`,
            verifySummary,
          ].join('\n'),
          accept_criteria: 'Verification verdict rendered via report_pass or report_fail tool',
          _missionId: mission.id,
        });

        if (verifyResult.success && verifyResult.output) {
          const verdict = extractVerdict(verifyResult.output);
          if (verdict === 'FAIL') {
            const recommendation = extractFailRecommendation(verifyResult.output);
            log('WARN', `Process CP${cpNum}: verification FAIL`);
            cEnvelope.status = 'failed';
            cEnvelope.error = `Verification failed: ${recommendation}`;
            cEnvelope.updated_at = now();
            await firestoreWrite('work', cEnvelope.id, cEnvelope);
            await writeHistory(cEnvelope.id, 'complete', 'failed', 'brain', `Verification failed`);
            cpFailed = true;
          } else if (verdict === 'PASS') {
            log('INFO', `Process CP${cpNum}: verification PASS`);
          } else {
            // No verdict tool called — flag for review, don't fail the checkpoint
            log('WARN', `[TELEMETRY] verification_no_verdict: Process CP${cpNum} — cerebellum did not call verdict tool. Continuing.`);
            log('WARN', `Process CP${cpNum}: verification inconclusive — cerebellum did not render verdict tool`);
          }
        }
      }

      if (cpFailed) {
        planFailed = true;
        break;
      }
    }

    // ---- Step 5: Auto-complete the mission ----
    const processName = PROCESSES[mission.process_id]?.name || mission.process_id;
    const totalTasks = allResults.length;
    const successTasks = allResults.filter(r => r.success).length;

    if (planFailed) {
      const failedStep = allResults.find(r => !r.success);
      mission.output = [
        `❌ Process "${processName}" failed at step ${failedStep?.step || '?'}.`,
        '',
        ...allResults.map((r, i) => `${i + 1}. **${r.task}** (${r.agent}): ${r.success ? '✅' : '❌'} ${(r.result || '').substring(0, 150)}`),
        '',
        `Failed: ${failedStep?.result || 'Unknown error'}`,
      ].join('\n');
      mission.status = 'blocked';
      mission.blocker = `Process step failed: ${failedStep?.task || 'unknown'}`;
      mission.blocker_type = 'task_failure';
      mission.blocked_at = now();
    } else {
      mission.output = [
        `✅ Process "${processName}" completed successfully (${successTasks}/${totalTasks} tasks).`,
        '',
        ...allResults.map((r, i) => `${i + 1}. **${r.task}** (${r.agent}): ✅ ${(r.result || '').substring(0, 150)}`),
      ].join('\n');
      mission.status = 'complete';
      mission.completed_at = now();
    }

    mission.updated_at = now();
    if (!mission.parent_id) mission.delivery_status = 'pending';
    await firestoreWrite('work', mission.id, mission);
    await writeHistory(mission.id, 'active', mission.status, 'brain',
      `Process ${planFailed ? 'blocked' : 'complete'}: ${processName} (${successTasks}/${totalTasks} tasks)`);

    log('INFO', `Process "${processName}" ${planFailed ? 'BLOCKED' : 'COMPLETE'}: ${successTasks}/${totalTasks} tasks`);

    // Publish shared workspace artifacts to Drive BEFORE cleanup
    if (mission.type === 'M' && _publishArtifacts) {
      const artifactLinks = await _publishArtifacts(mission);
      if (artifactLinks && artifactLinks.length > 0) {
        const linkText = artifactLinks.map(a => `- [${a.name}](${a.url})`).join('\n');
        mission.output = (mission.output || '') + `\n\n📎 **Artifacts published to Drive:**\n${linkText}`;
        await firestoreWrite('work', mission.id, mission);
      }
    }

    // Write to memory
    if (_writeMemory) await _writeMemory(mission);
    if (_cleanupWs) await _cleanupWs(mission.id);

    // Activate dependent missions and fire event responsibilities
    if (mission.type === 'M') {
      if (projects) await projects.activateDependents(mission.id);
      if (mission.project_id && projects) {
        await projects.checkCompletion(mission.project_id);
      }
      if (_fireEventResp) {
        await _fireEventResp('on_complete', {
          mission_id: mission.id,
          project_id: mission.project_id,
        });
      }
    }

    // Context promotion for project-scoped missions
    if (mission.project_id && mission.type === 'M' && mission.context) {
      if (_suggestPromo) await _suggestPromo(mission);
    }
  }

  /**
   * Resume a process plan after an approval gate.
   * Loads the child C/T envelopes from Firestore and continues execution
   * from the task after the approval gate.
   *
   * @param {object} mission - The M-envelope with paused_checkpoint_index/paused_task_index
   */
  async function resumeProcessPlan(mission) {
    const ci = mission.source_meta?.paused_checkpoint_index;
    const ti = mission.source_meta?.paused_task_index;

    if (ci === undefined || ti === undefined) {
      log('ERROR', `resumeProcessPlan: missing resume state on mission ${mission.id}`);
      return;
    }

    log('INFO', `resumeProcessPlan: resuming ${mission.id} from CP${ci + 1} task ${ti + 2}`);

    // Clean up paused state
    delete mission.source_meta.paused_approval_id;
    delete mission.source_meta.paused_checkpoint_index;
    delete mission.source_meta.paused_task_index;
    mission.status = 'active';
    mission.updated_at = now();
    await firestoreWrite('work', mission.id, mission);
    await writeHistory(mission.id, 'awaiting_approval', 'active', 'brain', 'Approval granted — resuming');

    // Load all child envelopes to reconstruct the plan
    const allChildren = [];
    for (const childId of (mission.children || [])) {
      const child = await firestoreRead('work', childId);
      if (child) allChildren.push(child);
    }

    // Reconstruct checkpointEnvelopes structure
    const checkpointEnvelopes = [];
    for (const cEnv of allChildren.filter(c => c.type === 'C').sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))) {
      const tEnvelopes = [];
      for (const tId of (cEnv.children || [])) {
        const tEnv = await firestoreRead('work', tId);
        if (tEnv) tEnvelopes.push(tEnv);
      }
      // Sort by created_at to preserve order
      tEnvelopes.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      checkpointEnvelopes.push({ cEnvelope: cEnv, tEnvelopes });
    }

    if (checkpointEnvelopes.length === 0) {
      log('ERROR', `resumeProcessPlan: no checkpoint envelopes found for mission ${mission.id}`);
      return;
    }

    // Mark the approval gate task as complete
    if (checkpointEnvelopes[ci] && checkpointEnvelopes[ci].tEnvelopes[ti]) {
      const approvalTask = checkpointEnvelopes[ci].tEnvelopes[ti];
      approvalTask.status = 'complete';
      approvalTask.output = 'Approval granted';
      approvalTask.completed_at = now();
      approvalTask.updated_at = now();
      await firestoreWrite('work', approvalTask.id, approvalTask);
      await writeHistory(approvalTask.id, 'awaiting_approval', 'complete', 'brain', 'Approval granted');
    }

    // Recall memory for context
    const memoryContext = await recallMemory(mission.instruction);

    // Resume from the task AFTER the approval gate
    await runProcessPlan(mission, checkpointEnvelopes, memoryContext, ci, ti + 1);
  }

  // ---- Public API ----

  return {
    // ---- Registry ----

    /** Load all processes from local files + Firestore. */
    async loadProcesses() {
      return loadProcesses();
    },

    /** Ensure processes are loaded (with periodic refresh). */
    async ensureLoaded() {
      return ensureProcessesLoaded();
    },

    /**
     * Get a single process by ID.
     * @param {string} id - Process ID
     * @returns {object|undefined}
     */
    getProcess(id) {
      return PROCESSES[id];
    },

    /**
     * Get all processes as a map.
     * @returns {object}
     */
    getAllProcesses() {
      return PROCESSES;
    },

    // ---- Plan lifecycle ----

    /**
     * Create a Plan from a process definition (starts in 'draft').
     * @param {string} processId
     * @param {object} parameters
     * @param {string} [projectId]
     * @param {string} [instruction]
     * @returns {Promise<object>}
     */
    createPlan,

    /**
     * Approve a Plan (draft → approved).
     * @param {string} planId
     * @param {string} approvedBy
     * @returns {Promise<object>}
     */
    approvePlan,

    /**
     * Stamp a Plan: create M→C→T hierarchy and begin execution.
     * @param {string} planId
     * @param {object|null} intake
     * @param {object} memoryContext
     * @returns {Promise<object>}
     */
    stampPlan,

    /**
     * Amend a Plan layout.
     * @param {string} planId
     * @param {string} reason
     * @param {string|object} changes
     * @param {string} [amendedBy]
     * @returns {Promise<object>}
     */
    amendPlan,

    /**
     * Convert a Process definition into a checkpoint_plan structure.
     * @param {object} process
     * @param {object} [parameters]
     * @returns {object|null}
     */
    processToCheckpointPlan,

    // ---- Execution ----

    /**
     * Execute a process deterministically (create hierarchy + run all tasks).
     * @param {object|null} intake
     * @param {object} decision
     * @param {object} memoryContext
     * @param {string} processId
     * @param {object|null} [existingEnvelope]
     */
    async execute(intake, decision, memoryContext, processId, existingEnvelope) {
      return executeProcess(intake, decision, memoryContext, processId, existingEnvelope);
    },

    /**
     * Run a stamped process plan (sequential task execution).
     * @param {object} mission
     * @param {Array} checkpointEnvelopes
     * @param {object} memoryContext
     * @param {number} [startCp]
     * @param {number} [startTask]
     */
    async runPlan(mission, checkpointEnvelopes, memoryContext, startCp, startTask) {
      return runProcessPlan(mission, checkpointEnvelopes, memoryContext, startCp, startTask);
    },

    /**
     * Resume a process plan after an approval gate.
     * @param {object} mission
     */
    async resumePlan(mission) {
      return resumeProcessPlan(mission);
    },
  };
}
