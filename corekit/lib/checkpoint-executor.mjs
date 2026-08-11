// checkpoint-executor.mjs — Shared checkpoint execution engine
// Phase 2.5: Convergence of checkpoint execution paths
//
// Shared walk-checkpoints-dispatch-verify-retry pattern used by
// both agent-brain.mjs (checkpoint_plan handler) and process-engine.mjs (runProcessPlan).

import { toStr } from './to-str.mjs';
import { smartTruncate } from './vertex-text.mjs';
import { buildPriorWorkContext, renderCheckpointDigest } from './compaction.mjs';
import { makeAddress } from './channel.mjs';
import { composeDelegationMarker, normalizeTargetEmail, checkDelegationCapability, checkExecutionCapability } from './delegation.mjs';
import { readFileSync as _readFileSync } from 'fs';
import { extractVerdict, extractFailSummary, extractFailRecommendation, isMissingEvidenceFail, stakesAtLeast } from './verdict.mjs';
import { detectMotorFailure, isRecoveredToolError, isDeliveryCriticalIntent } from './agent-output.mjs';
import { createHash } from 'crypto';
import { allocateVersion, sanitizeRepoId } from './git-store.mjs';
import { buildResultPacket, packToolEvidence } from './result-packet.mjs';
import { extractResources, mergeResources, renderResources, seedFromProse } from './resource-ledger.mjs';
import { markCheckpoint, spineSummary, checkpointFailureHalts } from './checkpoint-spine.mjs';
import { deployTargetLine } from './deploy-target.mjs';
import { checkpointAssignee, sameAgent, missionOriginator, handoffPatch, handoffModelEnabled } from './baton.mjs';

const VALID_TASK_AGENTS = new Set(['motor', 'temporal-research', 'temporal-memory']);

// Delegation capability guard (Item 2): the agent's own specialty + the specialty→skills
// map, read once from installed config. Used to catch a delegation that hands a teammate
// work its specialty cannot do while this agent's own specialty can. Read-once (cached);
// on any read failure the guard degrades to a no-op (returns null → guard skipped).
let _delegCapCache = null;
function loadDelegationCapMaps(coreDir) {
  if (_delegCapCache !== null) return _delegCapCache || null;
  try {
    const cfg = JSON.parse(_readFileSync(`${coreDir}/corekit/chat-config.json`, 'utf8'));
    const agentSpecialty = cfg.specialty || cfg.agentType || '';
    const types = JSON.parse(_readFileSync(`${coreDir}/corekit/config/agent-types.json`, 'utf8'));
    const specialtySkills = {};
    for (const t of (types.types || [])) {
      if (t.id) specialtySkills[t.id] = Array.isArray(t.skills) ? t.skills : [];
    }
    _delegCapCache = agentSpecialty ? { agentSpecialty, specialtySkills } : false;
  } catch {
    _delegCapCache = false;
  }
  return _delegCapCache || null;
}

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

async function recordStep(envelope, stepKey, result, enabled, firestoreWrite, meta = {}) {
  if (!enabled) return;
  envelope.step_ledger = envelope.step_ledger || {};
  envelope.step_ledger[stepKey] = {
    status: result.success ? 'complete' : 'failed',
    error: result.error || null,
    durationMs: result.durationMs || 0,
    timestamp: new Date().toISOString(),
    // Tag with the owning checkpoint so a milestone FAIL can clear exactly this
    // checkpoint's task entries (crash-resume dedup must not replay them into a
    // failed re-attempt) without recomputing opaque step-key hashes.
    ...(meta.cp != null ? { cp: meta.cp } : {}),
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
  // A single sub-command error the motor RECOVERED from must not hard-fail a task whose
  // deliverable is complete (it blocked a finished discovery mission). When true, such an
  // error is annotated and left for cerebellum to arbitrate; when false, the strict
  // any-substring hard-fail returns.
  const RECOVERED_TOOL_ERROR_SOFT = contracts.dispatch?.recovered_tool_error_soft_fail !== false;
  // WS-1b: a delivery-critical (publish/deploy) task that FAILED must not soft-pass on prose
  // length — a failed deploy is a real failure, not a recovered incident. Default on.
  const PUBLISH_SOFT_PASS_GUARD = contracts.dispatch?.publish_soft_pass_guard !== false;
  // WS-2: reroute a LOCAL task that invokes a capability this agent's specialty lacks but a
  // teammate's owns into a delegation to the owner (the symmetric mirror of the delegation-
  // side capability guard). Default on; fires on both the checkpoint_plan and process paths.
  const EXEC_CAP_REROUTE = contracts.dispatch?.execution_capability_reroute !== false;
  const RESOURCE_LEDGER_ENABLED = contracts.memory?.resource_ledger?.enabled !== false;
  const RESOURCE_LEDGER_MAX = contracts.memory?.resource_ledger?.max_entries ?? 200;
  const RESOURCE_LEDGER_RECALL_LIMIT = contracts.memory?.resource_ledger?.recall_limit ?? 40;
  const SPINE_PINNING_ENABLED = contracts.dispatch?.spine_pinning_enabled !== false;
  // FC-D: a non-terminal checkpoint whose tasks succeeded but whose MILESTONE could not be
  // confirmed (a delegate did the work in its own workspace the delegator's verifier can't see)
  // must not HALT the mission — the deliverable (terminal) checkpoint's observable milestone is
  // the real gate. Opt-in (changes halt semantics); default OFF until proven on canary. The
  // AGENT_NONTERM_MILESTONE_NONHALT=1 per-VM env enables it for a canary without flipping the
  // fleet default (same pattern as AGENT_REDELEG_CAP / AGENT_FINALIZE_SPINE_GUARD).
  const NONTERMINAL_MILESTONE_NONHALT = process.env.AGENT_NONTERM_MILESTONE_NONHALT === '1'
    || contracts.dispatch?.nonterminal_milestone_nonhalting === true;
  // Baton delegation model: when a checkpoint is assigned to a different agent, the whole
  // mission is handed to them (they resume this same spine) instead of spawning a child mission.
  const HANDOFF_MODE = handoffModelEnabled(contracts);
  const HANDOFF_LEASE_MS = contracts.dispatch?.delegation?.handoff_lease_ms || 1800000;
  // verify_probe_* is deliberately NOT read. The probe loop does not exist: nothing ever
  // serviced a returned probe request, so advertising request_probe only produced verifiers
  // that asked a question we could not answer and milestones that then failed closed for
  // asking it. The contract flags stay (documented dormant there) so re-enabling is one
  // change once the loop is built — but no dead read here pretending it is wired.
  const ATTACK_STAKES_MIN = contracts.dispatch?.attack_duty_stakes_min || 'consequential';
  const FULL_EVIDENCE_MAX = contracts.dispatch?.verify_full_evidence_max_chars ?? 80000;
  const missionStakes = envelope.stakes || 'routine';

  // ---- Seed the resource ledger from the request itself ----
  // The operator usually SAYS the ids: "place them in the In Progress folder
  // (1ozAGM…)". A real mission was handed all three folder ids in its request and
  // still ran name-based searches for them — one of which came back empty because
  // the folder's real name differs from the name in the request. Anything already
  // stated is known; seeding costs one regex pass and removes the search entirely.
  // Idempotent: checkpoint_plan seeds this same text before it structures a plan
  // (the planner needs the ids too). This call still earns its place — the
  // process-engine path reaches the executor without passing through planning.
  if (RESOURCE_LEDGER_ENABLED) {
    try {
      const seedText = [envelope.instruction, envelope.source_text, envelope.context_summary]
        .filter(Boolean).map(toStr).join('\n');
      envelope.context = envelope.context || {};
      const { ledger, added, updated } = seedFromProse(
        envelope.context.resources, seedText,
        { max: RESOURCE_LEDGER_MAX, now: new Date().toISOString(), source: 'request' },
      );
      envelope.context.resources = ledger;
      if (added || updated) {
        log('INFO', `[TELEMETRY] resource_ledger mission=${envelope.id} step=request added=${added} updated=${updated} total=${Object.keys(ledger).length}`);
      }
    } catch (e) {
      log('WARN', `Resource ledger seed failed: ${e.message}`);
    }
  }

  let allResults = savedResults || [];
  let planFailed = false;
  let delegationCount = 0;
  const maxDelegations = contracts?.dispatch?.max_delegations_per_checkpoint || 4;
  const contextSliceChars = contracts?.dispatch?.context_slice_chars || 500;

  const isPreStamped = checkpoints[0] && checkpoints[0].cEnvelope !== undefined;

  for (let ci = startCpIndex; ci < checkpoints.length; ci++) {
    // ---- Baton hand-off: this checkpoint belongs to a teammate ----
    // Persist work-in-progress on the shared mission branch, then hand the WHOLE mission to the
    // assignee — their daemon dequeues it by assignee, re-clones the branch, and resumes this
    // same spine at this checkpoint. Context + git branch travel with the mission. No child
    // mission, no re-plan. Only active under the handoff delegation model (flag-gated).
    if (HANDOFF_MODE && Array.isArray(envelope._cp_spine)) {
      const _sc = envelope._cp_spine[ci] || null;
      const _me = AGENT_EMAIL || AGENT_ID;
      // Skip checkpoints already COMPLETE: only the first not-complete checkpoint drives the
      // baton. Without this, a re-entry after all work is done hands the *completed* cp back to
      // its old assignee (cp1->bobby, cp2->stan, …) and the mission bounces agent→agent forever
      // instead of finalizing — the synthesis-phase non-termination the staging canary exposed.
      // When every checkpoint is complete the loop falls through to the originator's hand-back/
      // synthesize (post-loop), which is the clean terminal path.
      if (_sc && _sc.status === 'complete') continue;
      const _cpOwner = checkpointAssignee(_sc, missionOriginator(envelope));
      if (_sc && _cpOwner && !sameAgent(_cpOwner, _me)) {
        try { if (gitCommitAndSync) await gitCommitAndSync(envelope.id, envelope.project_id, `baton: hand-off before CP${ci + 1}`); }
        catch (e) { log('WARN', `[baton] pre-handoff sync failed (non-fatal): ${e.message}`); }
        Object.assign(envelope, handoffPatch(envelope, _cpOwner, { now: Date.now(), leaseMs: HANDOFF_LEASE_MS }));
        envelope._cp_progress = null; // hand-off is at a checkpoint boundary — the assignee starts fresh
        await firestoreWrite('work', envelope.id, envelope);
        log('INFO', `[baton] hand-off mission=${envelope.id} CP${ci + 1} -> ${_cpOwner}`);
        log('INFO', `[TELEMETRY] baton_handoff mission=${envelope.id} cp=${ci + 1} from=${_me} to=${_cpOwner} turn=${(envelope._baton && envelope._baton.turn) || 0}`);
        return { paused: true, handedOff: true, to: _cpOwner, results: allResults };
      }
    }
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
        // Recognize all three field-name variants the planner/process layers emit for a step
        // type ('_step_type', bare 'step_type', 'type') so an explicit delegation/approval step
        // is honored regardless of which layer authored it.
        stepType = task._step_type || task.step_type || task.type || 'standard';
        isOptional = task._optional === true;
      }

      // WS-2: route specialty-owned execution to the owning teammate. A LOCAL motor task that
      // invokes a distinctive capability THIS agent's specialty lacks but a project teammate's
      // specialty OWNS can only fail here (no skill, no perms) — convert it to a delegation so
      // the owner runs it. Generic and fires on BOTH execution paths (checkpoint_plan and
      // follow_process converge on this loop). It flips stepType→'delegation' + sets the target
      // specialty, so the delegation branch below reuses its resolution, source handoff and
      // deploy-target injection. The mirror of the delegation-side capability guard: that one
      // catches sending work AWAY that we should do ourselves; this one catches doing work
      // LOCALLY that we should send to the owner.
      if (EXEC_CAP_REROUTE && delegationEnabled && stepType === 'standard' && taskAgent === 'motor') {
        const capMaps = loadDelegationCapMaps(CORE_DIR);
        if (capMaps && capMaps.agentSpecialty && capMaps.specialtySkills) {
          const rosterSpecialties = Object.values(PROJECTS?.[envelope.project_id]?.team || {})
            .map(m => m && (m.specialty || m.type)).filter(Boolean);
          const reroute = checkExecutionCapability({
            instruction: taskDesc,
            executorSpecialty: capMaps.agentSpecialty,
            specialtySkills: capMaps.specialtySkills,
            rosterSpecialties,
          });
          if (reroute.reroute && reroute.targetSpecialty && reroute.targetSpecialty !== capMaps.agentSpecialty) {
            log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: [execution-capability] ${reroute.reason} — rerouting to a delegation`);
            stepType = 'delegation';
            task._specialty = reroute.targetSpecialty;
            taskAgent = reroute.targetSpecialty; // labels/logs read the delegate specialty
          }
        }
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
        // On the pre-stamped (process) path `task` is the T-envelope, so the delegate specialty
        // lives at source_meta.specialty — read it too, else an explicit process delegation step
        // resolved to the agent's own type and self-delegated. (_specialty wins when set, incl.
        // the WS-2 reroute above.)
        const delegateSpecialty = task._specialty || task.source_meta?.specialty || taskAgent;

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

        // ---- Self-delegation guard + capability guard ----
        // Item 2: before dispatching, check whether the target specialty can even do the
        // work. A delegation that invokes a capability the target lacks but THIS agent owns
        // (e.g. a devops agent handing a Firebase deploy to an engineer) is self-defeating —
        // the delegate can only block on it. Do it ourselves instead. Read-once, flag-gated.
        const _delegInstruction = task.instruction || task.task || task.summary || '';
        const _capMaps = (contracts?.dispatch?.delegation_capability_guard !== false)
          ? loadDelegationCapMaps(CORE_DIR) : null;
        const _capCheck = _capMaps
          ? checkDelegationCapability({
              instruction: _delegInstruction,
              delegatorSpecialty: _capMaps.agentSpecialty,
              targetSpecialty: delegateSpecialty,
              specialtySkills: _capMaps.specialtySkills,
            })
          : { ok: true };
        // If the delegation resolves to THIS agent, convert to a local motor task
        // instead of sending a GChat message to ourselves (which causes infinite loops).
        if (targetAgentEmail === (AGENT_EMAIL || AGENT_ID)) {
          log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: delegation to '${delegateSpecialty}' resolved to SELF (${targetAgentEmail}) — converting to local motor task`);
          // Override: treat as standard motor task
          stepType = 'standard';
          task.agent = 'motor';
          taskAgent = 'motor';
          // Fall through to standard task execution below
        } else if (!_capCheck.ok && _capCheck.selfCapable) {
          log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: [capability-guard] ${_capCheck.reason} — converting to local motor task`);
          cpResults.push({
            step: `${cpNum}.${taskNum}`, agent: 'system',
            result: `[ADVISORY] Delegation to '${delegateSpecialty}' redirected to a local task: it invokes ${_capCheck.offending.join(', ')}, which that specialty lacks and this agent owns. Do your own specialty's work; delegate only what needs a specialty you do not have.`,
            success: true,
          });
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
              + `then read from the \`delegator-inputs/\` directory. If the branch is EMPTY or a named input `
              + `is absent there, it simply was not committed to the branch — this is NOT a blocker and NOT a `
              + `reason to loop or report failure. Fetch the input from its DURABLE source instead: your project `
              + `context and this instruction carry the canonical locators (a Drive file id, a source repo, a doc) — `
              + `retrieve from there (e.g. \`drive-download <id>\`) and proceed. Report a missing input only if it exists in NO durable source.`;
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
        // Name the project's DEPLOY TARGET in the delegated instruction (belt-and-suspenders
        // beside the delegate's own project render): the exact hosting site, GCP project, and
        // source — so a devops delegate deploys the right content to the right site.
        const _dtLine = deployTargetLine(PROJECTS[envelope.project_id]?.deploy);
        if (_dtLine) taskDesc += `\n\n[DEPLOY TARGET] ${_dtLine} — deploy to THIS site/project; fetch the source first.`;
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

      // Known identifiers, carried to the organ that is about to act.
      // recallMemory() runs ONCE per mission, before any task — so ids captured or
      // seeded during the mission never reach later iterations through recall. That
      // is why a mission "found the folder in an earlier iteration" and then "could
      // not re-locate it": the knowledge existed and was never handed over. Memory
      // still owns finding and ranking identifiers; the executor's job is only to
      // keep them in front of the organ doing the work.
      let knownResources = '';
      if (RESOURCE_LEDGER_ENABLED) {
        try {
          knownResources = renderResources(envelope.context?.resources, {
            limit: RESOURCE_LEDGER_RECALL_LIMIT,
            cues: String(taskDesc || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3),
          });
        } catch { knownResources = ''; }
      }

      // Precedence is stated, not implied. A task instruction can name an id that
      // DISAGREES with the ledger's, and the organ then has to choose blind: one real
      // mission failed identically on every attempt because a planner had hand-copied
      // the master template's id with a single character wrong, while the correct id —
      // read from a Drive listing — sat in the ledger in the same prompt. A ledger id
      // came out of a tool result; an id in an instruction was typed by a planner.
      const dispatchPayload = {
        instruction: currentInstruction + currentSkillCatalog
          + (knownResources ? `\n\n${knownResources}\n(These are already resolved. Use the id directly — do not search for them by name.\n`
            + `PRECEDENCE, strongest first, when two sources name an id for the same resource:\n`
            + `  1. This block, and any id an earlier task reported as a verified claim — read back from a tool result.\n`
            + `  2. An id written into the instruction above — typed out when the plan was written, so it can be mistyped.\n`
            + `  3. A row in a raw listing you are looking at now — the WEAKEST source, because a listing answers "what is in this folder", not "which one did we mean".\n`
            + `Never take the first row of a listing as "the" file. One mission had the right template named in this block, took the first row of a folder listing instead, and built three documents from the wrong template. If sources disagree, use the strongest and say in your report that you did.)` : ''),
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

      // Motor failure check. A detected failure is the task OUTCOME (hard-fail) UNLESS the
      // motor recovered from a sub-command error and still produced the deliverable — then it
      // is an incident: annotate it for cerebellum to weigh, don't fail the task (B-28,
      // verification arbitrates from the full evidence). Without this a discovery that
      // gathered everything was reported `blocked` because one command in its tool log
      // printed "command failed".
      const applyMotorCheck = (res) => {
        if (taskAgent !== 'motor') return;
        const mc = detectMotorFailure(res.output || res.error || '');
        if (!mc.failed) return;
        // A delivery-critical task (deploy/publish/promote) that failed must NOT soft-pass on
        // prose length — a failed publish is a real failure, not a recovered incident (the live
        // false-complete: a deploy hit HTTP 404 yet the mission reported ✅). It may still
        // soft-pass on PROVEN retry-recovery (the action itself succeeded on a later attempt),
        // which preserves the FU-A recovered-by-retry behavior.
        const requireActionRecovery = PUBLISH_SOFT_PASS_GUARD && isDeliveryCriticalIntent(taskDesc);
        if (RECOVERED_TOOL_ERROR_SOFT && isRecoveredToolError(res.output || '', { requireActionRecovery })) {
          log('WARN', `[checkpoint-executor] CP${cpNum} T${taskNum}: motor reported "${mc.detail}" in a tool call but recovered and produced a deliverable — not hard-failing; cerebellum arbitrates`);
          res.output = (res.output || '') + `\n[EVIDENCE WARNING: a tool call reported "${mc.detail}" during this task; the motor recovered and produced a result. Verify the final answer is complete and accounts for that error.]`;
          return;
        }
        res.success = false;
        res.error = mc.detail;
      };
      applyMotorCheck(result);

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

        applyMotorCheck(result);
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

      // ---- Resource ledger capture (RESOURCE_LEDGER_PLAN, C-4/C-5) ----
      // An external id resolved once must never be searched for again. Capture is
      // deterministic — the ids come from the structured JSON the skills already
      // emit, parsed by the daemon, with no LLM in the path. It lands on the
      // ENVELOPE (Firestore), not the working tree: a resume re-clones the tree
      // and destroys everything in it, which is exactly how a mission came to
      // re-run the same failing drive-search six times for a folder it had
      // already located. Memory surfaces this later — see recallMemory Layer E.
      if (RESOURCE_LEDGER_ENABLED) {
        try {
          const found = extractResources(toStr(tEnv.output));
          if (found.length > 0) {
            envelope.context = envelope.context || {};
            const { ledger, added, updated, dropped } = mergeResources(
              envelope.context.resources, found,
              { max: RESOURCE_LEDGER_MAX, now: new Date().toISOString(), source: `${cpNum}.${taskNum}` },
            );
            envelope.context.resources = ledger;
            if (added || updated || dropped) {
              log('INFO', `[TELEMETRY] resource_ledger mission=${envelope.id} step=${cpNum}.${taskNum} added=${added} updated=${updated} dropped=${dropped} total=${Object.keys(ledger).length}`);
            }
          }
        } catch (e) {
          // Never fail a task that produced real work over a bookkeeping miss.
          log('WARN', `Resource ledger capture failed: ${e.message}`);
        }
      }
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
          // Below this many chars of prose OUTSIDE the tool log, the tool RESULTS are the
          // answer (a discovery mission) — digest them into the summary instead of eliding
          // the whole result to a bare marker Cortex cannot synthesize from.
          minProse: contracts.organ_context?.tool_answer_min_prose_chars || 240,
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
      await recordStep(envelope, taskStepKey, { success: result.success, error: result.error, durationMs: result.durationMs }, STEP_LEDGER_ENABLED, firestoreWrite, { cp: cpNum });

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
        // First-attempt evidence uses result packets (already capped at CTX_AGENT_STEP).
        // Compact evidence keeps the verify prompt under the MALFORMED_FUNCTION_CALL
        // threshold (~10K prompt chars on Gemini Flash) while preserving the key signal:
        // tool results, not motor reasoning. Full motor output is reserved for the
        // missing-evidence re-verify path where the verifier explicitly asked for more.
        const cpOutcome = cpResults.map(r => `- [${r.step}] ${r.agent}: ${toStr(r.result)}`).join('\n');
        const cpOutcomeFull = (contracts.organ_context?.verifier_full_evidence !== false && cpFullOutputs.length > 0)
          ? cpFullOutputs.map(r => `- [${r.step}] ${r.agent}: ${toStr(r.output)}`).join('\n')
          : cpOutcome;
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
        // ---- Verify prompt evidence budget ----
        // Originally capped at 8K to avoid MALFORMED_FUNCTION_CALL at 10K-16K prompts.
        // Root cause was bad toGoogleSchema + wrong toolConfig (fixed f5d3a79); raised
        // to 12K so the adversarial pass sees enough evidence for document-editing
        // missions (7K+ of tool log was being truncated to 4.8K, causing false overturns).
        const VERIFY_PROMPT_MAX = contracts.dispatch?.verify_prompt_max_chars || 12000;
        const BOILERPLATE = 1200;
        const instrBudget = Math.min(1500, Math.floor(VERIFY_PROMPT_MAX * 0.2));
        const critBudget = Math.min(2500, Math.floor(VERIFY_PROMPT_MAX * 0.32));
        const cpInstrText = smartTruncate(toStr(cpEnvelope.instruction) || `Checkpoint ${cpNum}`, instrBudget);
        const cpCritText = smartTruncate(toStr(cpEnvelope.accept_criteria), critBudget);
        const remaining = Math.max(1000,
          VERIFY_PROMPT_MAX - BOILERPLATE - cpInstrText.length - cpCritText.length);
        // Reserve a slice for prior-checkpoint evidence ONLY when there is some. A single-
        // checkpoint (or first-checkpoint) mission has no prior evidence, yet the reservation
        // still ran — capping the current evidence for nothing. A live read-only discovery
        // FAILed exactly here: its 8,883-char evidence was capped to 6,770, truncating the
        // gcloud command the verifier then reported as "never executed". No prior → the whole
        // remaining budget goes to the evidence under test.
        const priorBudget = priorEstablished ? Math.min(CTX_VERIFY_PRIOR, Math.floor(remaining * 0.35)) : 0;
        const evidenceBudget = Math.min(CTX_VERIFY_INPUT, remaining - priorBudget);
        log('INFO', `[checkpoint-executor] CP${cpNum}: verifying checkpoint milestone with cerebellum (evidence<=${evidenceBudget} prior<=${priorBudget} cap=${VERIFY_PROMPT_MAX} compact=${cpOutcome.length} full=${cpOutcomeFull.length})`);
        const verifyReq = {
          instruction: [
            'Verify that this CHECKPOINT MILESTONE has been achieved. Judge the checkpoint as a',
            'whole against its acceptance criteria — a holistic judgment, not a per-step check.',
            'Read the verification SKILL.md before rendering your verdict.',
            // Ordering, not brevity: reason as fully as the work deserves, but register the
            // verdict as soon as it is reached. A verifier that saves the tool call for the
            // end of a long write-up loses the whole judgment when the output budget runs
            // out — observed twice on one checkpoint, at a prompt size well inside the cap.
            'Call report_pass or report_fail AS SOON AS you have reached your judgment. Do not',
            'save the tool call for the end of a long write-up: if your output budget runs out',
            'first, the verdict you reached is lost and the milestone fails for no reason.',
            '',
            '## Checkpoint',
            cpInstrText,
            '',
            '## Acceptance Criteria (the milestone)',
            cpCritText,
            '',
            ...(priorEstablished ? [
              '## Previously Established (earlier checkpoints — already-verified evidence)',
              'These findings are ALREADY ESTABLISHED. A criterion satisfied here is satisfied,',
              'even if the current checkpoint\'s tasks do not repeat the work. Judge only what',
              'remains. Never fail a criterion for absent evidence when the evidence is below.',
              smartTruncate(priorEstablished, priorBudget),
              '',
            ] : []),
            '## Combined Task Outputs',
            smartTruncate(cpOutcome || '(no output)', evidenceBudget),
            // Attack duty and probe eligibility used to live HERE, in the same call as the
            // verdict. Both are gone from the first attempt, for two different reasons:
            //
            // PROBE was advertised and never serviced. Nothing reads a returned probe request
            // (extractProbes was imported and never called), so a verifier that obeyed the
            // instruction and asked for more evidence produced no terminal verdict — and the
            // B-28 fail-closed then failed the milestone for asking a question we invited.
            // It stays out until the probe loop actually exists.
            //
            // ATTACK DUTY moved to its own pass below. Attacks exist to prevent a false PASS,
            // so a FAIL never needed them, and asking one call to both reach a verdict and
            // attack it split the output budget between the two. The dedicated pass gets the
            // whole budget for attacking and can overturn a PASS — stricter, not looser.
            // Keeping the first attempt lean also removes it as a suspect in the
            // MALFORMED_FUNCTION_CALL failures: the reduced prompt that reliably WORKS is
            // exactly the one without this scaffolding, at a size the full prompt beat.
          ].filter(Boolean).join('\n'),
          _missionId: envelope.id,
        };
        let cpVer = await dispatchAgent('cerebellum', verifyReq);
        let cpVerdict = extractVerdict(cpVer.output);
        // A verifier that returned nothing usable — empty output, or no tool log at all — is
        // an infra-ish miss, not a considered verdict. Retry once before failing the milestone
        // closed; a real PASS/FAIL/PROBE is respected immediately (no retry). This stops a
        // single empty generation from triggering a full, wasteful re-plan cycle.
        const emptyVerdict = v => extractVerdict(v.output) === null
          && (!v.output || !String(v.output).includes('[TOOL EXECUTION LOG]'));
        // Diagnostics on an empty generation: without finishReason an empty reply is
        // indistinguishable from a refusal, a filter, or an output budget consumed by
        // thinking. A real run returned 0 chars TWICE on the same 9,746-token input —
        // deterministic, not flaky — and there was no way to tell which.
        // promptChars is a parameter, not a closure over verifyReq: this diagnostic is also used
        // for the adversarial pass, which sends a different prompt, and reporting the verify
        // prompt's length there would misattribute the cause.
        const emptyDiag = (v, attempt, promptText) => `attempt=${attempt} chars=${String(v.output || '').length} `
          + `finishReason=${v.finishReason || 'unknown'} promptChars=${String(promptText ?? verifyReq.instruction ?? '').length} `
          + `error=${(v.error || 'none').toString().slice(0, 120)}`;

        // A MALFORMED_FUNCTION_CALL is the provider deterministically refusing THIS prompt:
        // observed twice in a row, byte-identical, same 0-char result. Re-sending it is a
        // wasted call and a wasted minute, so skip straight to the differently-shaped attempt.
        // Anything else (an unknown reason, a transient blank) may well be flaky — retry that.
        const deterministicRefusal = v => /MALFORMED_FUNCTION_CALL/i.test(String(v.finishReason || ''));
        if (emptyVerdict(cpVer)) {
          if (deterministicRefusal(cpVer)) {
            log('WARN', `[checkpoint-executor] CP${cpNum}: no verdict and finishReason is deterministic — skipping the identical retry, going straight to a reduced prompt (${emptyDiag(cpVer, 1)})`);
          } else {
            log('WARN', `[checkpoint-executor] CP${cpNum}: cerebellum returned no usable verdict — retrying once (${emptyDiag(cpVer, 1)})`);
            cpVer = await dispatchAgent('cerebellum', verifyReq);
            cpVerdict = extractVerdict(cpVer.output);
          }

          // Second empty reply on an identical prompt means the prompt itself is the
          // problem, so repeating it a third time is pointless. Ask the same question
          // with far less of it: criteria plus a hard-clipped evidence slice, none of
          // the attack/probe scaffolding. Failing closed here blocks a mission that may
          // be perfectly on track — that is exactly what happened — so it is worth one
          // cheap, differently-shaped attempt before conceding.
          if (emptyVerdict(cpVer)) {
            log('WARN', `[checkpoint-executor] CP${cpNum}: still no verdict — one reduced-prompt attempt (${emptyDiag(cpVer, 2)})`);
            // Two different causes produce an empty verdict and they need different
            // explanations. MALFORMED_FUNCTION_CALL means the prompt was too big. MAX_TOKENS
            // means the OUTPUT budget ran out — a verifier that reasons at length before
            // calling report_pass/report_fail spends its whole allowance on thinking and
            // emits no verdict, which happens at prompt sizes far below any cap.
            let budgetExhausted = /MAX_TOKENS/i.test(String(cpVer.finishReason || ''));
            const reduced = {
              instruction: [
                'Verify this checkpoint against its acceptance criteria. Call report_pass or',
                'report_fail exactly once. Be brief — one sentence of reasoning per criterion.',
                '',
                '## Acceptance Criteria',
                smartTruncate(toStr(cpEnvelope.accept_criteria), 2000),
                '',
                '## Evidence',
                smartTruncate(cpOutcome || '(no output)', 6000),
              ].join('\n'),
              _missionId: envelope.id,
            };
            cpVer = await dispatchAgent('cerebellum', reduced);
            cpVerdict = extractVerdict(cpVer.output);
            if (cpVerdict) {
              log('INFO', `[checkpoint-executor] CP${cpNum}: reduced prompt produced ${cpVerdict} — `
                + (budgetExhausted
                  ? `the verifier's OUTPUT budget was exhausted before it emitted a verdict (finishReason=MAX_TOKENS at ${(verifyReq.instruction || '').length} prompt chars, well inside the cap) — less to reason about left room for the verdict. Not a problem with the work.`
                  : 'the full prompt was the problem, not the work'));
            } else {
              log('WARN', `[checkpoint-executor] CP${cpNum}: reduced prompt also empty (${emptyDiag(cpVer, 3, reduced.instruction)})`);
            }
          }
        }
        // ---- Adversarial pass (B-28) — only over a PASS, and only when stakes earn it ----
        // An attack exists to stop a FALSE pass, so a FAIL never needed one. Run as its own
        // call the whole output budget goes to attacking, instead of competing with the
        // verdict inside one reply.
        //
        // Asymmetry on purpose: a first attempt with no verdict fails the milestone CLOSED,
        // but this pass returning no verdict leaves the PASS standing. The milestone already
        // earned a terminal verdict from its evidence; an infra miss in an EXTRA check must
        // not destroy a verdict that was properly reached.
        if (cpVerdict === 'PASS' && (stakesAtLeast(missionStakes, ATTACK_STAKES_MIN) || isLoadBearing)) {
          try {
            const atkEvidenceBudget = Math.max(1000, VERIFY_PROMPT_MAX - BOILERPLATE - cpCritText.length);
            const atkReq = {
              instruction: [
                `You already judged this checkpoint a PASS. Now try to overturn it (stakes: ${missionStakes}${isLoadBearing ? ', load-bearing' : ''}).`,
                'Run three attacks and record each one:',
                '  1. The strongest objection a domain expert would raise.',
                '  2. A flip test — what would have to be true for this to be wrong?',
                '  3. A boundary probe — the edge case most likely to be unhandled.',
                '',
                'If any attack lands, call report_fail with that attack as the recommendation. If',
                'all three fail to land, call report_pass. Register the verdict as soon as you reach it.',
                'Do NOT pass merely because the earlier verdict passed — re-derive from the evidence.',
                '',
                '## Acceptance Criteria (the milestone)',
                cpCritText,
                '',
                '## Evidence',
                smartTruncate(cpOutcome || '(no output)', atkEvidenceBudget),
              ].join('\n'),
              _missionId: envelope.id,
            };
            const atk = await dispatchAgent('cerebellum', atkReq);
            const atkVerdict = extractVerdict(atk.output);
            if (atkVerdict === 'FAIL') {
              log('WARN', `[checkpoint-executor] CP${cpNum}: adversarial pass OVERTURNED the PASS — an attack landed`);
              cpVer = atk;
              cpVerdict = 'FAIL';
            } else if (atkVerdict === 'PASS') {
              log('INFO', `[checkpoint-executor] CP${cpNum}: adversarial pass upheld the PASS (three attacks, none landed)`);
            } else {
              log('WARN', `[checkpoint-executor] CP${cpNum}: adversarial pass returned no verdict (${emptyDiag(atk, 'attack', atkReq.instruction)}) — the earned PASS stands`);
            }
          } catch (e) {
            log('WARN', `[checkpoint-executor] CP${cpNum}: adversarial pass dispatch failed: ${e.message} — the earned PASS stands`);
          }
        }

        // ---- A FAIL for MISSING evidence is not a failed milestone ----
        // The verifier is telling us it could not SEE the work, which is a request for
        // more evidence, not a judgement against the work. One real checkpoint edited
        // three documents correctly, got 2,833 chars of evidence for all three, PASSED
        // the first clause and failed the second because one document's content "is not
        // fully visible in the provided transcript". So: give it the evidence it asked
        // for and ask again. This is the serviced form of the probe we removed — bounded
        // to one extra call, deterministic, and it answers the only question the verifier
        // actually raised.
        if (cpVerdict === 'FAIL') {
          const failReason = extractFailSummary ? extractFailSummary(cpVer.output) : '';
          // Re-verify on the FULL evidence when the FAIL says "can't see it" OR when we KNOW we
          // fed the verifier a truncated view (compact exceeded the evidence budget). The second
          // trigger is deterministic and catches the fail that hides as a substantive objection —
          // "no gcloud command was executed to get the count" when the command DID run but sat in
          // the dropped middle. Either way the verdict was reached on less than the whole result.
          const compactTruncated = cpOutcomeFull.length > evidenceBudget || cpOutcome.length > evidenceBudget;
          if (isMissingEvidenceFail(failReason) || compactTruncated) {
            log('WARN', `[checkpoint-executor] CP${cpNum}: re-verifying on full evidence (trigger=${isMissingEvidenceFail(failReason) ? 'missing-evidence-text' : 'compact-truncated'}, compact=${cpOutcome.length} full=${cpOutcomeFull.length} budget=${evidenceBudget}): ${String(failReason).slice(0, 140)}`);
            try {
              const fullEvCritText = smartTruncate(toStr(cpEnvelope.accept_criteria), critBudget);
              // The re-verify prompt is lean (criteria + evidence, no attack/prior scaffolding),
              // so it can spend nearly the whole verify budget on evidence. The old `9000 - crit`
              // hardcap made verify_full_evidence_max_chars DEAD (it never bound) and starved this
              // path to ~6.5K — the very truncation that produced the FAIL. Bind the contract knob
              // under a prompt-safe ceiling (raising it past what the verifier model can ingest is
              // a contract + model change, not a code change).
              const fullEvBudget = Math.min(FULL_EVIDENCE_MAX, Math.max(3000, VERIFY_PROMPT_MAX - fullEvCritText.length - BOILERPLATE));
              // Keep every tool's RESULT (shape-aware), not a head+tail clip that drops the middle
              // where a command's output lives — this is exactly the evidence B-28 re-derives from.
              const fullEvidenceText = cpFullOutputs.length > 0
                ? packToolEvidence(cpFullOutputs, fullEvBudget)
                : smartTruncate(cpOutcomeFull || '(no output)', fullEvBudget);
              const fullReq = {
                instruction: [
                  'Verify this checkpoint against its acceptance criteria. Call report_pass or',
                  'report_fail exactly once, as soon as you reach your judgement.',
                  '',
                  'Your previous verdict was reached on a truncated view. The COMPLETE evidence is',
                  'below — every tool call\'s result is included. Judge the work on it. Do NOT fail a',
                  'criterion for missing evidence again — if something is genuinely absent from the',
                  'work, say which criterion and what is missing from the ARTIFACT, not from this text.',
                  '',
                  '## Acceptance Criteria',
                  fullEvCritText,
                  '',
                  '## Complete Evidence',
                  fullEvidenceText || '(no output)',
                ].join('\n'),
                _missionId: envelope.id,
              };
              const reVer = await dispatchAgent('cerebellum', fullReq);
              const reVerdict = extractVerdict(reVer.output);
              if (reVerdict === 'PASS' || reVerdict === 'FAIL') {
                log('INFO', `[checkpoint-executor] CP${cpNum}: re-verification on full evidence returned ${reVerdict} (prompt ${fullReq.instruction.length} chars)`);
                cpVer = reVer;
                cpVerdict = reVerdict;
              } else {
                log('WARN', `[checkpoint-executor] CP${cpNum}: re-verification produced no verdict (${emptyDiag(reVer, 'full-evidence', fullReq.instruction)})`);
              }
            } catch (e) {
              log('WARN', `[checkpoint-executor] CP${cpNum}: full-evidence re-verification failed to dispatch: ${e.message}`);
            }
          }
        }

        if (cpVerdict === 'FAIL') {
          const s = extractFailSummary ? extractFailSummary(cpVer.output) : 'Checkpoint acceptance criteria not met';
          const rec = extractFailRecommendation ? extractFailRecommendation(cpVer.output) : '';
          // Still unseen after being handed everything. The milestone does NOT pass (B-28
          // holds: nothing is verified here), but this must not be reported as failed WORK.
          // Marked inconclusive so the synthesize guard can tell it from a real failure —
          // otherwise a mission that finished its work gets forced to `blocked`.
          const inconclusive = isMissingEvidenceFail(s);
          if (inconclusive) {
            log('WARN', `[checkpoint-executor] CP${cpNum}: verification INCONCLUSIVE — the verifier still could not see the evidence. Milestone unverified and flagged for review; the work itself is NOT marked failed.`);
            cpEnvelope.needs_review = true;
          } else {
            log('WARN', `[checkpoint-executor] Cerebellum FAIL on CP${cpNum} milestone: ${s}`);
          }
          cpFailed = true;
          cpResults.push({
            step: `${cpNum}.verify`,
            agent: 'cerebellum',
            result: inconclusive
              ? `[CHECKPOINT VERIFICATION INCONCLUSIVE] The verifier could not see enough evidence to judge this milestone: ${s}. The work was NOT judged wrong. Treat the tasks' own reported outcomes as the best available account, and say plainly which parts remain unverified.`
              : `[CHECKPOINT VERIFICATION FAILED] ${s}${rec ? `\nRecommendation: ${rec}` : ''}`,
            success: false,
            ...(inconclusive ? { inconclusive: true } : {}),
          });
        } else if (cpVerdict === 'PASS') {
          log('INFO', `[checkpoint-executor] Cerebellum PASS on CP${cpNum} milestone`);
        } else {
          // No terminal verdict (or an unresolved PROBE request) — fail closed (B-28): a
          // milestone must not pass unverified. The failed-checkpoint path re-enters cortex
          // with this reason so it can re-plan or gather what the verifier needs.
          log('WARN', `[checkpoint-executor] CP${cpNum}: no terminal checkpoint verdict — failing closed (B-28)`);
          cpFailed = true;
          cpEnvelope.needs_review = true;
          // Also inconclusive: a verifier that returned nothing has not judged the work
          // wrong. The milestone stays unverified (fail-closed), but downstream must not
          // treat "we never got a verdict" as "the work failed" — that is precisely how a
          // mission with finished deliverables ends up reported as blocked.
          cpResults.push({
            step: `${cpNum}.verify`,
            agent: 'cerebellum',
            result: '[CHECKPOINT VERIFICATION INCONCLUSIVE] No terminal PASS/FAIL verdict was returned, so this milestone is unverified (B-28 fail-closed). The work was NOT judged wrong.',
            success: false,
            inconclusive: true,
          });
        }
      } catch (e) {
        // Transient verifier-infra failure (dispatch threw), not a refusal. Flag for review
        // rather than failing a checkpoint whose tasks all succeeded.
        log('WARN', `[checkpoint-executor] Checkpoint verification dispatch error CP${cpNum}: ${e.message} — flagging for review, not failing`);
        cpEnvelope.needs_review = true;
      }
    }

    // FC-D: decide whether a FAILED checkpoint HALTS the plan, or the mission may proceed. A
    // MILESTONE-only failure (every task succeeded, only the cerebellum verdict failed) on a
    // NON-terminal checkpoint does not halt — the delegate did the work in its own workspace the
    // delegator's verifier cannot see, and the deliverable (terminal) checkpoint's OBSERVABLE
    // milestone is the real gate (see checkpointFailureHalts). A real task failure, or any failure
    // on the terminal checkpoint, still halts (fail-closed). Flag-gated (default OFF).
    const isTerminalCp = ci === (checkpoints.length - 1);
    const taskHardFailed = cpResults.some(r => !(typeof r.step === 'string' && r.step.endsWith('.verify')) && r.success === false);
    const proceedPastFail = NONTERMINAL_MILESTONE_NONHALT && cpFailed
      && !checkpointFailureHalts({ isTerminal: isTerminalCp, taskFailure: taskHardFailed });
    if (proceedPastFail) {
      cpEnvelope.needs_review = true;   // tasks done; milestone unconfirmed here — flagged, not fatal
      log('WARN', `[checkpoint-executor] CP${cpNum} milestone unconfirmed but all tasks succeeded and this is NOT the deliverable checkpoint — proceeding (the terminal checkpoint's observable milestone is the gate); needs_review flagged`);
      log('INFO', `[TELEMETRY] nonterminal_milestone_nonhalt mission=${envelope.id} cp=${cpNum}`);
    }

    // Mark checkpoint complete or failed. A proceed-past (non-halting) milestone failure records
    // 'complete' so the spine advances and the terminal checkpoint can run + gate; the
    // needs_review flag and the pushed .verify result keep the caveat honest.
    cpEnvelope.status = (cpFailed && !proceedPastFail) ? 'failed' : 'complete';

    // C2: a failed milestone means this checkpoint's tasks must RE-RUN on the next
    // attempt — clear their step-ledger entries so the crash-resume dedup does not
    // replay a stale "complete" stub. That stub is exactly what looped the baton
    // deploy checkpoint: the real deploy result (with the staging URL) was replaced
    // by "[REPLAYED] Step already completed" (no URL), so cerebellum re-failed forever.
    // Mode-agnostic — a re-planned checkpoint in child-mission mode benefits identically.
    if (cpFailed && !proceedPastFail && STEP_LEDGER_ENABLED && envelope.step_ledger) {
      let _cleared = 0;
      for (const _k of Object.keys(envelope.step_ledger)) {
        if (envelope.step_ledger[_k] && envelope.step_ledger[_k].cp === cpNum) {
          delete envelope.step_ledger[_k];
          _cleared++;
        }
      }
      if (_cleared > 0) {
        log('INFO', `[checkpoint-executor] CP${cpNum} milestone failed — cleared ${_cleared} step-ledger entr${_cleared === 1 ? 'y' : 'ies'} so the re-attempt re-runs the task(s), not replays them`);
      }
    }

    // Record the verdict on the pinned spine. The executor is the only thing that
    // knows whether a milestone actually passed, so it owns this write — and it is
    // what stops a later checkpoint's failure from costing this one's verdict.
    if (SPINE_PINNING_ENABLED && Array.isArray(envelope._cp_spine)) {
      envelope._cp_spine = markCheckpoint(
        envelope._cp_spine, ci, (cpFailed && !proceedPastFail) ? 'failed' : 'complete',
        { now: new Date().toISOString() },
      );
      log('INFO', `[TELEMETRY] spine_status mission=${envelope.id} cp=${cpNum} status=${(cpFailed && !proceedPastFail) ? 'failed' : 'complete'}${proceedPastFail ? ' (milestone-unconfirmed, proceeding)' : ''} spine=${spineSummary(envelope._cp_spine)}`);
    }
    // Count only real task results, not the pushed cerebellum verdict pseudo-step (step
    // "N.verify") — otherwise a milestone-verification failure reads as a bogus task overflow
    // ("failed at task 3/2" for a 2-task checkpoint). Distinguish a task failure from a
    // milestone-verification failure so the message says what actually happened.
    const taskResultCount = cpResults.filter(r => !(typeof r.step === 'string' && r.step.endsWith('.verify'))).length;
    const verifyFailed = cpResults.some(r => typeof r.step === 'string' && r.step.endsWith('.verify') && !r.success);
    cpEnvelope.output = !cpFailed
      ? `Checkpoint complete: ${taskResultCount} tasks`
      : proceedPastFail
        ? `Checkpoint tasks complete (${taskResultCount} tasks); milestone unconfirmed in this workspace — proceeding, the deliverable checkpoint is the gate (needs_review)`
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

    if (cpFailed && !proceedPastFail) {
      planFailed = true;
      break;
    }
    // proceedPastFail: a non-terminal checkpoint's milestone was unconfirmed but its tasks all
    // succeeded — do NOT halt; fall through to the next checkpoint so the deliverable (terminal)
    // checkpoint runs and its observable milestone gates the mission.
  }

  // Clear progress
  if (CHECKPOINT_RESUME_ENABLED && !isPreStamped) {
    envelope._cp_progress = null;
    await firestoreWrite('work', envelope.id, envelope);
  }

  // ---- Baton hand-back: all my checkpoints are done, but I am not the originator ----
  // In the handoff model the originator owns the final synthesis + delivery, so a teammate that
  // finished the last assigned checkpoint returns the whole mission to the originator rather than
  // completing (and delivering) it here. The originator resumes, sees an all-complete spine, and
  // synthesizes. (Normally the plan's final checkpoint is the originator's, so this is a backstop.)
  if (HANDOFF_MODE && !planFailed && Array.isArray(envelope._cp_spine)) {
    const _me = AGENT_EMAIL || AGENT_ID;
    const _orig = missionOriginator(envelope);
    if (_orig && !sameAgent(_orig, _me)) {
      try { if (gitCommitAndSync) await gitCommitAndSync(envelope.id, envelope.project_id, 'baton: hand back to originator'); }
      catch (e) { log('WARN', `[baton] pre-handback sync failed (non-fatal): ${e.message}`); }
      Object.assign(envelope, handoffPatch(envelope, _orig, { now: Date.now(), leaseMs: HANDOFF_LEASE_MS }));
      envelope._cp_progress = null;
      await firestoreWrite('work', envelope.id, envelope);
      log('INFO', `[baton] hand-back mission=${envelope.id} -> originator ${_orig}`);
      log('INFO', `[TELEMETRY] baton_handback mission=${envelope.id} from=${_me} to=${_orig}`);
      return { paused: true, handedOff: true, to: _orig, results: allResults };
    }
  }

  return { success: !planFailed, results: allResults };
}
