// Action handler: checkpoint_plan
import fs from 'node:fs';
import path from 'node:path';

export async function handleCheckpointPlan(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const {
    log,
    toStr,
    callAgent,
    enforceSchema,
    formatSkillCatalog,
    SKILL_INDEX,
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

  // Count unique target emails across all tasks
  const allTargetEmails = new Set();
  let hasMixedTasks = false;
  for (const cp of rawCheckpoints) {
    for (const t of (cp.tasks || cp.steps || [])) {
      if (t.type === 'delegation' || t._step_type === 'delegation') {
        if (t.target_email) allTargetEmails.add(t.target_email);
      } else {
        hasMixedTasks = true;  // Has non-delegation tasks too
      }
    }
  }
  // Also check decision-level target
  if (decision.target_email) allTargetEmails.add(decision.target_email);

  // Extract emails from text if no explicit targets found
  if (allTargetEmails.size === 0) {
    const textEmails = fullText.match(emailRegex) || [];
    textEmails.forEach(e => allTargetEmails.add(e));
  }

  // Only intercept for PURE single-target delegations (no mixed tasks, one target)
  const isPureSingleDelegation = hasDelegateIntent
    && allTargetEmails.size === 1
    && !hasMixedTasks
    && rawCheckpoints.every(cp => (cp.tasks || cp.steps || []).length <= 1);

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

  // Try cortex-provided inline structure first
  let checkpoints = extractCheckpoints(decision);

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

      const planResult = await callAgent('prefrontal', {
        instruction: [
          '[PLAN STRUCTURING]',
          'Structure a checkpoint/task plan for the goal using the provided plan-structuring skill instructions.',
          '',
          skillDoc ? `## Plan Structuring Skill Instructions\n${skillDoc}` : '',
          '',
          '## Goal',
          planGoal,
          '',
          envelope._brief ? `## Brief\n${JSON.stringify(envelope._brief)}` : '',
          '',
          `## Skill Index\n${formatSkillCatalog(SKILL_INDEX)}`,
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
          if (checkpoints && checkpoints.length > 0) {
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

  // Telemetry: plan structuring source
  const planSource = checkpoints ? (decision.checkpoints ? 'cortex_inline' : 'prefrontal') : 'none';
  log('INFO', `[TELEMETRY] plan_structuring: ${JSON.stringify({
    source: planSource,
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

  // Wrap callAgent to accumulate token usage telemetry locally
  const dispatchAgent = async (agentId, payload) => {
    const res = await callAgent(agentId, payload);
    if (res?.usage) {
      const u = res.usage;
      _tokenUsage.totalInput += (u.promptTokenCount || u.input_tokens || 0);
      _tokenUsage.totalOutput += (u.candidatesTokenCount || u.output_tokens || 0);
      _tokenUsage.totalCached += (u.cachedContentTokenCount || 0);
      _tokenUsage.callCount++;
      log('INFO', `[TELEMETRY] llm_usage mission=${envelope.id} organ=${agentId} model=${REGISTRY.agents?.[agentId]?.route || agentId} input=${u.promptTokenCount || u.input_tokens || 0} output=${u.candidatesTokenCount || u.output_tokens || 0} cached=${u.cachedContentTokenCount || 0} duration=${res.durationMs || 0}ms`);
    }
    return res;
  };

  // Run!
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
    startCpIndex: 0,
    startTaskIndex: 0,
    savedResults: [],
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
        result: `[SYSTEM] Checkpoint failed (attempt ${replanCount}/${MAX_REPLANS}). Return a NEW checkpoint_plan with adjusted approach, or use "needs_input" to escalate a hard blocker.`,
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
