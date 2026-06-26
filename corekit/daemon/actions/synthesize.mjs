// Action handler: synthesize

export async function handleSynthesize(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const { log, createCT, completeEnvelope, MAX_ITERATIONS } = deps;

  // Check for unresolved failures — block premature success synthesis
  const lastSuccessIdx = priorResults.map((r, i) => r.success === true ? i : -1).filter(i => i >= 0).pop() ?? -1;
  const hasUnresolvedFail = priorResults.some((r, i) => r.success === false && !r.timedOut && i > lastSuccessIdx);
  if (hasUnresolvedFail && iteration < MAX_ITERATIONS - 1) {
    log('WARN', `Blocking premature synthesize — unresolved hard failures in prior_results (iteration ${iteration})`);
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] Synthesize blocked: there are unresolved failures in prior_results. You MUST either: (1) dispatch to investigate/fix the failure, or (2) use "synthesize_with_failure" action with explicit failure details. Plain "synthesize" is not allowed when tasks have failed.`,
      }],
      activeGuard: { forbidden: 'synthesize', fallback: 'checkpoint_plan', injectedAt: iteration },
    };
  }

  // Wrap synthesis in C→T under the mission
  const synthesisOutput = decision.synthesis || decision.content || decision.response || decision.message || decision.instruction || '';
  await createCT(envelope, {
    checkpointTitle: 'Formulate response',
    taskTitle: 'Synthesize answer',
    taskOutput: synthesisOutput,
    taskIntent: 'synthesize',
    deliveryStatus: 'internal',
    ctKey: `synth-${envelope.id}-${iteration}`,
  });

  envelope.output = synthesisOutput;
  await completeEnvelope(envelope, {
    status: 'complete',
    output: synthesisOutput,
    historyDetail: 'Synthesized response',
    tokenUsage: _tokenUsage,
  });

  // ---- Post-completion learning loops (non-blocking) ----
  // These run AFTER the mission is complete. Failures are logged but don't affect delivery.
  try {
    await postCompletionLearning(envelope, priorResults, synthesisOutput, deps);
  } catch (e) {
    log('WARN', `Post-completion learning failed (non-blocking): ${e.message}`);
  }

  return { exit: true };
}

/**
 * Post-completion learning: processify + context extraction.
 * Runs after successful mission synthesis. Non-blocking — errors are swallowed.
 */
async function postCompletionLearning(envelope, priorResults, synthesisOutput, deps) {
  const { log, callAgent, enforceSchema, PROCESSES, PROJECTS, firestoreWrite, firestoreQuery,
          PRIME_ID, CORE_DIR, getAuthToken, FIRESTORE_BASE } = deps;

  // Guard: only run for M-type missions with a project, with 2+ checkpoints
  if (envelope.type !== 'M') return;
  if (!envelope.project_id) return;

  // Count child checkpoints — need at least 2 for a meaningful workflow
  const childCount = (envelope.children || []).length;
  if (childCount < 2) return;

  // Guard: skip process-driven missions (already followed a process)
  const isProcessDriven = !!envelope.process_id;

  // Build a summary of what this mission did
  const workSummary = priorResults
    .filter(r => r.agent && r.agent !== 'system')
    .map(r => `[${r.agent}${r.checkpoint_step ? ` CP${r.checkpoint_step}` : ''}]: ${r.success ? '✅' : '❌'} ${(r.result || '').substring(0, 300)}`)
    .join('\n');

  // ---- Phase 2.1: Processify — create process from successful novel work ----
  if (!isProcessDriven) {
    await tryProcessify(envelope, workSummary, priorResults, deps);
  }

  // ---- Phase 5.2: Context extraction — mine project facts from mission output ----
  await tryContextExtraction(envelope, synthesisOutput, workSummary, deps);
}

/**
 * Phase 2.1: Evaluate whether a completed mission represents a repeatable workflow.
 * If yes, create a new process definition in Firestore and link it to the project.
 */
async function tryProcessify(envelope, workSummary, priorResults, deps) {
  const { log, callAgent, enforceSchema, PROCESSES, firestoreWrite, PRIME_ID } = deps;

  try {
    // Check if a similar process already exists (by instruction keyword match)
    const instruction = (envelope.instruction || '').toLowerCase();
    const hasMatchingProcess = Object.values(PROCESSES).some(p => {
      if (p.status === 'deprecated') return false;
      return (p.intent_keywords || []).some(kw => instruction.includes(kw.toLowerCase()));
    });
    if (hasMatchingProcess) {
      log('INFO', `[processify] Skipping — matching process already exists for instruction`);
      return;
    }

    // Ask Flash to evaluate processify potential
    const evalResult = await callAgent('cortex', {
      instruction: [
        '[PROCESSIFY EVALUATION]',
        'Analyze this completed mission and determine if it represents a repeatable workflow.',
        '',
        '## Mission',
        `Instruction: ${envelope.instruction || ''}`,
        `Project: ${envelope.project_id}`,
        `Checkpoints completed: ${(envelope.children || []).length}`,
        '',
        '## Work Summary',
        workSummary.substring(0, 3000),
        '',
        '## Evaluation Criteria',
        '- Did the mission follow a sequence of steps that would be the same next time?',
        '- Were there 3+ meaningful steps that form a natural pipeline?',
        '- Is this work likely to recur (not a one-off investigation or question)?',
        '',
        'Respond with JSON:',
        '{ "processify": true/false, "process_draft": { "id": "p-...", "name": "...", "description": "...", "intent_keywords": ["..."], "steps": [{"title":"...","description":"...","agent":"motor|temporal-research","type":"standard","accept_criteria":"..."}] } }',
        'If processify is false, omit process_draft.',
      ].join('\n'),
      _missionId: envelope.id,
      _skipMemory: true,
    });

    if (!evalResult?.success || !evalResult?.output) return;

    let parsed;
    try {
      // Try to extract JSON from the response
      const jsonMatch = evalResult.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch { /* ignore parse errors */ }

    if (!parsed?.processify || !parsed?.process_draft) {
      log('INFO', `[processify] Evaluation: not a repeatable workflow`);
      return;
    }

    const draft = parsed.process_draft;
    if (!draft.id || !draft.name || !draft.steps || draft.steps.length < 2) {
      log('WARN', `[processify] Draft invalid — missing id/name/steps`);
      return;
    }

    // Validate the process ID format
    if (!draft.id.startsWith('p-')) draft.id = `p-${draft.id}`;

    // Don't overwrite existing processes
    if (PROCESSES[draft.id]) {
      log('INFO', `[processify] Process ${draft.id} already exists — skipping`);
      return;
    }

    // Write process to Firestore
    const processDoc = {
      id: draft.id,
      name: draft.name,
      description: draft.description || `Auto-created from mission ${envelope.id}`,
      status: 'active',
      version: 1,
      visibility: 'team',
      intent_keywords: draft.intent_keywords || [],
      parameters: draft.parameters || {},
      steps: draft.steps.map((s, i) => ({
        title: s.title || `Step ${i + 1}`,
        description: s.description || '',
        agent: s.agent || 'motor',
        type: s.type || 'standard',
        accept_criteria: s.accept_criteria || '',
        optional: s.optional || false,
        checkpointBoundary: s.checkpointBoundary || false,
        contextTemplate: s.contextTemplate || {},
      })),
      contextTemplate: {},
      created_by: 'processify',
      source_mission_id: envelope.id,
      source_project_id: envelope.project_id,
      execution_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      changelog: [{ version: 1, date: new Date().toISOString(), note: `Auto-created from mission ${envelope.id}` }],
    };

    await firestoreWrite('processes', draft.id, processDoc);
    log('INFO', `[processify] ✅ Created process "${draft.name}" (${draft.id}) with ${draft.steps.length} steps from mission ${envelope.id}`);

    // Update mission output with processify note
    envelope.output = (envelope.output || '') +
      `\n\n📋 **New process created:** ${draft.id} — "${draft.name}" (${draft.steps.length} steps). Future similar missions will follow this process.`;
    await firestoreWrite('work', envelope.id, envelope);

    // Link process to project's standardProcesses
    try {
      await linkProcessToProject(envelope.project_id, draft.id, deps);
    } catch (e) {
      log('WARN', `[processify] Failed to link process to project: ${e.message}`);
    }

    log('INFO', `[TELEMETRY] processify mission=${envelope.id} process=${draft.id} steps=${draft.steps.length}`);

  } catch (e) {
    log('WARN', `[processify] Evaluation failed: ${e.message}`);
  }
}

/**
 * Phase 5.2: Extract project-relevant facts from mission output and persist to project context.
 */
async function tryContextExtraction(envelope, synthesisOutput, workSummary, deps) {
  const { log, callAgent, PROJECTS, getAuthToken, FIRESTORE_BASE } = deps;

  try {
    const project = PROJECTS[envelope.project_id];
    if (!project) return;

    const existingContext = project.context || {};
    const existingKeys = Object.keys(existingContext).join(', ');

    // Ask Flash to extract project-relevant facts
    const extractResult = await callAgent('cortex', {
      instruction: [
        '[CONTEXT EXTRACTION]',
        'Extract project-relevant facts from this completed mission that would help future missions.',
        '',
        `## Project: ${project.name} (${envelope.project_id})`,
        `Existing context keys: ${existingKeys || 'none'}`,
        '',
        '## Mission Output',
        (synthesisOutput || '').substring(0, 2000),
        '',
        '## Work Summary',
        workSummary.substring(0, 2000),
        '',
        '## What to extract',
        '- Permission requirements discovered',
        '- Working commands/paths/URLs verified during execution',
        '- Folder structures, file locations, resource IDs',
        '- Deployment procedures that worked',
        '- Known failure modes and workarounds',
        '',
        'DO NOT extract: task-specific one-off details, opinions, intermediate debugging steps.',
        'DO NOT duplicate keys already in existing context.',
        '',
        'Respond with JSON:',
        '{ "updates": { "<key>": { "kind": "convention|url|drive_folder|doc", "summary": "<fact>", "ref": "<id-if-applicable>" } } }',
        'If no new facts worth persisting, respond: { "updates": {} }',
      ].join('\n'),
      _missionId: envelope.id,
      _skipMemory: true,
    });

    if (!extractResult?.success || !extractResult?.output) return;

    let parsed;
    try {
      const jsonMatch = extractResult.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch { /* ignore parse errors */ }

    if (!parsed?.updates || Object.keys(parsed.updates).length === 0) {
      log('INFO', `[context-extract] No new project facts to persist`);
      return;
    }

    // Write context updates to project via Firestore patch
    const updates = parsed.updates;
    const updatedContext = { ...existingContext };
    for (const [key, entry] of Object.entries(updates)) {
      if (existingContext[key]) continue; // Don't overwrite existing keys
      updatedContext[key] = {
        ...(typeof entry === 'object' ? entry : { summary: String(entry) }),
        kind: entry?.kind || 'convention',
        updatedAt: new Date().toISOString(),
        updatedBy: envelope.owner || 'agent',
      };
    }

    // Only write if there are actual new entries
    const newKeys = Object.keys(updates).filter(k => !existingContext[k]);
    if (newKeys.length === 0) return;

    // Projects are top-level (not under primes/), use direct REST PATCH
    const token = await getAuthToken();
    if (!token || !FIRESTORE_BASE) {
      log('WARN', `[context-extract] No auth token or FIRESTORE_BASE — skipping project context write`);
      return;
    }
    // Write context entries to project via direct REST (projects are top-level, not under primes/)
    const projectUrl = `${FIRESTORE_BASE}/projects/${envelope.project_id}`;
    const resp = await fetch(`${projectUrl}?updateMask.fieldPaths=context&updateMask.fieldPaths=updated_at`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        context: { mapValue: { fields: Object.fromEntries(
          Object.entries(updatedContext).map(([k, v]) => {
            const entryFields = {};
            if (v.kind) entryFields.kind = { stringValue: v.kind };
            if (v.ref) entryFields.ref = { stringValue: v.ref };
            if (v.name) entryFields.name = { stringValue: v.name };
            if (v.summary) entryFields.summary = { stringValue: v.summary };
            if (v.url) entryFields.url = { stringValue: v.url };
            if (v.updatedAt) entryFields.updatedAt = { stringValue: v.updatedAt };
            if (v.updatedBy) entryFields.updatedBy = { stringValue: v.updatedBy };
            return [k, { mapValue: { fields: entryFields } }];
          })
        ) } },
        updated_at: { stringValue: new Date().toISOString() },
      } }),
    });
    if (!resp.ok) {
      log('WARN', `[context-extract] Project context PATCH failed: ${resp.status}`);
      return;
    }

    log('INFO', `[context-extract] ✅ Updated project context for ${envelope.project_id}: +${newKeys.length} entries (${newKeys.join(', ')})`);
    log('INFO', `[TELEMETRY] context_extract mission=${envelope.id} project=${envelope.project_id} new_keys=${newKeys.length}`);

  } catch (e) {
    log('WARN', `[context-extract] Extraction failed: ${e.message}`);
  }
}

/**
 * Link a process ID to a project's standardProcesses array.
 */
async function linkProcessToProject(projectId, processId, deps) {
  const { log, PROJECTS, getAuthToken, FIRESTORE_BASE } = deps;

  const project = PROJECTS[projectId];
  if (!project) return;

  const existing = project.standardProcesses || [];
  if (existing.includes(processId)) return; // Already linked

  const updated = [...existing, processId];
  project.standardProcesses = updated;

  const token = await getAuthToken();
  if (!token || !FIRESTORE_BASE) return;

  const projectUrl = `${FIRESTORE_BASE}/projects/${projectId}`;
  await fetch(`${projectUrl}?updateMask.fieldPaths=standardProcesses&updateMask.fieldPaths=updated_at`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      standardProcesses: { arrayValue: { values: updated.map(id => ({ stringValue: id })) } },
      updated_at: { stringValue: new Date().toISOString() },
    } }),
  });

  log('INFO', `[processify] Linked process ${processId} to project ${projectId}`);
}
