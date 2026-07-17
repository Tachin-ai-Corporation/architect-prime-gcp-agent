// checkpoint-executor.mjs — Shared checkpoint execution engine
// Phase 2.5: Convergence of checkpoint execution paths
//
// Shared walk-checkpoints-dispatch-verify-retry pattern used by
// both agent-brain.mjs (checkpoint_plan handler) and process-engine.mjs (runProcessPlan).

import { toStr } from './to-str.mjs';
import { smartTruncate } from './vertex-text.mjs';
import { buildPriorWorkContext, renderCheckpointDigest } from './compaction.mjs';
import { makeAddress } from './channel.mjs';
import { composeDelegationMarker, normalizeTargetEmail } from './delegation.mjs';
import { extractVerdict, extractFailSummary, extractFailRecommendation, extractProbes, stakesAtLeast } from './verdict.mjs';
import { detectMotorFailure } from './agent-output.mjs';
import { createHash } from 'crypto';
import { allocateVersion } from './git-store.mjs';

const VALID_TASK_AGENTS = new Set(['motor', 'temporal-research', 'temporal-memory']);

function deriveStepKey(envId, cpNum, action, target = '', iteration = '') {
  const hash = createHash('sha256');
  const part = iteration ? `:${iteration}` : '';
  hash.update(`${envId}:${cpNum}:${action}:${target}${part}`);
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
    CTX_VERIFY_INPUT = 24000,
    startCpIndex = 0,
    startTaskIndex = 0,
    savedResults = [],
    buildProjectContext,
    publishArtifacts,
    gitCommitAndSync,
    delegationEnabled = true,
  } = opts;

  const _requiredDeps = { dispatchAgent, envelope, firestoreWrite, writeHistory, log, generateId, buildProjectContext };
  for (const [name, val] of Object.entries(_requiredDeps)) {
    if (val === undefined) {
      throw new Error(`[checkpoint-executor] Missing required dependency: "${name}". Check the opts passed to executeCheckpoints().`);
    }
  }

  const STEP_LEDGER_ENABLED = contracts.dispatch?.step_ledger_enabled !== false;
  const CHECKPOINT_RESUME_ENABLED = contracts.dispatch?.checkpoint_resume_enabled !== false;
  const PROBE_ENABLED = contracts.dispatch?.verify_probe_enabled !== false;
  const PROBE_MAX = contracts.dispatch?.verify_probe_max ?? 2;
  const PROBE_STAKES_MIN = contracts.dispatch?.verify_probe_stakes_min || 'consequential';
  const ATTACK_STAKES_MIN = contracts.dispatch?.attack_duty_stakes_min || 'consequential';
  const missionStakes = envelope.stakes || 'routine';

  let allResults = savedResults || [];
  let planFailed = false;
  let delegationCount = 0;
  const maxDelegations = contracts?.dispatch?.max_delegations_per_checkpoint || 4;
  const contextSliceChars = contracts?.dispatch?.context_slice_chars || 500;

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
      const taskStepKey = deriveStepKey(envelope.id, cpNum, 'cp_task', `${ci}.${ti}.${taskAgent}`, envelope.iteration);
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
            const approvalUrl = `${FIRESTORE_BASE}/approvals/${approvalId}`;
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
                prime_id: { stringValue: PRIME_ID },
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

        // Delegation is fleet-only (skill.json roles) and project-scoped.
        // Agents without the skill (Primes) never enter the delegation path.
        if (!delegationEnabled) {
          log('ERROR', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: delegation not available to this agent — failing task`);
          cpResults.push({
            step: `${cpNum}.${taskNum}`, agent: taskAgent,
            result: `[FAILED] Delegation is not available to this agent. Primes never delegate — operate the fleet directly (SSH via system-shell, work-log tools, fleet-verify/fleet-upgrade) or re-plan the work as local motor tasks.`,
            success: false,
          });
          if (!isOptional) { cpFailed = true; break; }
          continue;
        }

        log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: Cross-agent delegation to '${delegateSpecialty}'`);

        // Direct email from cortex/prefrontal output takes priority, but must be validated
        let targetAgentEmail = task.target_email || null;
        if (targetAgentEmail) {
          // Strip @mention prefixes / trailing punctuation before registry lookup
          const norm = normalizeTargetEmail(targetAgentEmail);
          targetAgentEmail = norm.valid ? norm.email : targetAgentEmail;
        }

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
              // Normalize (→ lowercase) so the stored target_agent_email matches the
              // reconciler's lowercased EQUAL query (agent-brain reconcileIncomingDelegations
              // force-lowercases self-email; Firestore EQUAL is case-sensitive). Audit LOW
              // fix — the specialty-resolution path was the only producer storing verbatim.
              const norm = normalizeTargetEmail(onlineAgent.email);
              targetAgentEmail = norm.valid ? norm.email : (onlineAgent.email || '').toLowerCase();
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

        // ---- Guard: deliverable route ----
        // Delegations deliver through the shared project GChat space. Without
        // one, the mouth drops the address and the message never reaches the
        // delegate — fail fast instead of creating an undeliverable waiting T.
        const delegSpaceId = (envelope.project_id && PROJECTS[envelope.project_id]?.gchat_space_id) || null;
        if (!delegSpaceId) {
          const spacedProjects = Object.values(PROJECTS)
            .filter(p => p && p.gchat_space_id && p.status !== 'archived')
            .map(p => `"${p.id}"`).join(', ');
          log('ERROR', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: project "${envelope.project_id || 'none'}" has no GChat space — delegation undeliverable`);
          cpResults.push({
            step: `${cpNum}.${taskNum}`, agent: taskAgent,
            result: `[FAILED] Delegation to ${targetAgentEmail} is undeliverable: project "${envelope.project_id || 'none'}" has no GChat space. ${spacedProjects ? `Re-plan under a project with a space: ${spacedProjects}.` : 'No project has a GChat space — escalate with needs_input.'}`,
            success: false,
          });
          if (!isOptional) { cpFailed = true; break; }
          continue;
        }

        // Create Task envelope with status='waiting'
        const taskId = generateId('w');
        const delegOutputId = generateId('w');
        const taskTitle = taskDesc.substring(0, 100); // clean title, before artifact refs are appended

        // B-2/C-27: publish artifacts + compose the ENRICHED body BEFORE the single
        // write of the durable T. The reconciler (the sole pickup now that the ears
        // suppress the ping) reads t.instruction, so it must be enriched from the
        // first write. Writing the T EXACTLY ONCE (a) avoids a race where a reconciler
        // poll landing in a two-write window materializes from a stale raw instruction
        // (the delegation_ref dedup would then block the correction — a lost-context,
        // non-deterministic outcome), and (b) avoids a second full-object write
        // clobbering the reconciler's cross-agent child registration on this same T
        // (which would re-open the delivery-fast-fail stranding).
        if (envelope.project_id && publishArtifacts) {
          try {
            const artifacts = await publishArtifacts(envelope, { dryRun: false });
            if (artifacts?.length > 0) {
              log('INFO', `[delegation] Published ${artifacts.length} artifact(s) to Drive before delegating`);
              const artifactRefs = artifacts.map(a => `📄 ${a.name}: ${a.driveUrl || a.id}`).join('\n');
              taskDesc += `\n\n[SHARED ARTIFACTS — available in the project Drive folder]\n${artifactRefs}\nThese files are available in the project's shared Drive folder.`;
            }
          } catch (e) {
            log('WARN', `[delegation] Artifact publish before delegation failed: ${e.message}`);
          }
        }
        const priorCtx = [...allResults, ...cpResults]
          .filter(r => r.success)
          .map(r => `[Prior work — ${r.agent}]: ${smartTruncate(r.result || '', contextSliceChars)}`)
          .join('\n\n');
        const enrichedBody = priorCtx
          ? `${taskDesc}\n\n--- Prior checkpoint results ---\n${priorCtx}\n--- End prior results ---`
          : taskDesc;

        const taskEnvelope = {
          id: taskId,
          type: 'T',
          parent_id: cpId,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'waiting',
          intent: 'delegation',
          title: taskTitle,
          instruction: enrichedBody,
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
            delivery_envelope_id: delegOutputId,
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

        // B-2 (C-27): conversational prose ping — the mouth voices enrichedBody and
        // appends the correlation tag; delegation_ref routes it to the voiced path.
        await firestoreWrite('work', delegOutputId, {
          id: delegOutputId,
          type: 'T',
          parent_id: taskId,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'complete',
          intent: 'delegation_send',
          title: `Delegation to ${delegateSpecialty}`,
          instruction: enrichedBody,
          output: enrichedBody,
          delegation_ref: taskId,
          delivery_status: 'pending',
          delivery_target: targetAgentEmail,
          delivery_address: makeAddress('gchat', { space: delegSpaceId }),
          source_channel: 'brain',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: delegation sent to ${targetAgentEmail}`);

        // Persist checkpoint progress so we don't re-delegate on resume
        if (CHECKPOINT_RESUME_ENABLED && !isPreStamped) {
          envelope._cp_progress = {
            checkpointIndex: ci,
            taskIndex: ti + 1,
            allResults: [...allResults, ...cpResults],
            checkpoints,
          };
          await firestoreWrite('work', envelope.id, envelope);
        }

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

      // SESSION_CONTEXT_PLAN Phase 1: prior work is sent ONCE — completed
      // checkpoints as deterministic digests, the current checkpoint verbatim.
      // Previously context_summary AND prior_results_context both carried the
      // full transcript at CTX_AGENT_STEP chars/step (quadratic growth, ×2).
      const priorContext = buildPriorWorkContext({
        checkpoints,
        allResults,
        cpResults,
        currentCpNum: cpNum,
        missionId: envelope.id,
        stepChars: CTX_AGENT_STEP,
        digestChars: contracts?.compaction?.checkpoint_digest_chars || 4000,
      });

      const dispatchPayload = {
        instruction: currentInstruction + currentSkillCatalog,
        accept_criteria: taskCriteria,
        _missionId: envelope.id,
        _projectContext: dispatchProjCtx,
        _sourceText: envelope.source_text || null,
        _sourceMeta: envelope.source_meta || null,
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

      // #4B: token-limit truncation ('length') — the reply was cut mid-stream, usually
      // because the agent pasted a huge blob (raw logs, full JSON, a file dump) instead of
      // writing to a file. Flag it retryable so the single retry below fires with a
      // file-then-summarize nudge, turning a truncated dump into a bounded result.
      // Deterministic detection of a deterministic gateway signal (B-1/B-3).
      let truncatedNudge = '';
      if (result.finishReason === 'length') {
        result.success = false;
        result.error = `${result.error ? result.error + ' ' : ''}[OUTPUT TRUNCATED AT TOKEN LIMIT]`;
        truncatedNudge = '\n\n[TRUNCATION] Your previous reply hit the token limit. Do NOT paste large content (logs, full file contents, big JSON) into your response — write it to a file in your workspace and return only a concise summary plus the file path.';
      }

      // Retry once on failure (for non-optional tasks)
      if (!result.success && !isOptional) {
        log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum} failed (${taskAgent}): ${result.error}. Retrying...`);
        result = await dispatchAgent(taskAgent, {
          ...dispatchPayload,
          instruction: `${currentInstruction}${currentSkillCatalog}\n\n[RETRY] Previous attempt failed: ${result.error}. Try again with adjusted approach.${truncatedNudge}`,
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
          // B-28/B-29: load-bearing Brief parts get probes + attacks regardless of mission stakes
          const taskPart = (envelope._brief?.parts || []).find(p => p.id === task.brief_part);
          const isLoadBearing = !!taskPart?.load_bearing;

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
              // B-28/B-4: bound the verifier's input so a ballooned motor output can't
              // blow the cerebellum context (→ dispatch error → null verdict → verification
              // silently skipped). smartTruncate keeps head+tail so setup + errors survive.
              smartTruncate(result.output || '(empty)', CTX_VERIFY_INPUT),
              // Attack Duty block (stakes-gated, or load-bearing Brief part)
              ...((stakesAtLeast(missionStakes, ATTACK_STAKES_MIN) || isLoadBearing) ? [
                '',
                '## Attack Duty (stakes: ' + missionStakes + (isLoadBearing ? ', load-bearing part' : '') + ')',
                'Before any PASS, run three attacks and record them in your checks:',
                '1. Strongest domain-expert objection',
                '2. Flip test — invert the softest input; does the conclusion survive?',
                '3. Boundary probe — find where the claim stops being true; confirm this case is inside.',
                'A winning attack is a FAIL with the attack as the recommendation.',
              ] : []),
              // Probe eligibility hint
              ...(PROBE_ENABLED && (stakesAtLeast(missionStakes, PROBE_STAKES_MIN) || isLoadBearing) ? [
                '',
                '## Probe Eligibility',
                'This mission\'s stakes (' + missionStakes + ') qualify for verification probes.',
                'For any load-bearing claim you cannot verify from the evidence provided,',
                'use `request_probe` instead of guessing. Max ' + PROBE_MAX + ' probes per round.',
              ] : []),
            ].filter(Boolean).join('\n'),
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
                  // B-28/B-4: bound the verifier's input so a ballooned motor output can't
              // blow the cerebellum context (→ dispatch error → null verdict → verification
              // silently skipped). smartTruncate keeps head+tail so setup + errors survive.
              smartTruncate(result.output || '(empty)', CTX_VERIFY_INPUT),
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
          } else if (verdict === 'PROBE' && PROBE_ENABLED) {
            // PROBE verdict — dispatch fresh motor probes, then re-verdict
            const probes = extractProbes(verification.output);
            if (probes.length === 0) {
              log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: PROBE verdict but no parseable probes — failing closed (B-28)`);
              tEnv.needs_review = true;
              tEnv.review_reason = 'Cerebellum requested probes but no parseable probes found';
              result.success = false;
              result.error = 'Verification incomplete: cerebellum requested re-derivation probes that could not be parsed. The claim remains unverified (B-28 fail-closed).';
            } else {
              log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: running ${probes.length} verification probe(s)`);
              const probeResults = [];
              for (const probe of probes.slice(0, PROBE_MAX)) {
                try {
                  const probeResult = await dispatchAgent('motor', {
                    instruction: [
                      '[VERIFICATION PROBE]',
                      '',
                      '## Claim to verify',
                      probe.claim,
                      '',
                      '## Method',
                      probe.instruction,
                      '',
                      'Re-derive this claim from ground truth using ONLY the method above.',
                      'Report whether the claim is verified or contradicted, with the evidence.',
                    ].join('\n'),
                    _missionId: envelope.id,
                    _probe: true,
                  });
                  probeResults.push({ claim: probe.claim, output: probeResult.output || probeResult.error || '(no output)' });
                } catch (probeErr) {
                  probeResults.push({ claim: probe.claim, output: `Probe error: ${probeErr.message}` });
                }
              }

              // Re-dispatch cerebellum with original + probe evidence for final verdict
              log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: re-dispatching cerebellum with probe results for final verdict`);
              const probeEvidence = probeResults.map((p, i) => [
                `### Probe ${i + 1}: ${p.claim}`,
                p.output,
              ].join('\n')).join('\n\n');

              try {
                const finalVerification = await dispatchAgent('cerebellum', {
                  instruction: [
                    'Final verdict round. The original task output AND independent probe results are below.',
                    'Render exactly one terminal verdict (report_pass or report_fail). Do NOT request further probes.',
                    'Read the verification SKILL.md before rendering your verdict.',
                    '',
                    '## Accept Criteria',
                    taskCriteria,
                    '',
                    '## Original Task Output',
                    // B-28/B-4: bound the verifier's input so a ballooned motor output can't
              // blow the cerebellum context (→ dispatch error → null verdict → verification
              // silently skipped). smartTruncate keeps head+tail so setup + errors survive.
              smartTruncate(result.output || '(empty)', CTX_VERIFY_INPUT),
                    '',
                    '## Verification Probe Results',
                    probeEvidence,
                  ].join('\n'),
                  _missionId: envelope.id,
                });

                const finalVerdict = extractVerdict(finalVerification.output);
                if (finalVerdict === 'FAIL') {
                  const failSummary = extractFailSummary ? extractFailSummary(finalVerification.output) : 'Probe-informed verification failed';
                  log('WARN', `[checkpoint-executor] Cerebellum FAIL (post-probe) CP${cpNum} Task ${taskNum}: ${failSummary}`);
                  result.success = false;
                  result.error = `Verification failed after probes: ${failSummary}`;
                } else if (finalVerdict === 'PASS') {
                  log('INFO', `[checkpoint-executor] Cerebellum PASS (post-probe) CP${cpNum} Task ${taskNum}`);
                } else if (finalVerdict === 'PROBE') {
                  log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: second PROBE request — probe budget exhausted, treating as FAIL`);
                  result.success = false;
                  result.error = 'Verification probe budget exhausted — cerebellum requested further probes after probe round';
                } else {
                  log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: post-probe verdict not rendered — flagging for review`);
                  tEnv.needs_review = true;
                  tEnv.review_reason = 'Cerebellum did not render verdict after probe round';
                }
              } catch (finalErr) {
                log('WARN', `[checkpoint-executor] Post-probe cerebellum dispatch failed: ${finalErr.message}`);
                tEnv.needs_review = true;
                tEnv.review_reason = `Post-probe verification error: ${finalErr.message}`;
              }
            }
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
    // SESSION_CONTEXT_PLAN Phase 1: persist the deterministic digest for
    // observability. Dispatch context recomputes it purely from results, so
    // this field is never load-bearing (B-22). Dedicated field — never
    // context_forward, which is the live resume/human-injection surface.
    cpEnvelope._cp_digest = renderCheckpointDigest({
      cpNum,
      instruction: cpEnvelope.instruction || '',
      acceptCriteria: cpEnvelope.accept_criteria || '',
      results: cpResults,
      missionId: envelope.id,
      capChars: contracts?.compaction?.checkpoint_digest_chars || 4000,
    });
    cpEnvelope.completed_at = new Date().toISOString();
    cpEnvelope.updated_at = new Date().toISOString();
    await firestoreWrite('work', cpId, cpEnvelope);
    await writeHistory(cpId, 'active', cpEnvelope.status, 'brain',
      cpFailed ? `Failed at task ${cpResults.length}` : `Complete (${cpResults.length} tasks)`);

    allResults.push(...cpResults);

    // Git substrate: commit+push after each successful checkpoint
    if (!cpFailed && gitCommitAndSync && envelope.project_id) {
      try {
        const d = new Date();
        const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '.');
        const sharedDir = `${CORE_DIR}/shared/${envelope.id}`;
        // Allocate daily version index once per mission, cache on envelope context
        if (!envelope.context?.git_version_index) {
          envelope.context = envelope.context || {};
          envelope.context.git_version_index = allocateVersion?.(sharedDir, 'main', d) || 1;
        }
        const i = envelope.context.git_version_index;
        const cpTitle = (cpEnvelope.title || `checkpoint-${cpNum}`).slice(0, 60);
        const msg = `v${dateStr}.${i}.${cpNum}: ${cpTitle}`;
        // Track checkpoint count for publish() version continuation
        envelope.context.git_checkpoint_count = cpNum;
        const syncResult = await gitCommitAndSync(envelope.id, envelope.project_id, msg);
        if (syncResult.committed) {
          log('INFO', `[checkpoint-executor] CP${cpNum}: git committed ${syncResult.sha?.slice(0, 8)} (synced=${syncResult.synced})`);
        }
      } catch (e) {
        log('WARN', `[checkpoint-executor] CP${cpNum}: git commit+sync failed (non-fatal): ${e.message}`);
      }
    }

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
