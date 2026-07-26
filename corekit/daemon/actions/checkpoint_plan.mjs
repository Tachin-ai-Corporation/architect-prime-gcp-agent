// Action handler: checkpoint_plan
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTargetEmail } from '../../lib/delegation.mjs';
import {
  buildSpine, firstIncompleteIndex, applyReplan, rebuildFromSpine, spineSummary,
} from '../../lib/checkpoint-spine.mjs';
import { renderResources, repairIds, seedFromProse } from '../../lib/resource-ledger.mjs';

export async function handleCheckpointPlan(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const {
    log,
    toStr,
    callAgent,
    enforceSchema,
    formatSkillCatalog,
    SKILL_INDEX,
    CAPABILITY_MAP,
    extractCheckpoints,
    executeCheckpoints,
    PROCESSES,
    PROJECTS,
    addressFromMeta,
    summarizeForDelivery,
    smartSummarize,
    getAuthToken,
    FIRESTORE_BASE,
    PRIME_ID,
    AGENT_EMAIL,
    AGENT_ID,
    CORE_DIR,
    CTX_AGENT_STEP,
    CTX_DISPATCH_FAILURE,
    CONTRACTS,
    writeHistory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    generateId,
    REGISTRY,
    buildProjectContext,
  } = deps;

  // Delegation intercept: When cortex wraps a PURE single-target delegation
  // in checkpoint_plan (no mixed local+delegation tasks), redirect to delegate handler.
  // Multi-delegation plans (multiple targets or mixed tasks) proceed normally
  // through executeCheckpoints which handles type:"delegation" tasks natively.
  const delegGoal = decision.goal || decision.instruction || '';
  const delegConstraints = decision.constraints || '';

  // Build a searchable text blob from all relevant fields
  let fullText = `${delegGoal} ${delegConstraints}`.toLowerCase();
  const rawCheckpoints = decision.checkpoints || decision.plan?.checkpoints || [];
  for (const cp of rawCheckpoints) {
    fullText += ` ${(cp.label || cp.instruction || cp.title || '').toLowerCase()}`;
    for (const t of (cp.tasks || cp.steps || [])) {
      fullText += ` ${(t.instruction || t.task || t.description || '').toLowerCase()}`;
    }
  }

  const hasDelegateIntent = /\bdelegate\b/.test(fullText) || /\bdelegation\b/.test(fullText);
  const emailRegex = /[\w.-]+@[\w.-]+/g;

  // Count unique target emails across all tasks. Normalize every candidate —
  // the bare regex above captures trailing sentence punctuation
  // ("agent@example.com." at the end of a goal sentence), and normalization
  // also dedupes punctuated/clean variants of the same address.
  const allTargetEmails = new Set();
  const addTarget = (raw) => {
    const { email, valid } = normalizeTargetEmail(raw);
    if (valid) allTargetEmails.add(email);
  };
  let hasMixedTasks = false;
  for (const cp of rawCheckpoints) {
    for (const t of (cp.tasks || cp.steps || [])) {
      if (t.type === 'delegation' || t._step_type === 'delegation') {
        if (t.target_email) addTarget(t.target_email);
      } else {
        hasMixedTasks = true;  // Has non-delegation tasks too
      }
    }
  }
  // Also check decision-level target
  if (decision.target_email) addTarget(decision.target_email);

  // Extract emails from text if no explicit targets found
  if (allTargetEmails.size === 0) {
    const textEmails = fullText.match(emailRegex) || [];
    textEmails.forEach(addTarget);
  }

  // Only intercept for PURE single-target delegations (no mixed tasks, one target)
  const isPureSingleDelegation = hasDelegateIntent
    && allTargetEmails.size === 1
    && !hasMixedTasks
    && rawCheckpoints.every(cp => (cp.tasks || cp.steps || []).length <= 1);

  // Delegation is a fleet-only, project-scoped capability (skill.json roles).
  // Without the skill installed (e.g. on a Prime), never route into the
  // delegation pipeline — reject the plan with direct-operation guidance.
  const delegationInstalled = Array.isArray(SKILL_INDEX)
    && SKILL_INDEX.some(s => s.id === 'delegation');

  if (isPureSingleDelegation && !delegationInstalled) {
    log('WARN', 'Checkpoint plan delegation intercept: delegation skill not installed — rejecting delegation plan');
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] delegation is not available to this agent. Primes never delegate — operate the fleet directly instead: SSH into the agent VM (system-shell / gcp-admin), read its work with the work-log tools, test or upgrade it (fleet-verify, fleet-upgrade), or do the work locally with checkpoint_plan.' }]
    };
  }

  if (isPureSingleDelegation) {
    const extractedEmail = [...allTargetEmails][0];
    log('INFO', `Checkpoint plan delegation intercept: redirecting to delegate action (target=${extractedEmail})`);

    decision.action = 'delegate';
    decision.target_email = extractedEmail;
    decision.instruction = decision.instruction || delegGoal
      || rawCheckpoints[0]?.tasks?.[0]?.instruction
      || rawCheckpoints[0]?.tasks?.[0]?.task
      || rawCheckpoints[0]?.label || '';
    decision.accept_criteria = decision.accept_criteria
      || rawCheckpoints[0]?.tasks?.[0]?.accept_criteria || '';

    return { delegateAction: 'delegate' };
  }

  // Multi-delegation plans: log and proceed through normal checkpoint execution
  if (hasDelegateIntent && allTargetEmails.size > 1) {
    log('INFO', `Checkpoint plan: multi-delegation detected (${allTargetEmails.size} targets: ${[...allTargetEmails].join(', ')}). Proceeding with normal checkpoint execution.`);
  }

  // ---- Pinned spine: is this a RE-plan of a mission we already shaped? ----
  // A checkpoint failure should re-plan that checkpoint, not the mission. Without
  // this, a CP2 failure discarded the whole plan and re-ran a CP1 that had passed
  // twenty seconds earlier — one real mission spent 1.11M input tokens that way.
  // Outcomes are stable in practice (four observed missions never changed them);
  // task lists are not. So the outcomes+criteria are pinned and only the failed
  // checkpoint's tasks are re-derived.
  const SPINE_ENABLED = CONTRACTS?.dispatch?.spine_pinning_enabled !== false;
  const PIN_CRITERIA = CONTRACTS?.dispatch?.criteria_pinning_enabled !== false;
  const MAX_CRITERIA_REV = CONTRACTS?.dispatch?.max_criteria_revisions ?? 1;
  const existingSpine = Array.isArray(envelope._cp_spine) ? envelope._cp_spine : null;
  const scopedIdx = (SPINE_ENABLED && existingSpine) ? firstIncompleteIndex(existingSpine) : -1;
  const isScopedReplan = scopedIdx >= 0 && scopedIdx < (existingSpine?.length || 0);

  // Cortex can demand a full re-shape (it judged the goal itself mis-framed). Rare,
  // and loud — never the reflex response to a checkpoint failing.
  const forceFullReplan = decision.replan_scope === 'mission' || decision.replan_full === true;
  if (SPINE_ENABLED && existingSpine && forceFullReplan) {
    log('WARN', `[TELEMETRY] spine_replaced mission=${envelope.id} reason=${decision.replan_reason || 'cortex requested mission-scope re-plan'} prior=${spineSummary(existingSpine)}`);
    envelope._cp_spine = null;
  }

  // ---- Known identifiers, carried to the PLANNER ----
  // The ledger reached the executing organ but never the organ that WRITES the ids.
  // A planner with no verified id types one out, and a single wrong character becomes
  // a task that fails identically on every retry — then the spine pins it. That is
  // exactly how one mission died: the ledger held the master template's id, read back
  // from a Drive listing, while the pinned task carried the same id with one character
  // different. Seeding first matters as much as rendering: the seed used to run inside
  // the executor, i.e. AFTER planning, so the first plan — the one that introduces the
  // typo — saw an empty ledger even when the operator had stated the ids outright.
  const LEDGER_ENABLED = CONTRACTS?.memory?.resource_ledger?.enabled !== false;
  const LEDGER_MAX = CONTRACTS?.memory?.resource_ledger?.max_entries ?? 200;
  const LEDGER_LIMIT = CONTRACTS?.memory?.resource_ledger?.recall_limit ?? 40;
  let plannerResources = '';
  if (LEDGER_ENABLED) {
    try {
      const seedText = [envelope.instruction, envelope.source_text, envelope.context_summary]
        .filter(Boolean).map(toStr).join('\n');
      envelope.context = envelope.context || {};
      const { ledger, added, updated } = seedFromProse(
        envelope.context.resources, seedText,
        { max: LEDGER_MAX, now: new Date().toISOString(), source: 'request' },
      );
      envelope.context.resources = ledger;
      if (added || updated) {
        log('INFO', `[TELEMETRY] resource_ledger mission=${envelope.id} step=plan added=${added} updated=${updated} total=${Object.keys(ledger).length}`);
      }
      plannerResources = renderResources(ledger, {
        limit: LEDGER_LIMIT,
        cues: String(decision.goal || decision.instruction || envelope.instruction || '')
          .toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3),
      });
    } catch (e) {
      log('WARN', `Planner resource block failed: ${e.message}`);
    }
  }
  const PLANNER_ID_RULE = plannerResources
    ? `${plannerResources}\nEvery id above was read back from a tool result. When a task needs one of these resources, COPY the id from this block character for character. Never retype one from memory or from an earlier task, and never invent one — if a resource you need is not listed, name it and let the executing organ resolve it.`
    : '';

  // ---- Deterministic id repair, applied to every plan before anything pins it ----
  // Telling a planner to copy ids carefully does not work: one observed plan copied
  // three ids out of the ledger block in its own prompt and got one wrong by a single
  // character. That is enough to fail its checkpoint identically on every retry, and
  // the spine then pins it. Transcription accuracy is not something a prompt can fix,
  // so the daemon fixes it instead (C-4) — timidly: only a unique edit-distance-1 hit
  // against a known id is a typo; anything else is left alone and logged.
  const repairPlan = (cps, where) => {
    if (!LEDGER_ENABLED || !Array.isArray(cps) || cps.length === 0) return;
    const ledger = envelope.context?.resources;
    if (!ledger || Object.keys(ledger).length === 0) return;
    const allRepairs = [];
    const allUnknown = [];
    const fix = (obj, field) => {
      if (typeof obj?.[field] !== 'string' || !obj[field]) return;
      const { text, repairs, unknown } = repairIds(obj[field], ledger);
      if (repairs.length > 0) obj[field] = text;
      allRepairs.push(...repairs);
      for (const u of unknown) if (!allUnknown.includes(u)) allUnknown.push(u);
    };
    for (const cp of cps) {
      fix(cp, 'instruction');
      fix(cp, 'accept_criteria');
      for (const t of (cp.tasks || [])) {
        fix(t, 'task');
        fix(t, 'instruction');
        fix(t, 'accept_criteria');
      }
    }
    for (const r of allRepairs) {
      log('WARN', `[TELEMETRY] id_repair mission=${envelope.id} at=${where} kind=${r.kind} name="${r.name}" from=${r.from} to=${r.to}`);
    }
    // Not an error — an id the ledger has not captured is often perfectly real. It is
    // logged because a hallucinated id looks exactly like this too, and the difference
    // only shows up as a tool failure later.
    if (allUnknown.length > 0) {
      log('INFO', `[TELEMETRY] id_unverified mission=${envelope.id} at=${where} count=${allUnknown.length} ids=${allUnknown.slice(0, 5).join(',')}`);
    }
  };

  // Try cortex-provided inline structure first
  let checkpoints = extractCheckpoints(decision);
  repairPlan(checkpoints, 'cortex_inline');
  // Track the source where it is DECIDED, not by inspecting decision.checkpoints
  // afterwards: cortex often emits a `checkpoints` key that fails extraction or
  // agent validation, so the key's mere presence proved nothing and every
  // prefrontal-structured re-plan was mislabeled `cortex_inline` in telemetry —
  // exactly the data we use to judge plan quality.
  let planSource = (checkpoints && checkpoints.length > 0) ? 'cortex_inline' : 'none';

  // Validate agent types for inline checkpoints
  if (checkpoints && checkpoints.length > 0) {
    const validAgents = ['motor', 'temporal-research', 'temporal-memory'];
    let hasInvalidAgent = false;
    for (const cp of checkpoints) {
      for (const t of cp.tasks) {
        // Delegation tasks may specify the delegate specialty as agent — allow them through
        if (t.type === 'delegation' || t._step_type === 'delegation') continue;
        if (!validAgents.includes(t.agent)) {
          log('WARN', `Checkpoint plan: Cortex inline plan contains invalid agent '${t.agent}'. Rejecting inline plan to force prefrontal structuring.`);
          hasInvalidAgent = true;
          break;
        }
      }
      if (hasInvalidAgent) break;
    }
    if (hasInvalidAgent) {
      checkpoints = null;
      planSource = 'none';
    }
  }

  // B-28: Irreversibility guard — warn when destructive_or_public parts lack approval gates
  if (checkpoints && checkpoints.length > 0 && envelope._brief?.parts) {
    const destructiveParts = envelope._brief.parts.filter(p => p.risk === 'destructive_or_public');
    if (destructiveParts.length > 0) {
      const hasApprovalGate = checkpoints.some(cp =>
        (cp.tasks || []).some(t => t.step_type === 'approval_gate' || t._step_type === 'approval_gate')
      );
      if (!hasApprovalGate) {
        log('WARN', `[checkpoint_plan] Irreversibility guard: ${destructiveParts.length} destructive_or_public part(s) but no approval_gate in plan`);
        // Inject warning as prior result so cortex sees it on next iteration
        return {
          continue: true,
          priorResultsAppend: [{
            agent: 'system',
            result: `[IRREVERSIBILITY WARNING] The Brief contains ${destructiveParts.length} destructive_or_public part(s) (${destructiveParts.map(p => p.id).join(', ')}) but the plan has no approval_gate step. Add an approval_gate or re-plan with explicit operator confirmation before destructive actions.`,
          }],
        };
      }
    }
  }

  // ---- Plan-Process alignment: nudge prefrontal toward existing processes ----
  let processMatchHint = '';
  if (PROCESSES && Object.keys(PROCESSES).length > 0) {
    const planGoalText = (decision.goal || decision.instruction || decision.reasoning || envelope.instruction || '').toLowerCase();
    const matchingProcesses = Object.values(PROCESSES).filter(p => {
      if (p.status === 'deprecated') return false;
      const keywords = p.intent_keywords || [];
      return keywords.some(kw => planGoalText.includes(kw.toLowerCase()));
    });
    if (matchingProcesses.length > 0) {
      log('INFO', `[checkpoint_plan] Process match: found ${matchingProcesses.length} matching process(es): ${matchingProcesses.map(p => p.id).join(', ')}`);
      processMatchHint = `\n\n[EXISTING PROCESSES] The following processes may cover this work:\n${matchingProcesses.map(p => `- ${p.id}: ${p.name} (${(p.steps || []).length} steps) — ${(p.description || '').substring(0, 150)}`).join('\n')}\nConsider using follow_process to invoke these rather than re-inventing their steps. If you use checkpoint_plan, incorporate the process steps.`;
    }
  }

  // Wrap callAgent to accumulate token usage telemetry locally. Defined HERE,
  // before the first dispatch: the plan-structuring call below used raw callAgent
  // and so escaped accounting entirely — its tokens never reached _tokenUsage and
  // no llm_usage line was emitted, which silently under-reported mission_total.
  const dispatchAgent = async (agentId, payload) => {
    const res = await callAgent(agentId, payload);
    if (res?.usage) {
      const u = res.usage;
      _tokenUsage.totalInput += (u.promptTokenCount || u.input_tokens || 0);
      _tokenUsage.totalOutput += (u.candidatesTokenCount || u.output_tokens || 0);
      _tokenUsage.totalCached += (u.cachedContentTokenCount || 0);
      _tokenUsage.totalCacheWrites += (u.cacheCreationTokenCount || 0);
      _tokenUsage.callCount++;
      log('INFO', `[TELEMETRY] llm_usage mission=${envelope.id} organ=${agentId} model=${REGISTRY.agents?.[agentId]?.route || agentId} input=${u.promptTokenCount || u.input_tokens || 0} output=${u.candidatesTokenCount || u.output_tokens || 0} cached=${u.cachedContentTokenCount || 0} cache_write=${u.cacheCreationTokenCount || 0} duration=${res.durationMs || 0}ms`);
    }
    return res;
  };

  // ---- Scoped re-plan: re-task ONE checkpoint against its pinned outcome ----
  // Runs before the full-structuring path below and, on success, replaces it: the
  // rebuilt plan keeps every completed verdict and every untouched checkpoint.
  let spineScope = 'mission';
  let startCpIndexOverride = 0;
  // Evidence from checkpoints that already PASSED, carried into the resumed run.
  // A scoped re-plan starts execution past them, so without this their results are
  // gone and the next checkpoint's verifier judges its criteria with no sight of the
  // work that satisfied the earlier ones — which is how a milestone came to FAIL for
  // "folder ids are identified" one round after its own prior verdict had quoted them.
  let bankedResults = [];
  if (SPINE_ENABLED && isScopedReplan && !forceFullReplan) {
    const target = existingSpine[scopedIdx];
    log('INFO', `Checkpoint plan: SCOPED re-plan of CP${target.n} only (spine ${spineSummary(existingSpine)}) — completed checkpoints keep their verdicts`);
    try {
      let skillDoc = '';
      try {
        skillDoc = fs.readFileSync(path.join(CORE_DIR, 'skills', 'plan-structuring', 'SKILL.md'), 'utf8');
      } catch { /* the skill is advisory here; proceed without it */ }

      const failureNote = (priorResults || [])
        .filter(r => typeof r.result === 'string' && r.result.includes('[CHECKPOINT VERIFICATION FAILED]'))
        .slice(-1)[0]?.result || decision.failure_summary || '';

      const scoped = await dispatchAgent('prefrontal', {
        instruction: [
          '[PLAN STRUCTURING — SINGLE CHECKPOINT]',
          'Structure the TASKS for exactly one checkpoint. Do not re-plan the mission and do',
          'not restate the other checkpoints — they are already decided.',
          '',
          skillDoc ? `## Plan Structuring Skill Instructions\n${skillDoc}` : '',
          '',
          `## Brain Capability Map (plan by outcome; the executing organ picks its own skills)\n${CAPABILITY_MAP}`,
          '',
          `## Checkpoint ${target.n} — outcome (FIXED, do not reword)`,
          target.outcome,
          '',
          '## Acceptance criteria (FIXED — plan tasks that satisfy these as written)',
          target.accept_criteria || '(none stated)',
          '',
          // Framed as a checklist, not a narrative. The verifier reports one bullet per
          // unmet clause; a real re-plan read a two-clause FAIL and produced tasks for
          // one clause only, dropping "the draft doc ids are identified". The criteria
          // are pinned, so a checkpoint re-tasked against half of them cannot ever pass
          // — it failed three times on the same missing half.
          failureNote ? [
            '## Clauses the verifier found UNMET — every one needs a task',
            failureNote,
            '',
            'Treat the above as a checklist. Read the pinned criteria clause by clause and',
            'make sure your task list addresses EVERY unmet clause, not only the one that',
            'looks easiest or most recent. A checkpoint is judged against all of its',
            'criteria at once: leaving one clause untasked guarantees another failure.',
          ].join('\n') : '',
          '',
          // Verified ids go IMMEDIATELY before the failed-task list, because that list
          // is where a bad id gets copied from: the re-plan shows prefrontal its own
          // previous tasks, so a typo'd id is re-copied every round and the checkpoint
          // fails the same way forever.
          PLANNER_ID_RULE,
          '',
          '## Tasks that were tried and did not get there',
          (target.tasks || []).map(t => `- ${toStr(t.task || t.instruction || '')}`).join('\n') || '(none)',
          'Any identifier appearing in that list is SUSPECT — it did not work. Take ids from the block above, not from these tasks.',
          '',
          'Return a plan whose checkpoints array contains EXACTLY ONE checkpoint: this one.',
        ].filter(Boolean).join('\n'),
        _missionId: envelope.id,
        _sourceMeta: envelope.source_meta || envelope._sourceMeta || null,
        _projectContext: envelope._projectContext || null,
        _sourceText: envelope.source_text || envelope._sourceText || null,
      });

      let newCps = null;
      if (scoped.success && scoped.output) {
        // Repaired BEFORE applyReplan, or the typo lands in the spine and is re-served
        // to the planner as its own prior work on every subsequent round.
        try {
          newCps = extractCheckpoints(await enforceSchema(scoped.output, 'plan'));
          repairPlan(newCps, `scoped_cp${target.n}`);
        }
        catch (e) { log('WARN', `Scoped re-plan schema/parse failed: ${e.message}`); }
      }
      const newTasks = newCps?.[0]?.tasks || [];
      if (newTasks.length > 0) {
        const { spine, criteriaChanged, revisionRefused } = applyReplan(
          existingSpine, scopedIdx, newTasks,
          {
            newCriteria: newCps[0].accept_criteria,
            pinCriteria: PIN_CRITERIA,
            maxCriteriaRevisions: MAX_CRITERIA_REV,
            now: new Date().toISOString(),
          },
        );
        envelope._cp_spine = spine;
        const rebuilt = rebuildFromSpine(spine);
        checkpoints = rebuilt.checkpoints;
        startCpIndexOverride = rebuilt.startCpIndex;
        planSource = 'prefrontal';
        spineScope = 'checkpoint';

        // Keep the results of the checkpoints we are skipping past. Step ids are
        // "<cp>.<task>" (and "<cp>.verify"), so the leading number selects them.
        const doneCps = new Set(
          spine.filter(s => s.status === 'complete').map(s => String(s.n)),
        );
        if (doneCps.size > 0) {
          const prior = envelope._cp_progress?.allResults;
          bankedResults = (Array.isArray(prior) ? prior : [])
            .filter(r => doneCps.has(String(r?.step || '').split('.')[0]));
          log('INFO', `Scoped re-plan: banking ${bankedResults.length} result(s) from ${doneCps.size} completed checkpoint(s)`);
        }
        log('INFO', `Scoped re-plan: CP${target.n} re-tasked (${newTasks.length} tasks), resuming at CP${rebuilt.startCpIndex + 1} of ${spine.length}${criteriaChanged ? ' [criteria refined]' : ''}${revisionRefused ? ' [further criteria rewording refused — pinned wording holds]' : ''}`);
      } else {
        log('WARN', 'Scoped re-plan produced no tasks — falling back to full mission structuring');
      }
    } catch (e) {
      log('WARN', `Scoped re-plan dispatch failed: ${e.message} — falling back to full structuring`);
    }
  }

  // CP4: If cortex didn't provide a valid structure, dispatch to prefrontal
  if (!checkpoints || checkpoints.length === 0) {
    const planGoal = decision.goal || decision.instruction || decision.reasoning || envelope.instruction;
    log('INFO', `Checkpoint plan: no valid inline structure — dispatching to prefrontal for structuring`);

    try {
      let skillDoc = '';
      try {
        skillDoc = fs.readFileSync(path.join(CORE_DIR, 'skills', 'plan-structuring', 'SKILL.md'), 'utf8');
      } catch (err) {
        log('WARN', `Failed to read plan-structuring SKILL.md: ${err.message}`);
      }

      // Stable content FIRST, volatile content LAST. The skill doc and capability
      // map are byte-identical on every structuring call; the goal and prior
      // results change every time. Any stable text placed after volatile text is
      // uncacheable by construction — the capability map used to sit below the
      // goal, so it could never join a cached prefix. Ordering is the whole fix
      // (same principle as the boot/mission/volatile tiers in prompt-blocks).
      const planResult = await dispatchAgent('prefrontal', {
        instruction: [
          '[PLAN STRUCTURING]',
          'Structure a checkpoint/task plan for the goal using the provided plan-structuring skill instructions.',
          '',
          skillDoc ? `## Plan Structuring Skill Instructions\n${skillDoc}` : '',
          '',
          `## Brain Capability Map (plan by outcome; the executing organ picks its own skills — never name a skill/tool here)\n${CAPABILITY_MAP}`,
          '',
          '## Goal',
          planGoal,
          '',
          envelope._brief ? `## Brief\n${JSON.stringify(envelope._brief)}` : '',
          '',
          // Volatile tail, deliberately: the ledger grows during a mission, so placing
          // it above the skill doc / capability map would break the cacheable stable
          // prefix those two provide (MR-4a).
          PLANNER_ID_RULE,
          '',
          processMatchHint || '',  // Process match hint if any
          '',
          decision.constraints ? `## Constraints\n${decision.constraints}` : '',
          priorResults.length > 0 ? `## Prior Results\n${priorResults.map(r =>
            `${r.step || r.agent}: ${(toStr(r.result) || '').substring(0, 200)}`
          ).join('\n')}` : '',
        ].filter(Boolean).join('\n'),
        _missionId: envelope.id,
        _sourceMeta: envelope.source_meta || envelope._sourceMeta || null,
        _projectContext: envelope._projectContext || null,
        _sourceText: envelope.source_text || envelope._sourceText || null,
      });

      if (planResult.success && planResult.output) {
        try {
          const planParsed = await enforceSchema(planResult.output, 'plan');
          checkpoints = extractCheckpoints(planParsed);
          repairPlan(checkpoints, 'prefrontal_mission');
          if (checkpoints && checkpoints.length > 0) {
            planSource = 'prefrontal';
            log('INFO', `Prefrontal structured ${checkpoints.length} checkpoints, ${checkpoints.reduce((s, c) => s + c.tasks.length, 0)} total tasks`);
          }
        } catch (e) {
          log('WARN', `Prefrontal plan structuring schema enforcement/parse failed: ${e.message}`);
        }
      }
    } catch (e) {
      log('WARN', `Prefrontal plan structuring dispatch failed: ${e.message}`);
    }
  }

  // First plan for this mission — pin the spine so later failures re-task instead of
  // re-shaping. Outcomes and criteria are captured here and held from now on.
  if (SPINE_ENABLED && !Array.isArray(envelope._cp_spine) && checkpoints?.length > 0) {
    envelope._cp_spine = buildSpine(checkpoints, { now: new Date().toISOString() });
    log('INFO', `Checkpoint spine pinned: ${spineSummary(envelope._cp_spine)}`);
  }

  // Telemetry: plan structuring source (assigned at the branch that produced it)
  log('INFO', `[TELEMETRY] plan_structuring: ${JSON.stringify({
    source: planSource,
    scope: spineScope,
    spine_reused: spineScope === 'checkpoint',
    checkpoints: checkpoints?.length || 0,
    tasks: checkpoints?.reduce((s, c) => s + c.tasks.length, 0) || 0,
    missionId: envelope.id,
  })}`);

  if (!checkpoints || checkpoints.length === 0) {
    log('ERROR', `Checkpoint plan has no valid checkpoints (even after prefrontal structuring)`);
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] checkpoint_plan failed to produce a valid plan structure. Try follow_process instead, or provide checkpoints with at least one task per checkpoint.' }]
    };
  }

  log('INFO', `Checkpoint plan received: ${checkpoints.length} checkpoints`);

  // Run! (dispatchAgent — the usage-accounting wrapper — is defined above, so the
  // plan-structuring call and every task dispatch share one accounting path.)
  const execResult = await executeCheckpoints(checkpoints, {
    dispatchAgent,
    envelope,
    log,
    writeHistory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    generateId,
    contracts: CONTRACTS,
    skillIndex: formatSkillCatalog(SKILL_INDEX),
    delegationEnabled: delegationInstalled,
    PROJECTS,
    addressFromMeta,
    summarizeForDelivery,
    smartSummarize,
    getAuthToken,
    FIRESTORE_BASE,
    PRIME_ID,
    AGENT_EMAIL,
    AGENT_ID,
    CORE_DIR,
    CTX_AGENT_STEP,
    CTX_DISPATCH_FAILURE,
    // On a scoped re-plan, start past the checkpoints that already passed. This is
    // the mechanism that stops a passed CP1 being re-run when CP2 fails — the
    // executor already supported it; nothing was ever telling it where to resume.
    startCpIndex: startCpIndexOverride,
    startTaskIndex: 0,
    savedResults: bankedResults,
    buildProjectContext,
  });

  if (execResult.paused) {
    return { exit: true };
  }

  const allResults = execResult.results;
  const planFailed = !execResult.success;

  // Feed all results back to Cortex for synthesis
  const priorResultsAppend = allResults.map(r => ({
    agent: r.agent,
    task: r.task,
    result: r.result,
    // ORGAN_CONTEXT_SHARING_PLAN Phase 1: carry the resource packet so the cortex delta can
    // show a shape-aware summary + ref instead of a blind clip of `result`.
    summary: r.summary,
    ref: r.ref,
    bytes: r.bytes,
    shape: r.shape,
    success: r.success,
    durationMs: r.durationMs,
    checkpoint_step: r.step,
    failure_type: !r.success
      ? (typeof r.result === 'string' && (r.result.includes('Command failed') || r.result.includes('[ERROR]'))
         ? 'tool_error' : 'quality_rejection')
      : null,
  }));

  if (planFailed) {
    const replanCount = (envelope._replan_count = (envelope._replan_count || 0) + 1);
    const MAX_REPLANS = 3;
    if (replanCount >= MAX_REPLANS) {
      priorResultsAppend.push({
        agent: 'system',
        result: `[SYSTEM] Checkpoint plan failed ${replanCount} times. You MUST use "synthesize_with_failure" or "needs_input" to escalate. No more checkpoint_plan allowed.`,
      });
    } else {
      priorResultsAppend.push({
        agent: 'system',
        result: `[SYSTEM] Checkpoint failed (attempt ${replanCount}/${MAX_REPLANS}). Do NOT decompose the work into finer or tool-level steps — the executor owns the HOW and makes many tool calls per task. Work already completed successfully in prior_results is DONE — do NOT re-plan or repeat it (re-reading, re-editing, or re-verifying an outcome that already succeeded is wasted churn); re-plan ONLY the specific part that still needs to change. Re-plan to fix the OUTCOME framing or a bad input: clarify what the task must achieve, correct a wrong assumption, or supply a missing input, and keep tasks coarse and outcome-shaped. A specific failing tool or command is the executor's to resolve inside its task, not a reason to add planning steps. Otherwise use "needs_input" to escalate a hard blocker.`,
      });
    }
  }

  // Dedup spin guard: if ALL tasks were replayed (no new work done),
  // cortex is looping with redundant plans. Force synthesize.
  const allReplayed = allResults.length > 0 && allResults.every(r =>
    typeof r.result === 'string' && r.result.startsWith('[REPLAYED]')
  );
  if (allReplayed && !planFailed) {
    log('WARN', `[checkpoint-executor] All ${allResults.length} tasks were deduped (replayed). Forcing synthesize.`);
    priorResultsAppend.push({
      agent: 'system',
      result: `[SYSTEM] All checkpoint tasks were already completed in previous iterations — no new work was done. You MUST "synthesize" your answer now using the results already gathered. Do NOT create another checkpoint_plan.`,
    });
  }

  log('INFO', `Checkpoint plan ${planFailed ? 'FAILED' : 'complete'}: ${checkpoints.length} checkpoints, ${allResults.length} total tasks. Consulting Cortex.`);

  // Return guard as part of action result so the main decide loop enforces it
  const result = { continue: true, priorResultsAppend };
  if (allReplayed && !planFailed) {
    result.activeGuard = { forbidden: 'checkpoint_plan', fallback: 'synthesize', injectedAt: iteration, context: {} };
  }
  return result;
}
