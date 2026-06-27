// checkpoint-executor.mjs — Shared checkpoint execution engine
// Phase 2.5: Convergence of checkpoint execution paths
//
// Shared walk-checkpoints-dispatch-verify-retry pattern used by
// both agent-brain.mjs (checkpoint_plan handler) and process-engine.mjs (runProcessPlan).

import { toStr } from './to-str.mjs';
import { smartTruncate } from './vertex-text.mjs';
import { makeAddress } from './channel.mjs';
import { composeDelegationMarker } from './delegation.mjs';
import { extractVerdict, extractFailSummary, extractFailRecommendation } from './verdict.mjs';
import { detectMotorFailure } from './agent-output.mjs';
import { createHash } from 'crypto';

const VALID_TASK_AGENTS = new Set(['motor', 'temporal-research', 'temporal-memory']);

function deriveStepKey(envId, cpNum, action, target = '') {
  const hash = createHash('sha256');
  hash.update(`${envId}:${cpNum}:${action}:${target}`);
  return hash.digest('hex').substring(0, 16);
}

function isStepComplete(envelope, stepKey, enabled) {
  if (!enabled) return false;
  return envelope.step_ledger?.[stepKey]?.status === 'complete';
}

function getStepResult(envelope, stepKey) {
  return envelope.step_ledger?.[stepKey];
}

async function recordStep(envelope, stepKey, result, enabled, firestoreWrite) {
  if (!enabled) return;
  envelope.step_ledger = envelope.step_ledger || {};
  envelope.step_ledger[stepKey] = {
    status: result.success ? 'complete' : 'failed',
    error: result.error || null,
    durationMs: result.durationMs || 0,
    timestamp: new Date().toISOString(),
  };
  envelope.updated_at = new Date().toISOString();
  await firestoreWrite('work', envelope.id, envelope);
}

/**
 * Execute a set of checkpoint tasks using the provided agent dispatcher.
 * Supports both pre-stamped mode (process-engine) and dynamic mode (agent-brain).
 *
 * @param {Array} checkpoints - Array of checkpoints (layout objects OR stamped envelope entries)
 * @param {Object} opts - Execution dependencies and configuration
 * @returns {Promise<Object>} { success: boolean, results: Array, paused?: boolean, waitingOnDelegation?: boolean }
 */
export async function executeCheckpoints(checkpoints, opts) {
  const {
    dispatchAgent,
    envelope,
    log = () => {},
    writeHistory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    generateId,
    contracts = {},
    skillIndex = '',
    projects = {},
    PROJECTS = {},
    addressFromMeta,
    summarizeForDelivery,
    smartSummarize,
    getAuthToken,
    FIRESTORE_BASE = '',
    PRIME_ID = '',
    AGENT_EMAIL = '',
    AGENT_ID = '',
    CORE_DIR = '/opt/corekit',
    CTX_AGENT_STEP = 8000,
    CTX_DISPATCH_FAILURE = 3000,
    startCpIndex = 0,
    startTaskIndex = 0,
    savedResults = [],
    buildProjectContext,
    publishArtifacts,
  } = opts;

  const _requiredDeps = { dispatchAgent, envelope, firestoreWrite, writeHistory, log, generateId, buildProjectContext };
  for (const [name, val] of Object.entries(_requiredDeps)) {
    if (val === undefined) {
      throw new Error(`[checkpoint-executor] Missing required dependency: "${name}". Check the opts passed to executeCheckpoints().`);
    }
  }

  const STEP_LEDGER_ENABLED = contracts.dispatch?.step_ledger_enabled !== false;
  const CHECKPOINT_RESUME_ENABLED = contracts.dispatch?.checkpoint_resume_enabled !== false;

  let allResults = savedResults || [];
  let planFailed = false;
  let delegationCount = 0;
  const maxDelegations = contracts?.dispatch?.max_delegations_per_checkpoint || 4;

  const isPreStamped = checkpoints[0] && checkpoints[0].cEnvelope !== undefined;

  for (let ci = startCpIndex; ci < checkpoints.length; ci++) {
    const cpEntry = checkpoints[ci];
    const cpNum = ci + 1;
    const taskStartIdx = (ci === startCpIndex) ? startTaskIndex : 0;

    let cpId = null;
    let cpEnvelope = null;
    let cpTasks = [];

    if (isPreStamped) {
      cpEnvelope = cpEntry.cEnvelope;
      cpId = cpEnvelope.id;
      cpTasks = cpEntry.tEnvelopes;
    } else {
      const cp = cpEntry;
      const cpInstruction = toStr(cp.instruction) || `Checkpoint ${cpNum}`;
      const cpCriteria = cp.accept_criteria || '';
      cpTasks = cp.tasks || [];

      // Find or create checkpoint envelope
      for (const childId of (envelope.children || [])) {
        try {
          const child = await firestoreRead('work', childId);
          if (child?.type === 'C' && child?.source_meta?.checkpoint === cpNum) {
            cpId = childId;
            cpEnvelope = child;
            break;
          }
        } catch { /* child may not exist */ }
      }

      if (!cpId) {
        cpId = generateId('w');
        cpEnvelope = {
          id: cpId,
          type: 'C',
          parent_id: envelope.id,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'active',
          intent: 'checkpoint',
          title: cpInstruction.substring(0, 100),
          instruction: cpInstruction,
          accept_criteria: cpCriteria,
          context_summary: allResults.length > 0
            ? `Prior checkpoints:\n${allResults.map(r => `Step ${r.step} (${r.agent}): ${toStr(r.result).substring(0, 200)}`).join('\n')}`
            : envelope.context_summary || null,
          output: null,
          children: [],
          context_forward: null,
          error: null,
          source_channel: 'brain',
          source_meta: { dispatched_by: envelope.id, checkpoint: cpNum, checkpoint_total: checkpoints.length },
          project_id: envelope.project_id || null,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          completed_at: null,
          updated_at: new Date().toISOString(),
          iteration: 0,
        };
        await firestoreWrite('work', cpId, cpEnvelope);
        envelope.children = envelope.children || [];
        envelope.children.push(cpId);
        await firestoreWrite('work', envelope.id, envelope);
        await writeHistory(cpId, null, 'active', 'brain', `Checkpoint ${cpNum}/${checkpoints.length}: ${cpInstruction.substring(0, 60)}`);
      }
    }

    if (taskStartIdx >= cpTasks.length) {
      log('INFO', `[checkpoint-executor] CP${cpNum} all tasks already complete, skipping`);
      if (cpEnvelope && cpEnvelope.status !== 'complete') {
        cpEnvelope.status = 'complete';
        cpEnvelope.output = 'Skipped (no tasks or all tasks complete)';
        cpEnvelope.updated_at = new Date().toISOString();
        if (!cpEnvelope.completed_at) cpEnvelope.completed_at = new Date().toISOString();
        await firestoreWrite('work', cpId, cpEnvelope);
        await writeHistory(cpId, cpEnvelope.status, 'complete', 'brain', 'Skipped (empty or all tasks already complete)');
      }
      continue;
    }

    // Mark checkpoint active if needed
    if (cpEnvelope.status !== 'active') {
      cpEnvelope.status = 'active';
      cpEnvelope.started_at = cpEnvelope.started_at || new Date().toISOString();
      cpEnvelope.updated_at = new Date().toISOString();
      await firestoreWrite('work', cpId, cpEnvelope);
      if (taskStartIdx === 0) {
        await writeHistory(cpId, 'pending', 'active', 'brain', `Checkpoint ${cpNum} started`);
      }
    }

    log('INFO', `[checkpoint-executor] Checkpoint ${cpNum}/${checkpoints.length}: ${cpEnvelope.instruction.substring(0, 60)} (${cpTasks.length} tasks)`);

    let cpResults = [];
    let cpFailed = false;
    let delegationDispatched = false;
    delegationCount = 0;

    for (let ti = taskStartIdx; ti < cpTasks.length; ti++) {
      const task = cpTasks[ti];
      const taskNum = ti + 1;

      // Extract task fields depending on mode
      let taskAgent, taskDesc, taskCriteria, stepType, isOptional, tEnv, tId;
      if (isPreStamped) {
        tEnv = task;
        tId = tEnv.id;
        stepType = tEnv.source_meta?.step_type || 'standard';
        taskAgent = tEnv.source_meta?.agent || 'motor';
        isOptional = tEnv.source_meta?.optional || false;
        taskDesc = tEnv.instruction || '';
        taskCriteria = tEnv.accept_criteria || '';
      } else {
        taskAgent = task.agent;
        taskDesc = toStr(task.task || task.instruction || '');
        taskCriteria = task.accept_criteria
          || `Task "${toStr(task.task || task.brief_part || '').substring(0, 60)}" completed with evidence of meaningful work. No unresolved errors in tool output.`;
        stepType = task._step_type || task.type || 'standard';
        isOptional = task._optional === true;
      }

      if (!taskAgent) {
        // Delegation tasks may lack agent — default to specialty or 'delegation'
        if (stepType === 'delegation') {
          taskAgent = task._specialty || 'delegation';
        } else {
          log('WARN', `[checkpoint-executor] Checkpoint ${cpNum} task ${taskNum} missing agent, skipping`);
          cpResults.push({ step: `${cpNum}.${taskNum}`, agent: 'unknown', result: '[SKIPPED]', success: false });
          continue;
        }
      }

      // CP2: Step-ledger dedup
      const taskStepKey = deriveStepKey(envelope.id, cpNum, 'cp_task', `${ci}.${ti}.${taskAgent}`);
      if (isStepComplete(envelope, taskStepKey, STEP_LEDGER_ENABLED)) {
        const prev = getStepResult(envelope, taskStepKey);
        log('INFO', `[checkpoint-executor] CP2 dedup: CP${cpNum} Task ${taskNum} already recorded (${prev?.status}), skipping dispatch`);
        cpResults.push({
          step: `${cpNum}.${taskNum}`,
          agent: taskAgent,
          task: taskDesc.substring(0, 200),
          result: `[REPLAYED] Step already completed (${prev?.status})`,
          success: prev?.status === 'complete',
          durationMs: prev?.durationMs || 0,
        });
        continue;
      }

      // ---- Optional step: skip if agent unavailable ----
      if (isOptional) {
        let agentAvailable = true;
        try {
          const token = await getAuthToken();
          if (token && PRIME_ID) {
            const fleetUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/fleet/${taskAgent}`;
            const fleetResp = await fetch(fleetUrl, {
              headers: { 'Authorization': `Bearer ${token}` },
              signal: AbortSignal.timeout(3000),
            });
            if (fleetResp.ok) {
              const fleetDoc = await fleetResp.json();
              const fleetStatus = fleetDoc.fields?.status?.stringValue;
              agentAvailable = fleetStatus === 'online';
            }
          }
        } catch { /* assume available on error */ }

        if (!agentAvailable) {
          log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: Optional step skipped — agent '${taskAgent}' unavailable`);
          cpResults.push({
            step: `${cpNum}.${taskNum}`,
            agent: taskAgent,
            result: '[SKIPPED] Optional step — agent unavailable',
            success: true,
            durationMs: 0,
          });
          continue;
        }
      }

      // ---- Approval Gate: pause checkpoint and notify ----
      if (stepType === 'approval_gate') {
        log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: Approval gate — pausing checkpoint`);

        const approvalId = generateId('apr');
        try {
          const token = await getAuthToken();
          if (token && FIRESTORE_BASE) {
            const approvalUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/approvals/${approvalId}`;
            await fetch(approvalUrl, {
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: {
                envelopeId: { stringValue: envelope.id },
                checkpointId: { stringValue: cpId },
                taskIndex: { integerValue: String(ti) },
                checkpointIndex: { integerValue: String(ci) },
                title: { stringValue: taskDesc.substring(0, 200) },
                description: { stringValue: taskCriteria || taskDesc },
                processId: { stringValue: envelope.process_id || '' },
                processName: { stringValue: PROJECTS[envelope.project_id]?.name || '' },
                planId: { stringValue: envelope.plan_id || '' },
                status: { stringValue: 'pending' },
                requestedAt: { stringValue: new Date().toISOString() },
              }}),
            });
          }
        } catch (e) { log('WARN', `Failed to write approval doc: ${e.message}`); }

        // Update task envelope status if in pre-stamped mode
        if (isPreStamped && tEnv) {
          tEnv.status = 'awaiting_approval';
          tEnv.started_at = new Date().toISOString();
          tEnv.updated_at = new Date().toISOString();
          tEnv.source_meta.approval_id = approvalId;
          await firestoreWrite('work', tEnv.id, tEnv);
          await writeHistory(tEnv.id, 'pending', 'awaiting_approval', 'brain', `Approval gate: ${tEnv.title}`);
        }

        cpEnvelope.status = 'awaiting_approval';
        cpEnvelope.source_meta = {
          ...cpEnvelope.source_meta,
          approval_id: approvalId,
          approval_task_index: ti,
        };
        cpEnvelope.updated_at = new Date().toISOString();
        await firestoreWrite('work', cpId, cpEnvelope);
        await writeHistory(cpId, 'active', 'awaiting_approval', 'brain',
          `Approval gate: ${taskDesc.substring(0, 60)}`);

        // Record partial results so far
        allResults.push(...cpResults);

        // Store resume state on the envelope so approval handler can continue
        envelope.source_meta = {
          ...envelope.source_meta,
          paused_approval_id: approvalId,
          paused_checkpoint_index: ci,
          paused_task_index: ti,
          paused_checkpoints: isPreStamped ? null : checkpoints,
          paused_all_results: allResults,
        };
        envelope.status = 'awaiting_approval';
        envelope.updated_at = new Date().toISOString();
        await firestoreWrite('work', envelope.id, envelope);

        // Send notification via mouth (creates a deliverable envelope)
        const rawStepData = cpResults.map(r => ({
          step: r.step, agent: r.agent, success: r.success,
          result: toStr(r.result).substring(0, 1500),
        }));
        const customMessage = isPreStamped ? (tEnv.source_meta?.approval_message || '') : taskCriteria;
        const approvalTitle = isPreStamped ? (tEnv.title || tEnv.instruction || 'Approval needed') : taskDesc;
        const fallbackNotif = `🔔 **Approval needed**\n\n**${approvalTitle.substring(0, 200)}**\n\n${customMessage ? `Criteria: ${customMessage}\n\n` : ''}Reply \`approve\` or \`reject\` here, or use the dashboard.`;
        
        let cleanNotif = fallbackNotif;
        if (summarizeForDelivery) {
          cleanNotif = await summarizeForDelivery('approval_request', fallbackNotif, {
            steps: rawStepData,
            title: approvalTitle.substring(0, 200),
            processName: PROJECTS[envelope.project_id]?.name || '',
            customMessage,
          });
        }
        const notifOutput = `🔔 **Approval needed**\n\n${cleanNotif}\n\nReply \`approve\` or \`reject\` here, or use the dashboard.`;

        const notifId = generateId('w');
        await firestoreWrite('work', notifId, {
          id: notifId,
          type: 'T',
          parent_id: null,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'complete',
          intent: 'notification',
          instruction: 'Approval gate notification',
          output: notifOutput,
          source_channel: envelope.source_channel || 'system',
          source_meta: { approval_id: approvalId, notification_type: 'approval_gate' },
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          children: [],
          accept_criteria: null,
          context_summary: null,
          context_forward: null,
          error: null,
          iteration: 0,
          delivery_status: envelope.parent_id ? 'internal' : 'pending',
          ...(envelope.parent_id ? {} : { delivery_address: addressFromMeta ? addressFromMeta(envelope.source_meta, envelope.source_channel) : makeAddress('dashboard') }),
        });

        log('INFO', `[checkpoint-executor] Checkpoint paused at CP${cpNum} task ${taskNum} — awaiting approval ${approvalId}`);
        return { paused: true, approvalId };
      }

      // ---- Spawn Responsibility: create a responsibility entry ----
      if (stepType === 'spawn_responsibility') {
        log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: Spawning responsibility via motor`);

        const respResult = await dispatchAgent('motor', {
          instruction: `Create a new responsibility using the responsibility-manage tool:\n\nresponsibility-manage create --name "${taskDesc.replace(/"/g, '\\"')}" --instruction "${(taskCriteria || taskDesc).replace(/"/g, '\\"')}"\n\nThis is a process step of type 'spawn_responsibility'.${skillIndex}`,
          accept_criteria: 'Responsibility created successfully',
          _missionId: envelope.id,
        });

        // Motor failure check
        const motorCheck = detectMotorFailure(respResult.output || respResult.error || '');
        if (motorCheck.failed) {
          respResult.success = false;
          respResult.error = motorCheck.detail;
        }

        const success = respResult.success;
        cpResults.push({
          step: `${cpNum}.${taskNum}`,
          agent: 'motor',
          task: `[spawn_responsibility] ${taskDesc.substring(0, 150)}`,
          result: success
            ? (smartSummarize ? await smartSummarize(respResult.output || '', CTX_AGENT_STEP, 'Summarize this responsibility creation result. Keep the responsibility name and config details.') : (respResult.output || ''))
            : `[FAILED] ${respResult.error}`,
          success,
          durationMs: respResult.durationMs,
        });

        if (isPreStamped && tEnv) {
          tEnv.output = success ? 'Responsibility created successfully' : respResult.error;
          tEnv.status = success ? 'complete' : 'failed';
          tEnv.completed_at = new Date().toISOString();
          tEnv.updated_at = new Date().toISOString();
          await firestoreWrite('work', tEnv.id, tEnv);
          await writeHistory(tEnv.id, 'active', tEnv.status, 'brain', `Spawning responsibility: ${success ? 'complete' : 'failed'}`);
        }

        if (!success && !isOptional) {
          cpFailed = true;
          break;
        }
        continue;
      }

      // ---- Delegation: cross-agent dispatch via GChat ----
      if (stepType === 'delegation') {
        const delegateSpecialty = task._specialty || taskAgent;
        log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: Cross-agent delegation to '${delegateSpecialty}'`);

        // Direct email from cortex/prefrontal output takes priority, but must be validated
        let targetAgentEmail = task.target_email || null;

        // Validate target_email against fleet registry (Cortex can hallucinate emails)
        if (targetAgentEmail) {
          try {
            const fleetSnap = await firestoreQuery('fleet', [
              { field: 'email', op: 'EQUAL', value: { stringValue: targetAgentEmail } },
            ], { noOrderBy: true });
            const onlineMatch = fleetSnap.find(a => a.status === 'online');
            if (!onlineMatch) {
              log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: target_email '${targetAgentEmail}' not found in fleet registry or not online — falling through to specialty lookup`);
              targetAgentEmail = null; // Clear so fleet lookup runs below
            }
          } catch (e) {
            log('WARN', `Delegation: fleet validation of '${targetAgentEmail}' failed: ${e.message} — using as-is`);
          }
        }

        if (!targetAgentEmail) {
          try {
            const fleetSnap = await firestoreQuery('fleet', [
              { field: 'specialty', op: 'EQUAL', value: { stringValue: delegateSpecialty } },
            ], { noOrderBy: true });
            const onlineAgent = fleetSnap.find(a => a.status === 'online');
            if (onlineAgent) {
              targetAgentEmail = onlineAgent.email;
            }
          } catch (e) {
            log('WARN', `Delegation: failed to resolve agent for specialty '${delegateSpecialty}': ${e.message}`);
          }
        }

        if (!targetAgentEmail) {
          log('ERROR', `Delegation: no online agent found for specialty '${delegateSpecialty}'`);
          cpResults.push({ step: `${cpNum}.${taskNum}`, agent: taskAgent, result: `[FAILED] No online agent found for specialty '${delegateSpecialty}'`, success: false });
          if (!isOptional) {
            cpFailed = true;
            break;
          }
          continue;
        }

        // ---- Self-delegation guard ----
        // If the delegation resolves to THIS agent, convert to a local motor task
        // instead of sending a GChat message to ourselves (which causes infinite loops).
        if (targetAgentEmail === (AGENT_EMAIL || AGENT_ID)) {
          log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: delegation to '${delegateSpecialty}' resolved to SELF (${targetAgentEmail}) — converting to local motor task`);
          // Override: treat as standard motor task
          stepType = 'standard';
          task.agent = 'motor';
          taskAgent = 'motor';
          // Fall through to standard task execution below
        } else {

        // ---- Concurrent delegation guard ----
        // Don't send a new delegation if the target agent already has active work from us
        try {
          const activeDelegations = await firestoreQuery('work', [
            { field: 'source_meta.target_agent_email', op: 'EQUAL', value: { stringValue: targetAgentEmail } },
            { field: 'status', op: 'IN', value: { arrayValue: { values: [
              { stringValue: 'active' }, { stringValue: 'waiting' },
              { stringValue: 'queued' }, { stringValue: 'pending' },
            ]}}},
          ], { noOrderBy: true });
          if (activeDelegations.length > 0) {
            log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: delegation to ${targetAgentEmail} blocked — ${activeDelegations.length} active delegation(s) exist: ${activeDelegations.map(d => d.id).join(', ')}`);
            cpResults.push({
              step: `${cpNum}.${taskNum}`, agent: taskAgent,
              result: `[BLOCKED] ${targetAgentEmail} already has ${activeDelegations.length} active delegation(s). Wait for completion before re-delegating.`,
              success: false,
            });
            if (!isOptional) { cpFailed = true; break; }
            continue;
          }
        } catch (e) {
          log('WARN', `[checkpoint-executor] Concurrent delegation check failed: ${e.message} — proceeding anyway`);
        }

        // ---- Delegation cap guard ----
        delegationCount++;
        if (delegationCount > maxDelegations) {
          log('WARN', `[checkpoint-executor] CP${cpNum}: delegation cap reached (${maxDelegations}). Blocking further delegations.`);
          cpResults.push({
            step: `${cpNum}.${taskNum}`, agent: taskAgent,
            result: `[BLOCKED] Delegation cap reached (${maxDelegations} per checkpoint). Synthesize with existing results or escalate.`,
            success: false,
          });
          if (!isOptional) { cpFailed = true; break; }
          continue;
        }

        // ---- Delegation dedup nudge ----
        try {
          const dedupWindowMs = (contracts?.dispatch?.delegation_dedup_window_hours || 24) * 3600_000;
          const cutoff = new Date(Date.now() - dedupWindowMs).toISOString();
          const recentDelegations = await firestoreQuery('work', [
            { field: 'source_meta.target_agent_email', op: 'EQUAL', value: { stringValue: targetAgentEmail } },
            { field: 'source_meta.dispatched_by', op: 'EQUAL', value: { stringValue: cpId } },
          ], { noOrderBy: true });
          const recentSameTarget = recentDelegations.filter(d => 
            ['complete', 'failed', 'blocked'].includes(d.status) && d.created_at > cutoff
          );
          if (recentSameTarget.length > 0) {
            const lastResult = recentSameTarget[0];
            log('INFO', `[checkpoint-executor] Delegation dedup: found ${recentSameTarget.length} recent delegation(s) to ${targetAgentEmail}`);
            // Inject advisory nudge — not blocking, but makes cortex aware
            cpResults.push({
              step: `${cpNum}.${taskNum}`, agent: 'system',
              result: `[ADVISORY] Previous delegation to ${targetAgentEmail} for this checkpoint ${lastResult.status} with: "${(lastResult.output || '').substring(0, 300)}". This new delegation should address what was different.`,
              success: true,
            });
          }
        } catch (e) {
          log('WARN', `[checkpoint-executor] Delegation dedup check failed: ${e.message}`);
        }

        // ---- Guard: reject placeholder or empty delegation instructions ----
        const PLACEHOLDER_PATTERNS = [/placeholder/i, /will be filled/i, /tbd/i, /to be determined/i, /^$/];
        const isPlaceholder = PLACEHOLDER_PATTERNS.some(p => p.test(taskDesc.trim()));
        if (isPlaceholder || taskDesc.trim().length < 20) {
          log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: delegation instruction is empty or placeholder ("${taskDesc.substring(0, 80)}"). Failing task — Cortex must provide concrete instructions.`);
          cpResults.push({
            step: `${cpNum}.${taskNum}`, agent: taskAgent,
            result: `[FAILED] Delegation instruction was empty or a placeholder. You must provide concrete, specific instructions for the delegate. Do NOT use placeholders like "will be filled later." If you need to read files first, do that in a separate plan iteration before delegating.`,
            success: false,
          });
          recordStep(envelope, taskStepKey, 'failed', 0, STEP_LEDGER_ENABLED);
          cpFailed = true;
          break;
        }

        // Create Task envelope with status='waiting'
        const taskId = generateId('w');
        const taskEnvelope = {
          id: taskId,
          type: 'T',
          parent_id: cpId,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'waiting',
          intent: 'delegation',
          title: taskDesc.substring(0, 100),
          instruction: taskDesc,
          accept_criteria: taskCriteria,
          context_summary: [...allResults, ...cpResults].length > 0
            ? [...allResults, ...cpResults].map(r =>
                `[CP${r.step}] ${r.agent}: ${r.success ? 'OK' : 'FAIL'} — ${(r.result || '').substring(0, 300)}`
              ).join('\n')
            : null,
          output: null,
          children: [],
          context_forward: null,
          error: null,
          source_channel: 'brain',
          source_meta: {
            dispatched_by: cpId,
            checkpoint: cpNum,
            task_step: taskNum,
            step_type: 'delegation',
            delegated_to: delegateSpecialty,
            target_agent_email: targetAgentEmail,
          },
          project_id: envelope.project_id || null,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          completed_at: null,
          updated_at: new Date().toISOString(),
          iteration: 0,
        };

        await firestoreWrite('work', taskId, taskEnvelope);
        await writeHistory(taskId, null, 'waiting', 'brain', `Delegating to ${delegateSpecialty} (${targetAgentEmail})`);

        cpEnvelope.children.push(taskId);
        cpEnvelope.updated_at = new Date().toISOString();
        await firestoreWrite('work', cpId, cpEnvelope);

        // Publish local work artifacts so the delegate can access them
        if (envelope.project_id && publishArtifacts) {
          try {
            const artifacts = await publishArtifacts(envelope, { dryRun: false });
            if (artifacts?.length > 0) {
              log('INFO', `[delegation] Published ${artifacts.length} artifact(s) to Drive before delegating`);
              // Append artifact references to the delegation instruction
              const artifactRefs = artifacts.map(a => `📄 ${a.name}: ${a.driveUrl || a.id}`).join('\n');
              taskDesc += `\n\n[SHARED ARTIFACTS — available in the project Drive folder]\n${artifactRefs}\nThese files are available in the project's shared Drive folder.`;
            }
          } catch (e) {
            log('WARN', `[delegation] Artifact publish before delegation failed: ${e.message}`);
          }
        }

        // Compose delegation marker for Mouth delivery
        // Resolve project Drive folder for delegate context
        const projCtx = (PROJECTS[envelope.project_id] || {}).context || {};
        const driveFolderId = (PROJECTS[envelope.project_id] || {}).drive_folder_id
          || projCtx.drive_folder?.ref || null;
        // Enrich delegation body with prior checkpoint results
        const priorCtx = [...allResults, ...cpResults]
          .filter(r => r.success)
          .map(r => `[Prior work — ${r.agent}]: ${(r.result || '').substring(0, 500)}`)
          .join('\n\n');
        const enrichedBody = priorCtx
          ? `${taskDesc}\n\n--- Prior checkpoint results ---\n${priorCtx}\n--- End prior results ---`
          : taskDesc;

        const marker = composeDelegationMarker({
          targetEmail: targetAgentEmail,
          ref: taskId,
          from: AGENT_EMAIL || AGENT_ID,
          project: envelope.project_id || 'none',
          drive: driveFolderId,
          body: enrichedBody,
        });

        const delegOutputId = generateId('w');
        await firestoreWrite('work', delegOutputId, {
          id: delegOutputId,
          type: 'T',
          parent_id: taskId,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'complete',
          intent: 'delegation_send',
          title: `Delegation to ${delegateSpecialty}`,
          instruction: taskDesc,
          output: marker,
          delivery_status: 'pending',
          delivery_target: targetAgentEmail,
          delivery_address: makeAddress('gchat', {
            space: (envelope.project_id && PROJECTS[envelope.project_id]?.gchat_space_id)
              ? `spaces/${PROJECTS[envelope.project_id].gchat_space_id}`
              : null,
          }),
          source_channel: 'brain',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: delegation sent to ${targetAgentEmail}`);

        // Track that this checkpoint has delegations — don't return yet,
        // continue processing remaining tasks so parallel delegations fan out
        delegationDispatched = true;
        continue;  // Process next task in this checkpoint
        }  // end else (not self-delegation)
      }

      // ---- Standard Task execution ----
      if (!isPreStamped) {
        tId = generateId('w');
        tEnv = {
          id: tId,
          type: 'T',
          parent_id: cpId,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'active',
          intent: task.intent || 'execute',
          title: taskDesc.substring(0, 100),
          instruction: taskDesc,
          accept_criteria: taskCriteria,
          context_summary: [...allResults, ...cpResults].length > 0
            ? [...allResults, ...cpResults].map(r => `Step ${r.step} (${r.agent}): ${toStr(r.result).substring(0, 300)}`).join('\n')
            : null,
          output: null,
          children: [],
          context_forward: null,
          error: null,
          source_channel: 'brain',
          source_meta: { dispatched_by: cpId, checkpoint: cpNum, task_step: taskNum, step_type: stepType },
          project_id: envelope.project_id || null,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          completed_at: null,
          updated_at: new Date().toISOString(),
          iteration: 0,
        };
        await firestoreWrite('work', tId, tEnv);
        await writeHistory(tId, null, 'active', 'brain', `CP${cpNum} Task ${taskNum}: ${taskAgent}`);

        cpEnvelope.children.push(tId);
        cpEnvelope.updated_at = new Date().toISOString();
        await firestoreWrite('work', cpId, cpEnvelope);
      } else {
        tEnv.status = 'active';
        tEnv.started_at = new Date().toISOString();
        tEnv.updated_at = new Date().toISOString();
        await firestoreWrite('work', tEnv.id, tEnv);
        await writeHistory(tEnv.id, 'pending', 'active', 'brain', `Dispatching to ${taskAgent}`);
      }

      log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}/${cpTasks.length}: ${taskAgent} — ${taskDesc.substring(0, 60)}`);

      // Prepend project context
      let currentInstruction = tEnv.instruction || '';
      const dispatchProjCtx = envelope.project_id && buildProjectContext
        ? (buildProjectContext(envelope.project_id, envelope.context) || null)
        : null;
      if (dispatchProjCtx) {
        currentInstruction = `[PROJECT CONTEXT]\n${dispatchProjCtx}\n[END PROJECT CONTEXT]\n\n${currentInstruction}`;
      }

      // Add skill catalog prefix
      const currentSkillCatalog = (taskAgent === 'motor' || taskAgent === 'temporal-research')
        ? skillIndex : '';

      const priorContext = [...allResults, ...cpResults].length > 0
        ? [...allResults, ...cpResults].map(r => `Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n\n')
        : undefined;

      const dispatchPayload = {
        instruction: currentInstruction + currentSkillCatalog,
        accept_criteria: taskCriteria,
        _missionId: envelope.id,
        _projectContext: dispatchProjCtx,
        _sourceText: envelope.source_text || null,
        _sourceMeta: envelope.source_meta || null,
        context_summary: [...allResults, ...cpResults].length > 0
          ? [...allResults, ...cpResults].map(r => `Step ${r.step} (${r.agent}): ${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n')
          : undefined,
        prior_results_context: priorContext,
        memory_context: envelope.memory_context || null,
      };

      if (!VALID_TASK_AGENTS.has(taskAgent)) {
        const msg = `Invalid task agent "${taskAgent}" — must be one of: ${[...VALID_TASK_AGENTS].join(', ')}`;
        log('WARN', `[checkpoint-executor] ${msg}`);
        cpResults.push({
          step: `${cpNum}.${taskNum}`,
          agent: taskAgent,
          task: taskDesc.substring(0, 200),
          result: msg,
          success: false,
          durationMs: 0,
        });
        if (!isOptional) {
          cpFailed = true;
          break;
        }
        continue;
      }

      let result = await dispatchAgent(taskAgent, dispatchPayload);

      // Motor failure check
      if (taskAgent === 'motor') {
        const motorCheck = detectMotorFailure(result.output || result.error || '');
        if (motorCheck.failed) {
          result.success = false;
          result.error = motorCheck.detail;
        }
      }

      // Retry once on failure (for non-optional tasks)
      if (!result.success && !isOptional) {
        log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum} failed (${taskAgent}): ${result.error}. Retrying...`);
        result = await dispatchAgent(taskAgent, {
          ...dispatchPayload,
          instruction: `${currentInstruction}${currentSkillCatalog}\n\n[RETRY] Previous attempt failed: ${result.error}. Try again with adjusted approach.`,
          prior_results_context: [
            priorContext,
            `[PREVIOUS ATTEMPT FAILED] ${result.error}\nOutput: ${smartTruncate(result.output || '', 500)}`,
          ].filter(Boolean).join('\n\n'),
        });

        if (taskAgent === 'motor') {
          const motorCheck = detectMotorFailure(result.output || result.error || '');
          if (motorCheck.failed) {
            result.success = false;
            result.error = motorCheck.detail;
          }
        }
      }

      // Telemetry / Evidence floor
      if (result.success && taskAgent === 'motor') {
        const rText = toStr(result.output) || result.text || '';
        const toolLog = rText.match(/\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/)?.[1] || '';
        const toolCount = (toolLog.match(/\[TOOL\]/g) || []).length;
        const hasWrites = /writeFile|drive-upload|drive-mkdir|git commit/i.test(toolLog);
        const hasErrors = /ERROR:|No such file|command not found|Permission denied/i.test(toolLog);
        const durationMs = result.durationMs || 0;

        const EVIDENCE_FLOOR_EXCLUDE = contracts.dispatch?.evidence_floor_exclude_skills
          || ['fleet-fire', 'fleet-hire', 'fleet-upgrade', 'fleet-verify', 'fleet-status', 'fleet-deploy'];
        const isFleetLifecycle = EVIDENCE_FLOOR_EXCLUDE.some(s => taskDesc.toLowerCase().includes(s));

        if (durationMs < 8000 && toolCount <= 2 && !hasWrites && !isFleetLifecycle) {
          log('WARN', `[checkpoint-executor] Evidence floor: motor CP${cpNum} T${taskNum} completed in ${durationMs}ms with ${toolCount} tools, no writes — flagging`);
          result.output = (result.output || '') + '\n[EVIDENCE WARNING: Task completed very quickly with minimal tool usage and no write operations. Verify that meaningful work was performed.]';
        }
        if (hasErrors && !/\[WARNING: One or more tool calls returned errors/.test(rText)) {
          log('WARN', `[checkpoint-executor] Evidence floor: motor CP${cpNum} T${taskNum} reported SUCCESS but tool log contains errors`);
          result.output = (result.output || '') + '\n[EVIDENCE WARNING: Tool execution log contains errors despite SUCCESS status.]';
        }
      }

      // Cerebellum verification
      if (result.success && taskCriteria && taskAgent !== 'cerebellum' && tEnv.intent !== 'ack' && extractVerdict) {
        try {
          log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: dispatching to cerebellum for verification`);
          const verification = await dispatchAgent('cerebellum', {
            instruction: [
              'Verify the following task output meets the acceptance criteria.',
              'Read the verification SKILL.md before rendering your verdict.',
              '',
              '## Accept Criteria',
              taskCriteria,
              '',
              '## Task Output',
              result.output || '(empty)',
            ].join('\n'),
            _missionId: envelope.id,
          });

          const verdict = extractVerdict(verification.output);

          if (verdict === 'FAIL') {
            const failSummary = extractFailSummary ? extractFailSummary(verification.output) : 'Acceptance criteria not met';
            const recommendation = extractFailRecommendation ? extractFailRecommendation(verification.output) : '';
            log('WARN', `[checkpoint-executor] Cerebellum FAIL on CP${cpNum} Task ${taskNum}: ${failSummary}`);

            log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: retrying ${taskAgent} with cerebellum feedback`);
            result = await dispatchAgent(taskAgent, {
              ...dispatchPayload,
              instruction: [
                currentInstruction + currentSkillCatalog,
                '',
                '[VERIFICATION FAILED] An independent verification found issues with your previous output:',
                failSummary,
                recommendation ? `\nRecommendation: ${recommendation}` : '',
                '\nPlease re-execute and address the issues above. Use tools to actually run commands — do NOT simulate or assume results.',
              ].join('\n'),
            });

            if (taskAgent === 'motor') {
              const motorCheck = detectMotorFailure(result.output || result.error || '');
              if (motorCheck.failed) {
                result.success = false;
                result.error = motorCheck.detail;
              }
            }

            if (result.success) {
              log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: re-verifying retry output with cerebellum`);
              const reVerification = await dispatchAgent('cerebellum', {
                instruction: [
                  'Verify the following RETRY task output meets the acceptance criteria.',
                  'This is a second attempt after the first failed verification.',
                  'Read the verification SKILL.md before rendering your verdict.',
                  '',
                  '## Accept Criteria',
                  taskCriteria,
                  '',
                  '## Task Output (Retry)',
                  result.output || '(empty)',
                ].join('\n'),
                _missionId: envelope.id,
              });

              const reVerdict = extractVerdict(reVerification.output);
              if (reVerdict === 'FAIL') {
                const reFailSummary = extractFailSummary ? extractFailSummary(reVerification.output) : 'Acceptance criteria not met on retry';
                log('WARN', `[checkpoint-executor] Cerebellum FAIL on retry CP${cpNum} Task ${taskNum}: ${reFailSummary}`);
                result.success = false;
                result.error = `Verification failed after retry: ${reFailSummary}`;
              } else if (reVerdict === 'PASS') {
                log('INFO', `[checkpoint-executor] Cerebellum PASS on retry CP${cpNum} Task ${taskNum}`);
              }
            }
          } else if (verdict === 'PASS') {
            log('INFO', `[checkpoint-executor] Cerebellum PASS on CP${cpNum} Task ${taskNum}`);
          } else {
            log('WARN', `[checkpoint-executor] Cerebellum did not render verdict tool for CP${cpNum} Task ${taskNum} — flagging for review`);
            tEnv.needs_review = true;
            tEnv.review_reason = 'Cerebellum did not render verdict via tool call';
          }
        } catch (verErr) {
          log('WARN', `[checkpoint-executor] Cerebellum verification failed: ${verErr.message}`);
        }
      }

      // Update task envelope
      tEnv.output = result.output || result.error;
      tEnv.status = result.success ? 'complete' : 'failed';
      tEnv.error = result.error;
      tEnv.completed_at = new Date().toISOString();
      tEnv.updated_at = new Date().toISOString();
      await firestoreWrite('work', tId, tEnv);
      await writeHistory(tId, 'active', tEnv.status, taskAgent,
        result.success ? `Completed (${result.durationMs}ms)` : `Failed: ${result.error}`);

      // Save output file in shared/
      if (result.success && result.output && result.output.length > 200) {
        try {
          const taskTitle = tEnv.title || `task-${cpNum}-${taskNum}`;
          const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
          const { writeFileSync: wfs } = await import('fs');
          wfs(`${CORE_DIR}/shared/${envelope.id}/${slug}.md`, result.output);
        } catch (e) { /* ignore */ }
      }

      const stepResult = {
        step: `${cpNum}.${taskNum}`,
        agent: taskAgent,
        task: taskDesc.substring(0, 200),
        result: result.success
          ? smartTruncate(result.output || '', CTX_AGENT_STEP)
          : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', CTX_DISPATCH_FAILURE)}`,
        success: result.success,
        durationMs: result.durationMs,
      };
      cpResults.push(stepResult);

      // Record step in ledger
      await recordStep(envelope, taskStepKey, { success: result.success, error: result.error, durationMs: result.durationMs }, STEP_LEDGER_ENABLED, firestoreWrite);

      // Persist checkpoint progress
      if (CHECKPOINT_RESUME_ENABLED && !isPreStamped) {
        envelope._cp_progress = {
          checkpointIndex: ci,
          taskIndex: ti + 1,
          allResults: [...allResults, ...cpResults],
          checkpoints,
        };
        await firestoreWrite('work', envelope.id, envelope);
      }

      if (!result.success) {
        cpFailed = true;
        break;
      }
    }

    // After processing all tasks, if any delegations were dispatched,
    // pause the checkpoint and wait for delegates to complete
    if (delegationDispatched) {
      cpEnvelope.status = 'waiting';
      cpEnvelope.updated_at = new Date().toISOString();
      await firestoreWrite('work', cpId, cpEnvelope);
      await writeHistory(cpId, 'active', 'waiting', 'brain',
        `Waiting for ${cpEnvelope.children.length} delegation(s) to complete`);
      log('INFO', `[checkpoint-executor] CP${cpNum}: ${cpEnvelope.children.length} delegation(s) dispatched, checkpoint waiting`);
      return { paused: true, waitingOnDelegation: true };
    }

    // Mark checkpoint complete or failed
    cpEnvelope.status = cpFailed ? 'failed' : 'complete';
    cpEnvelope.output = cpFailed ? `Checkpoint failed at task ${cpResults.length}/${cpTasks.length}` : `Checkpoint complete: ${cpResults.length} tasks`;
    cpEnvelope.completed_at = new Date().toISOString();
    cpEnvelope.updated_at = new Date().toISOString();
    await firestoreWrite('work', cpId, cpEnvelope);
    await writeHistory(cpId, 'active', cpEnvelope.status, 'brain',
      cpFailed ? `Failed at task ${cpResults.length}` : `Complete (${cpResults.length} tasks)`);

    allResults.push(...cpResults);

    if (cpFailed) {
      planFailed = true;
      break;
    }
  }

  // Clear progress
  if (CHECKPOINT_RESUME_ENABLED && !isPreStamped) {
    envelope._cp_progress = null;
    await firestoreWrite('work', envelope.id, envelope);
  }

  return { success: !planFailed, results: allResults };
}
