// Action handler: checkpoint_plan
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

  // Try cortex-provided inline structure first
  let checkpoints = extractCheckpoints(decision);

  // CP4: If cortex didn't provide a valid structure, dispatch to prefrontal
  if (!checkpoints || checkpoints.length === 0) {
    const planGoal = decision.goal || decision.instruction || decision.reasoning || envelope.instruction;
    log('INFO', `Checkpoint plan: no valid inline structure — dispatching to prefrontal for structuring`);

    try {
      const planResult = await callAgent('prefrontal', {
        instruction: [
          '[PLAN STRUCTURING]',
          'Read the plan-structuring SKILL.md, then structure a checkpoint/task plan for this goal.',
          '',
          '## Goal',
          planGoal,
          '',
          envelope._brief ? `## Brief\n${JSON.stringify(envelope._brief)}` : '',
          '',
          `## Skill Index\n${formatSkillCatalog(SKILL_INDEX)}`,
          '',
          decision.constraints ? `## Constraints\n${decision.constraints}` : '',
          priorResults.length > 0 ? `## Prior Results\n${priorResults.map(r =>
            `${r.step || r.agent}: ${(toStr(r.result) || '').substring(0, 200)}`
          ).join('\n')}` : '',
        ].filter(Boolean).join('\n'),
        _missionId: envelope.id,
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

  log('INFO', `Checkpoint plan ${planFailed ? 'FAILED' : 'complete'}: ${checkpoints.length} checkpoints, ${allResults.length} total tasks. Consulting Cortex.`);

  return { continue: true, priorResultsAppend };
}
