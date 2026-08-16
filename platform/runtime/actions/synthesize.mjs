// Action handler: synthesize

import { extractVerdict, extractFailSummary, extractProbes, stakesAtLeast } from '../../work/verdict.mjs';
import { filterProjectContext, validateContextEntry } from '../../control-plane/project-context.mjs';
import { finalizeBlockedBySpine, probeGatedFinalizeAction } from '../../work/checkpoint-spine.mjs';

// Pure exemption predicate — determines if verification can be skipped.
function isSynthExempt(envelope, contracts = {}) {
  // Delegated missions always require verification
  if (envelope.source_meta?.delegation_ref) return false;
  // Missions with pinned criteria always require verification
  if (envelope.accept_criteria && envelope.accept_criteria.length > 20) return false;
  // Short outputs below threshold are exempt
  const minChars = contracts.dispatch?.synth_verify_min_chars || 400;
  if ((envelope.output || '').length < minChars) return true;
  return false;
}

// B-30: Compose answer-first delivery order from cortex decision fields.
function composeAnswerFirst(decision, synthesisOutput) {
  if (!decision.answer) return synthesisOutput;
  const lines = [String(decision.answer).trim()];
  if (synthesisOutput) lines.push('', '— Reasoning —', String(synthesisOutput).trim());
  const assumptions = Array.isArray(decision.assumptions) ? decision.assumptions : [];
  const order = { assumed: 0, inferred: 1, verified: 2 };
  const sorted = [...assumptions].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  if (decision.risk || sorted.length > 0) {
    lines.push('', '— Risk & assumptions —');
    if (decision.risk) lines.push(String(decision.risk).trim());
    for (const a of sorted) lines.push(`• [${a.status}] ${a.claim}${a.note ? ' — ' + a.note : ''}`);
  }
  return lines.join('\n');
}

export async function handleSynthesize(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const { log, createCT, completeEnvelope, MAX_ITERATIONS } = deps;

  // Check for unresolved failures — block premature success synthesis.
  //
  // `inconclusive` is excluded alongside `timedOut`, and for the same reason: neither is a
  // judgement that the work is wrong. An inconclusive row means the verifier could not SEE
  // the evidence (or returned no verdict at all) — the milestone is unverified, but the
  // tasks reported their outcomes and there is something real to tell the requester.
  //
  // Counting those as hard failures is what turned a finished mission into a blocked one:
  // three documents were correctly edited, the verifier failed one clause because a
  // document's content "is not fully visible in the provided transcript", cortex correctly
  // diagnosed the truncation and chose synthesize — and this guard rejected it, pushing the
  // mission through synthesize_with_failure into the post-unblock guard and out as
  // `blocked`, with three finished documents inside it. The guards were each doing their
  // job; the input was a lie. Synthesis is still not allowed to paper over a REAL failure.
  const lastSuccessIdx = priorResults.map((r, i) => r.success === true ? i : -1).filter(i => i >= 0).pop() ?? -1;
  const hasUnresolvedFail = priorResults.some((r, i) =>
    r.success === false && !r.timedOut && !r.inconclusive && i > lastSuccessIdx);
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

  // restsOnDelegation: this mission IS a delegate finalizing its own claim, or it is the
  // DELEGATOR synthesizing a teammate's returned result. Computed here (also used by the verify
  // path below) because the probe-gated finalize refinement (FC-F) needs it at the FC-A gate.
  const restsOnDelegation = !!envelope.source_meta?.delegation_ref
    || priorResults.some(r => typeof r?.result === 'string' && r.result.includes('[DELEGATION RESULT'));

  // FC-A (B-28/B-1): a mission with a pinned spine must not synthesize a COMPLETE while its
  // DELIVERABLE checkpoint is unmet. Fail-closed: steer to an honest escalation, and on the last
  // iteration terminate as needs_input directly so no false-green ever escapes.
  //
  // FC-F (probe_gated_finalize): the spine is BOOKKEEPING, not ground truth. A delegate can have
  // put the deliverable live (staging serves the change, HTTP 200) while a LATER re-plan re-tasked
  // the deploy onto the orchestrator's own motor, which failed (no perms) and marked the terminal
  // checkpoint 'failed' — so a spine-only block is a FALSE-NEGATIVE (the observed reprove#3 churn).
  // When the mission rests on a DELEGATED observable deliverable, DEFER this block to the mandatory
  // delegated-outcome re-derivation the verify path below already runs, and re-apply it fail-closed
  // unless that re-derivation explicitly confirms the deliverable (PASS). Only an OBSERVED pass
  // unblocks — no false-positive.
  let deferredFromSpineGate = false;
  let spineGate = null;
  const escalateUnmetDeliverable = async (gate, note) => {
    const unmetList = gate.unmet.map(u => `CP${u.n} (${u.status}): ${u.outcome}`).join('; ');
    log('WARN', `[synthesize] False-complete blocked on ${envelope.id} — deliverable checkpoint unmet: ${unmetList}${note}`);
    log('INFO', `[TELEMETRY] finalize_blocked_spine mission=${envelope.id} unmet=${gate.unmet.length} terminal_cp=${gate.terminal.n} iter=${iteration}${note ? ' probe_gated=1 verified=0' : ''}`);
    if (iteration < MAX_ITERATIONS - 1) {
      return {
        continue: true,
        activeGuard: { forbidden: 'synthesize', fallback: 'needs_input', injectedAt: iteration },
        priorResultsAppend: [{
          agent: 'system',
          result: `[SYSTEM] Cannot synthesize COMPLETE: the deliverable checkpoint "${gate.terminal.outcome}" is not done (unmet: ${unmetList}). There is no result to report. Either (1) dispatch to finish the outstanding checkpoint(s), or (2) if a delegate cannot proceed / an input or access is missing, use "needs_input" to escalate to the operator with exactly what is needed. Do NOT report this mission complete.`,
        }],
      };
    }
    // Last iteration — terminate honestly rather than let a false-complete through.
    await completeEnvelope(envelope, {
      status: 'needs_input',
      output: `I could not complete this mission. The deliverable checkpoint "${gate.terminal.outcome}" did not finish (unmet: ${unmetList}). I've stopped rather than report a result I don't have — please advise how you'd like to proceed.`,
      historyDetail: 'Finalize blocked: deliverable checkpoint unmet (fail-closed)',
      skipArtifacts: true, skipMemory: true, skipCleanup: true,
      tokenUsage: _tokenUsage,
    });
    return { exit: true };
  };
  if (deps.CONTRACTS?.dispatch?.finalize_requires_spine_complete) {
    const gate = finalizeBlockedBySpine(envelope._cp_spine);
    if (gate) {
      const PROBE_GATED_FINALIZE = process.env.AGENT_PROBE_GATED_FINALIZE === '1'
        || deps.CONTRACTS?.dispatch?.probe_gated_finalize === true;
      if (probeGatedFinalizeAction({ flagOn: PROBE_GATED_FINALIZE, restsOnDelegation, deliverableVerdict: undefined }) === 'defer') {
        // Don't block on the spine — let the mandatory re-derivation below judge on ground truth.
        deferredFromSpineGate = true;
        spineGate = gate;
        log('INFO', `[synthesize] FC-F: deferring the spine finalize-gate to the deliverable re-derivation on ${envelope.id} (spine says unmet: ${gate.unmet.map(u => 'CP' + u.n).join(',')}; the delegated deliverable's observable milestone is the real gate)`);
      } else {
        return await escalateUnmetDeliverable(gate, '');
      }
    }
  }

  // B-30: Compose answer-first output when cortex provides structured fields.
  // `summary` is included because enforceSchema's raw-text fallback emits
  // { action:'synthesize', summary } (vertex-text.mjs) — without it that body drops.
  const rawSynthesisOutput = decision.synthesis || decision.summary || decision.content || decision.response || decision.message || decision.instruction || '';
  const synthesisOutput = composeAnswerFirst(decision, rawSynthesisOutput);

  // Wrap synthesis in C→T under the mission
  await createCT(envelope, {
    checkpointTitle: 'Formulate response',
    taskTitle: 'Synthesize answer',
    taskOutput: synthesisOutput,
    taskIntent: 'synthesize',
    deliveryStatus: 'internal',
    ctKey: `synth-${envelope.id}-${iteration}`,
  });

  envelope.output = synthesisOutput;

  // CP-6: Universal completion verification
  const skipVerify = isSynthExempt(envelope, deps.CONTRACTS);
  // FC-F: when we deferred the spine finalize-gate, the deliverable MUST be re-derived here (never
  // exempt) — this verification is the ground-truth gate that replaces the deferred spine check.
  let verificationPassed = false;
  if ((!skipVerify || deferredFromSpineGate) && deps.dispatchAgent && deps.extractVerdict) {
    const missionStakes = envelope.stakes || 'routine';
    const ATTACK_STAKES_MIN = deps.CONTRACTS?.dispatch?.attack_duty_stakes_min || 'consequential';
    const PROBE_ENABLED = deps.CONTRACTS?.dispatch?.verify_probe_enabled !== false;
    const PROBE_STAKES_MIN = deps.CONTRACTS?.dispatch?.verify_probe_stakes_min || 'consequential';
    const PROBE_MAX = deps.CONTRACTS?.dispatch?.verify_probe_max ?? 2;

    // F3/B-28: a synthesis that rests on a teammate's REPORTED completion must be
    // re-derived against ground truth, not accepted on the delegate's word —
    // regardless of stakes. (Archie accepted Dot's "done" twice for a hero-section
    // change that never went live; routine stakes had gated off probes/attacks, so
    // verification was a shallow text-coherence check.) Detect two cases: this
    // mission IS a delegate finalizing its own claim (delegation_ref), or this
    // mission is the DELEGATOR synthesizing a teammate's returned result.
    // restsOnDelegation computed above (also used by the FC-A/FC-F finalize gate).
    const attackEligible = restsOnDelegation || stakesAtLeast(missionStakes, ATTACK_STAKES_MIN);
    const probeEligible = PROBE_ENABLED && (restsOnDelegation || stakesAtLeast(missionStakes, PROBE_STAKES_MIN));

    try {
      const criteria = envelope.accept_criteria || 'Complete the requested task successfully';
      const verification = await deps.dispatchAgent('cerebellum', {
        instruction: [
          'Verify the following mission synthesis meets the acceptance criteria.',
          'Read the verification SKILL.md before rendering your verdict.',
          '',
          '## Accept Criteria',
          criteria,
          '',
          '## Mission Synthesis',
          synthesisOutput || '(empty)',
          // Delegated-outcome directive: re-derive, don't recognize (B-28)
          ...(restsOnDelegation ? [
            '',
            '## Delegated Outcome — re-derive, do not trust the report',
            'This synthesis rests on a teammate agent\'s reported completion. A delegate\'s',
            '"done" is an ASSUMED claim until re-derived. For every claimed outcome tied to',
            'an observable artifact — a live URL, a committed file, a deployed change, a',
            'shared document — you MUST `request_probe` to fetch/inspect the ACTUAL artifact',
            'and confirm the claimed change is really present. Do NOT PASS on the delegate\'s',
            'word alone. If an artifact cannot be inspected, that claim stays unverified (fail closed).',
          ] : []),
          // Attack Duty block (stakes-gated, or forced for delegated outcomes)
          ...(attackEligible ? [
            '',
            '## Attack Duty (stakes: ' + missionStakes + (restsOnDelegation ? ', delegated outcome' : '') + ')',
            'Before any PASS, run three attacks and record them in your checks:',
            '1. Strongest domain-expert objection',
            '2. Flip test — invert the softest input; does the conclusion survive?',
            '3. Boundary probe — find where the claim stops being true; confirm this case is inside.',
            'A winning attack is a FAIL with the attack as the recommendation.',
          ] : []),
          // Probe eligibility hint (stakes-gated, or forced for delegated outcomes)
          ...(probeEligible ? [
            '',
            '## Probe Eligibility',
            'This mission qualifies for verification probes' + (restsOnDelegation ? ' (delegated outcome — re-derivation is mandatory)' : ' (stakes: ' + missionStakes + ')') + '.',
            'For any load-bearing claim you cannot verify from the evidence provided,',
            'use `request_probe` instead of guessing. Max ' + PROBE_MAX + ' probes per round.',
          ] : []),
        ].filter(Boolean).join('\n'),
        _missionId: envelope.id,
      });
      const verdict = deps.extractVerdict(verification.output);
      if (verdict === 'FAIL') {
        const failSummary = extractFailSummary(verification.output);
        deps.log('WARN', `[synthesize] Cerebellum FAIL on mission ${envelope.id}: ${failSummary}`);
        // The mission's work already cleared its checkpoints (the checkpoint executor
        // verifies each milestone; unresolved task failures are caught earlier). So a FAIL
        // here is about the ANSWER — an over-claim or a missing caveat — not the work. Steer
        // to synthesize_with_failure (deliver an honest, corrected outcome), NOT checkpoint_plan
        // (which redoes verified work and churns). Cortex may still re-plan if it judges the
        // work genuinely incomplete — the guard only forbids a blind re-synthesis.
        return {
          continue: true,
          activeGuard: { forbidden: 'synthesize', fallback: 'synthesize_with_failure', injectedAt: iteration, context: { verification_fail: failSummary } },
          priorResultsAppend: [{ agent: 'cerebellum', result: `[VERIFICATION FAILED] ${failSummary}\n[SYSTEM] The work reached its checkpoints — this is a defect in the ANSWER, not the work. Do NOT redo the work. Correct any over-claim, keep the honest caveat, and return "synthesize_with_failure" stating plainly what was and was not achieved.` }],
        };
      } else if (verdict === 'PROBE' && PROBE_ENABLED) {
        // PROBE verdict — dispatch fresh motor probes, then re-verdict
        const probes = extractProbes(verification.output);
        if (probes.length > 0) {
          deps.log('INFO', `[synthesize] Running ${probes.length} verification probe(s) on mission ${envelope.id}`);
          const probeResults = [];
          for (const probe of probes.slice(0, PROBE_MAX)) {
            try {
              const pr = await deps.dispatchAgent('motor', {
                instruction: [
                  '[VERIFICATION PROBE]', '', '## Claim to verify', probe.claim,
                  '', '## Method', probe.instruction,
                  '', 'Re-derive this claim from ground truth using ONLY the method above.',
                  'Report whether the claim is verified or contradicted, with the evidence.',
                ].join('\n'),
                _missionId: envelope.id, _probe: true,
              });
              probeResults.push({ claim: probe.claim, output: pr.output || pr.error || '(no output)' });
            } catch (probeErr) {
              probeResults.push({ claim: probe.claim, output: `Probe error: ${probeErr.message}` });
            }
          }
          // Re-dispatch cerebellum with probe results for final verdict
          const probeEvidence = probeResults.map((p, i) => `### Probe ${i + 1}: ${p.claim}\n${p.output}`).join('\n\n');
          const finalV = await deps.dispatchAgent('cerebellum', {
            instruction: [
              'Final verdict round. Original synthesis AND independent probe results are below.',
              'Render exactly one terminal verdict (report_pass or report_fail). Do NOT request further probes.',
              '', '## Accept Criteria', criteria,
              '', '## Mission Synthesis', synthesisOutput || '(empty)',
              '', '## Verification Probe Results', probeEvidence,
            ].join('\n'),
            _missionId: envelope.id,
          });
          const fv = deps.extractVerdict(finalV.output);
          if (fv === 'FAIL') {
            const fSummary = extractFailSummary(finalV.output);
            deps.log('WARN', `[synthesize] Cerebellum FAIL (post-probe) on mission ${envelope.id}: ${fSummary}`);
            return {
              continue: true,
              activeGuard: { forbidden: 'synthesize', fallback: 'synthesize_with_failure', injectedAt: iteration, context: { verification_fail: fSummary } },
              priorResultsAppend: [{ agent: 'cerebellum', result: `[VERIFICATION FAILED (post-probe)] ${fSummary}\n[SYSTEM] Probes re-derived the claims against ground truth — the ANSWER must be corrected, not the work. Return "synthesize_with_failure" with an honest outcome summary.` }],
            };
          }
          if (fv === 'PASS') verificationPassed = true;   // FC-F: post-probe PASS confirms the deliverable
          // PASS or null falls through to normal completion
        } else {
          deps.log('WARN', `[synthesize] PROBE verdict but no parseable probes on mission ${envelope.id} — failing closed (B-28)`);
          return {
            continue: true,
            activeGuard: { forbidden: 'synthesize', fallback: 'synthesize_with_failure', injectedAt: iteration, context: { verification_fail: 'probe_unparseable' } },
            priorResultsAppend: [{
              agent: 'cerebellum',
              result: '[VERIFICATION INCOMPLETE] Re-derivation probes were requested but could not be parsed. Do NOT redo the work — deliver an honest answer that marks the affected claims as unverified, via "synthesize_with_failure" (B-28).',
            }],
          };
        }
      } else if (verdict === null) {
        deps.log('WARN', `[synthesize] Cerebellum did not render verdict for mission ${envelope.id}`);
        envelope.needs_review = true;
        envelope.review_reason = 'Cerebellum did not render verdict on synthesis';
      } else if (verdict === 'PASS') {
        verificationPassed = true;   // FC-F: explicit PASS confirms the deliverable
      }
      // PASS falls through to normal completion
    } catch (e) {
      deps.log('WARN', `[synthesize] Verification failed: ${e.message}`);
    }
  }

  // FC-F: we DEFERRED the spine finalize-gate to the ground-truth re-derivation above. Re-apply it
  // fail-closed unless the deliverable was EXPLICITLY verified — a live artifact PASSED and
  // finalizes (the false-negative fixed); a missing/inconclusive one is escalated honestly, exactly
  // as FC-A would have (a FAIL already returned synthesize_with_failure before reaching here).
  if (deferredFromSpineGate) {
    if (probeGatedFinalizeAction({ flagOn: true, restsOnDelegation, deliverableVerdict: verificationPassed ? 'PASS' : 'FAIL' }) !== 'allow') {
      return await escalateUnmetDeliverable(spineGate, ' [probe-gated: re-derivation did not confirm the deliverable]');
    }
    log('INFO', `[TELEMETRY] finalize_blocked_spine mission=${envelope.id} probe_gated=1 verified=1 terminal_cp=${spineGate.terminal.n} iter=${iteration} — deliverable re-derived observably met; finalizing despite the spine verdict`);
  }

  await completeEnvelope(envelope, {
    status: 'complete',
    output: synthesisOutput,
    priorResults,
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
  const { log, summarizeViaVertex, PROCESSES, PROJECTS, firestoreWrite, firestoreQuery,
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
  const { log, summarizeViaVertex, PROCESSES, firestoreWrite, PRIME_ID } = deps;

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
    const evalInstruction = [
      '[PROCESSIFY EVALUATION]',
      'Analyze this completed mission and determine if it represents a repeatable workflow.',
      '',
      '## Mission',
      `Instruction: ${envelope.instruction || ''}`,
      `Project: ${envelope.project_id}`,
      `Checkpoints completed: ${(envelope.children || []).length}`,
      '',
      '## Evaluation Criteria',
      '- Did the mission follow a sequence of steps that would be the same next time?',
      '- Were there 3+ meaningful steps that form a natural pipeline?',
      '- Is this work likely to recur (not a one-off investigation or question)?',
      '',
      'Respond with JSON:',
      '{ "processify": true/false, "process_draft": { "id": "p-...", "name": "...", "description": "...", "intent_keywords": ["..."], "steps": [{"title":"...","description":"...","agent":"motor|temporal-research","type":"standard","accept_criteria":"..."}] } }',
      'If processify is false, omit process_draft.',
    ].join('\n');
    const evalOutput = await summarizeViaVertex(workSummary.substring(0, 3000), evalInstruction);

    if (!evalOutput) return;

    let parsed;
    try {
      // Try to extract JSON from the response
      const jsonMatch = evalOutput.match(/\{[\s\S]*\}/);
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
  const { log, summarizeViaVertex, PROJECTS, getAuthToken, FIRESTORE_BASE } = deps;

  try {
    const project = PROJECTS[envelope.project_id];
    if (!project) return;

    const existingContext = project.context || {};
    const existingKeys = Object.keys(existingContext).join(', ');

    // Ask Flash to extract project-relevant facts
    const extractInstruction = [
      '[CONTEXT EXTRACTION]',
      'Extract project-relevant facts from this completed mission that would help future missions.',
      '',
      `## Project: ${project.name} (${envelope.project_id})`,
      `Existing context keys: ${existingKeys || 'none'}`,
      '',
      '## What a project holds (C-28: the 40,000-ft working-area view)',
      'ONLY durable resource references that any FUTURE mission on this area would reuse:',
      '- A durable Drive folder / repo / doc / sheet the area lives in (with its id)',
      '- A stable URL (staging/prod) or a lasting working convention (an access requirement,',
      '  a build-step that is always required)',
      '',
      'NEVER extract (these belong elsewhere, not in project context):',
      '- A specific mission particular — this run\'s document id, a one-off result → Mission record / Artifact',
      '- History or a failure that happened → nowhere (or, if repeatable, a Process learning)',
      '- Transient state — "repo is at commit X", "the site currently shows Y" → nowhere',
      '- A sequence of steps / a workflow / a procedure → a Process, never project context',
      '- Anything already in the existing context keys',
      '',
      'Respond with JSON. Each value MUST be a resource packet:',
      '{ "updates": { "<slug_key>": { "kind": "drive_folder|repo|doc|sheet|url|convention", "summary": "<durable fact>", "ref": "<id-or-url-if-applicable>" } } }',
      'Prefer { "updates": {} } — most missions add nothing durable. Only emit a key when you are',
      'confident it is a lasting property of the working area, not of this one mission.',
    ].join('\n');
    const inputText = [
      '## Mission Output',
      (synthesisOutput || '').substring(0, 2000),
      '',
      '## Work Summary',
      workSummary.substring(0, 2000),
    ].join('\n');
    const extractOutput = await summarizeViaVertex(inputText, extractInstruction);

    if (!extractOutput) return;

    let parsed;
    try {
      const jsonMatch = extractOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch { /* ignore parse errors */ }

    if (!parsed?.updates || Object.keys(parsed.updates).length === 0) {
      log('INFO', `[context-extract] No new project facts to persist`);
      return;
    }

    // Write context updates to project via Firestore patch, enforcing C-28 layer
    // purity through the shared validator (platform/control-plane/project-context.mjs): a project
    // holds the 40,000-ft working-area view — durable resource references only, never
    // mission particulars, history, transient state, or process steps. This also
    // self-heals: existing off-layer/empty keys are pruned on the way through (the copy-
    // forward that once let one project accumulate 430 junk keys now can't persist any).
    const updates = parsed.updates;
    const { context: updatedContext, dropped } = filterProjectContext(existingContext);
    if (dropped.length > 0) log('INFO', `[context-extract] Pruned ${dropped.length} off-layer/empty context key(s) from ${envelope.project_id}: ${dropped.map(d => d.key).join(', ')}`);
    const newKeys = [];
    for (const [key, entry] of Object.entries(updates)) {
      if (updatedContext[key]) continue;          // never overwrite an existing key
      const candidate = (typeof entry === 'object' && entry)
        ? { ...entry, kind: entry.kind || 'convention' }
        : { kind: 'convention', summary: String(entry) };
      const { ok, reason } = validateContextEntry(key, candidate);
      if (!ok) { log('INFO', `[context-extract] Rejected '${key}' (C-28): ${reason}`); continue; }
      updatedContext[key] = { ...candidate, updatedAt: new Date().toISOString(), updatedBy: envelope.owner || 'agent' };
      newKeys.push(key);
    }

    // Write if there are new entries OR off-layer keys were pruned (self-heal).
    if (newKeys.length === 0 && dropped.length === 0) return;

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
