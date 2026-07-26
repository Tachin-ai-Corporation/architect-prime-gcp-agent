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
import { allocateVersion, sanitizeRepoId } from './git-store.mjs';
import { buildResultPacket } from './result-packet.mjs';

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
    // ORGAN_CONTEXT_SHARING_PLAN Phase 2: untruncated per-task outputs, kept in-memory only
    // (never persisted — Firestore 1MiB), so cerebellum verifies from full evidence (B-28).
    const cpFullOutputs = [];
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
        taskCriteria = tEnv.accept_criteria
          || `The task's stated outcome is achieved: "${toStr(tEnv.instruction || '').substring(0, 200)}". Concrete tool evidence shows the outcome was produced (not simulated), with no unresolved errors.`;
      } else {
        taskAgent = task.agent;
        taskDesc = toStr(task.task || task.instruction || '');
        taskCriteria = task.accept_criteria
          || `The task's stated outcome is achieved: "${toStr(task.task || task.brief_part || '').substring(0, 200)}". Concrete tool evidence shows the outcome was produced (not simulated), with no unresolved errors.`;
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
        // #3-reality (C-24 — git is the artifact substrate): hand the delegate a
        // RETRIEVABLE pointer to the delegator's in-flight work. Per-checkpoint work is
        // committed to THIS mission's git branch (mission/<id>) and only merged to main
        // on completion — and a gated merge policy parks even that — so a delegate that
        // clones `main` can be missing its input files. Calling publishArtifacts commits
        // (and, policy permitting, merges) the current work; either way we give the
        // delegate the exact branch ref so it can fetch the inputs deterministically from
        // the git store, independent of merge policy. (The prior `artifacts?.length > 0`
        // guard was DEAD: publishArtifacts returns a manifest OBJECT, not an array, so the
        // pointer block never appended.)
        if (envelope.project_id) {
          try {
            let manifest = null;
            if (publishArtifacts) manifest = await publishArtifacts(envelope, { dryRun: false });
            const repoId = sanitizeRepoId(envelope.project_id);
            const missionBranch = `mission/${envelope.id}`;
            let pointer = `\n\n[INPUT FILES — from the delegator's git branch]\n`
              + `Files the delegator produced for this task are committed to branch \`${missionBranch}\` `
              + `of repo \`${repoId}\` in the shared git store (they may not yet be on \`main\`). `
              + `Before you depend on a named input file, retrieve them:\n`
              + `  work-clone ${repoId} --ref ${missionBranch} --dir delegator-inputs\n`
              + `then read from the \`delegator-inputs/\` directory. If a named file is absent there, it was not produced — do not loop; report what is missing.`;
            if (manifest && manifest.kind === 'artifact_manifest' && Array.isArray(manifest.files) && manifest.files.length) {
              const fileList = manifest.files.slice(0, 25)
                .map(f => `  - ${typeof f === 'string' ? f : (f.path || f.name || '')}`)
                .filter(s => s.trim().length > 3).join('\n');
              pointer += `\n\nPublished this checkpoint (${manifest.files.length} file(s)`
                + (manifest.commit ? `, commit ${String(manifest.commit).slice(0, 8)}` : '') + `):\n${fileList}`;
            }
            taskDesc += pointer;
            log('INFO', `[delegation] Attached git-branch input pointer (${missionBranch}) to delegated instruction`);
          } catch (e) {
            log('WARN', `[delegation] Artifact publish / input pointer before delegation failed: ${e.message}`);
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
        // Checkpoint tasks are execution work — grant tool access. The gateway's exec gate
        // only newly enables TOOL_ON_REQUEST organs (temporal-memory); motor is tool-enabled
        // by role regardless, and non-execution organs never receive tools. Without this,
        // temporal-memory ran toolless in checkpoints and could not run its memory CLIs.
        _exec: true,
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

      // A timeout is NOT a wrong-argument failure. The generic "investigate why it
      // failed" frame sends the organ hunting for a bug that isn't there, when the
      // real problem is batch size — and some of the work may already have landed,
      // so blind repetition duplicates it (the 2026-07-26 mission re-downloaded
      // every contract under a second name after a 300s abort).
      let timeoutNudge = '';
      if (/timed?\s?out/i.test(result.error || '')) {
        timeoutNudge = '\n\n[TIMEOUT] The previous attempt did not finish inside its time budget — treat its outcome as UNKNOWN, not failed. Work may already be partly done: re-check current state first (list the folder, check whether the output already exists) and skip what is already there. Then do the remainder in smaller batches — one file or id per command, never a loop over many.';
      }

      // Retry once on failure (for non-optional tasks)
      if (!result.success && !isOptional) {
        log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum} failed (${taskAgent}): ${result.error}. Retrying...`);
        result = await dispatchAgent(taskAgent, {
          ...dispatchPayload,
          instruction: `${currentInstruction}${currentSkillCatalog}\n\n[RETRY] Previous attempt failed: ${result.error}. Read the governing SKILL.md and use its documented commands. Investigate why it failed (wrong arguments? missing input? wrong target? unread doc?) and correct it — a failing command is something you resolve, not a dead end. Do not simulate results.${truncatedNudge}${timeoutNudge}`,
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

      // Task self-verification: the executing organ verifies its OWN task output
      // before reporting success (result.success is the organ's own judgment). Cerebellum
      // does NOT gate individual tasks — it verifies the CHECKPOINT milestone once, at the
      // checkpoint boundary (see checkpoint-level verification after the task loop). Canon:
      // 02-CHECKPOINT.md — "verification happens at checkpoint boundaries".

      // Update task envelope
      tEnv.output = result.output || result.error;
      tEnv.status = result.success ? 'complete' : 'failed';
      tEnv.error = result.error;
      tEnv.completed_at = new Date().toISOString();
      tEnv.updated_at = new Date().toISOString();
      await firestoreWrite('work', tId, tEnv);
      await writeHistory(tId, 'active', tEnv.status, taskAgent,
        result.success ? `Completed (${result.durationMs}ms)` : `Failed: ${result.error}`);

      // Save the step transcript under missions/<missionId>/steps/ — NOT the tree
      // root. These are process notes, not project artifacts, and the root is the
      // project repo: rooted notes get committed to main and then re-cloned into
      // every later mission's working tree, so a mission would open with ~20
      // unrelated task files (and a 100KB doc dump) from previous work sitting
      // beside its own. That is both noise and a real read-the-wrong-file hazard.
      // `missions/` is the existing convention for mission records (mission-record.mjs).
      if (result.success && result.output && result.output.length > 200) {
        try {
          const taskTitle = tEnv.title || `task-${cpNum}-${taskNum}`;
          const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
          const { writeFileSync: wfs, mkdirSync: mkd } = await import('fs');
          const stepsDir = `${CORE_DIR}/shared/${envelope.id}/missions/${envelope.id}/steps`;
          mkd(stepsDir, { recursive: true });
          wfs(`${stepsDir}/${cpNum}.${taskNum}-${slug}.md`, result.output);
        } catch (e) { /* ignore */ }
      }

      const stepResult = {
        step: `${cpNum}.${taskNum}`,
        agent: taskAgent,
        task: taskDesc.substring(0, 200),
        // `result` stays full-fidelity (up to CTX_AGENT_STEP) — cerebellum verifies from it
        // (B-28, re-derivation needs full evidence). Cortex reads the packet `summary` below.
        result: result.success
          ? smartTruncate(result.output || '', CTX_AGENT_STEP)
          : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', CTX_DISPATCH_FAILURE)}`,
        success: result.success,
        durationMs: result.durationMs,
      };
      // ORGAN_CONTEXT_SHARING_PLAN Phase 1: attach a shape-aware resource packet. The
      // cortex-facing delta shows `summary` + `ref` (the full output persists on tEnv.output,
      // fetchable by ref) instead of a blind head+tail clip that drops list rows / tool data.
      if (contracts.organ_context?.result_store_enabled !== false) {
        const pkt = buildResultPacket({
          text: result.success ? (result.output || '') : stepResult.result,
          ref: tId,
          budget: contracts.organ_context?.packet_summary_chars || 1200,
          topK: contracts.organ_context?.list_summary_top_k || 8,
        });
        stepResult.summary = pkt.summary;
        stepResult.ref = pkt.ref;
        stepResult.bytes = pkt.bytes;
        stepResult.shape = pkt.shape;
        log('INFO', `[TELEMETRY] result_packet step=${stepResult.step} shape=${pkt.shape} bytes=${pkt.bytes} summary_chars=${pkt.summary.length} ref=${tId}`);
      }
      cpResults.push(stepResult);
      cpFullOutputs.push({ step: stepResult.step, agent: taskAgent, output: (result.output || result.error || '') });

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

    // ---- Checkpoint-level verification (Cerebellum) ----
    // Canon (02-CHECKPOINT.md): verification happens at checkpoint boundaries. Individual
    // tasks are self-verified by the executing organ (result.success is its own judgment);
    // Cerebellum makes ONE higher-level judgment per checkpoint — did the combined work meet
    // the checkpoint's milestone (accept_criteria)? A holistic judgment call, true to life,
    // not a mechanical per-step gate.
    if (!cpFailed && cpEnvelope.accept_criteria && extractVerdict) {
      try {
        // ORGAN_CONTEXT_SHARING_PLAN Phase 2: verify from FULL evidence (B-28 re-derivation),
        // not the packet-summarized `result`. Still bounded by CTX_VERIFY_INPUT below.
        const fullEvidence = contracts.organ_context?.verifier_full_evidence !== false && cpFullOutputs.length > 0;
        const evidenceRows = fullEvidence ? cpFullOutputs : cpResults;
        const cpOutcome = evidenceRows.map(r => `- [${r.step}] ${r.agent}: ${toStr(fullEvidence ? r.output : r.result)}`).join('\n');
        const isLoadBearing = (envelope._brief?.parts || []).some(p => p.load_bearing);

        // Evidence banked from EARLIER checkpoints — this run's prior checkpoints
        // plus anything carried across a re-plan (savedResults). Without it the
        // verifier sees only the current checkpoint's outputs while judging criteria
        // that a re-plan carried forward, and fails work that already succeeded:
        // a real run FAILed "Drive folder IDs are identified" one round after those
        // exact IDs had been found and quoted in its own prior verdict. A milestone
        // must never fail for evidence that exists upstream (B-28 re-derivation
        // needs the evidence, and a re-plan must not erase it).
        const CTX_VERIFY_PRIOR = contracts.dispatch?.ctx_verify_prior || 6000;
        const priorEstablished = allResults
          .filter(r => !(typeof r.step === 'string' && r.step.endsWith('.verify')))
          .map(r => `- [${r.step}] ${r.agent}: ${toStr(r.result)}`)
          .join('\n');
        log('INFO', `[checkpoint-executor] CP${cpNum}: verifying checkpoint milestone with cerebellum`);
        const verifyReq = {
          instruction: [
            'Verify that this CHECKPOINT MILESTONE has been achieved. Judge the checkpoint as a',
            'whole against its acceptance criteria — a holistic judgment, not a per-step check.',
            'Read the verification SKILL.md before rendering your verdict.',
            '',
            '## Checkpoint',
            cpEnvelope.instruction || `Checkpoint ${cpNum}`,
            '',
            '## Acceptance Criteria (the milestone)',
            cpEnvelope.accept_criteria,
            '',
            ...(priorEstablished ? [
              '## Previously Established (earlier checkpoints — already-verified evidence)',
              'These findings are ALREADY ESTABLISHED. A criterion satisfied here is satisfied,',
              'even if the current checkpoint\'s tasks do not repeat the work. Judge only what',
              'remains. Never fail a criterion for absent evidence when the evidence is below.',
              smartTruncate(priorEstablished, CTX_VERIFY_PRIOR),
              '',
            ] : []),
            '## Combined Task Outputs',
            smartTruncate(cpOutcome || '(no output)', CTX_VERIFY_INPUT),
            ...((stakesAtLeast(missionStakes, ATTACK_STAKES_MIN) || isLoadBearing) ? [
              '',
              `## Attack Duty (stakes: ${missionStakes}${isLoadBearing ? ', load-bearing' : ''})`,
              'Before any PASS, run three attacks and record them: strongest domain objection; flip test; boundary probe.',
              'A winning attack is a FAIL with the attack as the recommendation.',
            ] : []),
            ...(PROBE_ENABLED && (stakesAtLeast(missionStakes, PROBE_STAKES_MIN) || isLoadBearing) ? [
              '',
              '## Probe Eligibility',
              `For any load-bearing claim you cannot verify from the evidence, use request_probe (max ${PROBE_MAX}).`,
            ] : []),
          ].filter(Boolean).join('\n'),
          _missionId: envelope.id,
        };
        let cpVer = await dispatchAgent('cerebellum', verifyReq);
        let cpVerdict = extractVerdict(cpVer.output);
        // A verifier that returned nothing usable — empty output, or no tool log at all — is
        // an infra-ish miss, not a considered verdict. Retry once before failing the milestone
        // closed; a real PASS/FAIL/PROBE is respected immediately (no retry). This stops a
        // single empty generation from triggering a full, wasteful re-plan cycle.
        if (cpVerdict === null && (!cpVer.output || !String(cpVer.output).includes('[TOOL EXECUTION LOG]'))) {
          log('WARN', `[checkpoint-executor] CP${cpNum}: cerebellum returned no usable verdict (${String(cpVer.output || '').length} chars) — retrying once`);
          cpVer = await dispatchAgent('cerebellum', verifyReq);
          cpVerdict = extractVerdict(cpVer.output);
        }
        if (cpVerdict === 'FAIL') {
          const s = extractFailSummary ? extractFailSummary(cpVer.output) : 'Checkpoint acceptance criteria not met';
          const rec = extractFailRecommendation ? extractFailRecommendation(cpVer.output) : '';
          log('WARN', `[checkpoint-executor] Cerebellum FAIL on CP${cpNum} milestone: ${s}`);
          cpFailed = true;
          cpResults.push({ step: `${cpNum}.verify`, agent: 'cerebellum', result: `[CHECKPOINT VERIFICATION FAILED] ${s}${rec ? `\nRecommendation: ${rec}` : ''}`, success: false });
        } else if (cpVerdict === 'PASS') {
          log('INFO', `[checkpoint-executor] Cerebellum PASS on CP${cpNum} milestone`);
        } else {
          // No terminal verdict (or an unresolved PROBE request) — fail closed (B-28): a
          // milestone must not pass unverified. The failed-checkpoint path re-enters cortex
          // with this reason so it can re-plan or gather what the verifier needs.
          log('WARN', `[checkpoint-executor] CP${cpNum}: no terminal checkpoint verdict — failing closed (B-28)`);
          cpFailed = true;
          cpEnvelope.needs_review = true;
          cpResults.push({ step: `${cpNum}.verify`, agent: 'cerebellum', result: '[CHECKPOINT VERIFICATION INCOMPLETE] No terminal PASS/FAIL verdict (B-28 fail-closed).', success: false });
        }
      } catch (e) {
        // Transient verifier-infra failure (dispatch threw), not a refusal. Flag for review
        // rather than failing a checkpoint whose tasks all succeeded.
        log('WARN', `[checkpoint-executor] Checkpoint verification dispatch error CP${cpNum}: ${e.message} — flagging for review, not failing`);
        cpEnvelope.needs_review = true;
      }
    }

    // Mark checkpoint complete or failed
    cpEnvelope.status = cpFailed ? 'failed' : 'complete';
    // Count only real task results, not the pushed cerebellum verdict pseudo-step (step
    // "N.verify") — otherwise a milestone-verification failure reads as a bogus task overflow
    // ("failed at task 3/2" for a 2-task checkpoint). Distinguish a task failure from a
    // milestone-verification failure so the message says what actually happened.
    const taskResultCount = cpResults.filter(r => !(typeof r.step === 'string' && r.step.endsWith('.verify'))).length;
    const verifyFailed = cpResults.some(r => typeof r.step === 'string' && r.step.endsWith('.verify') && !r.success);
    cpEnvelope.output = !cpFailed
      ? `Checkpoint complete: ${taskResultCount} tasks`
      : verifyFailed
        ? `Checkpoint failed: milestone verification not passed (${taskResultCount}/${cpTasks.length} tasks ran)`
        : `Checkpoint failed at task ${taskResultCount}/${cpTasks.length}`;
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
      cpFailed ? `Failed (${taskResultCount} task(s) ran)` : `Complete (${taskResultCount} tasks)`);

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
