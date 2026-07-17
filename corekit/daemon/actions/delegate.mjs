// Action handler: delegate
import { normalizeTargetEmail } from '../../lib/delegation.mjs';
import { sanitizeRepoId } from '../../lib/git-store.mjs';

export async function handleDelegate(ctx, deps) {
  const { envelope, decision } = ctx;
  const {
    log,
    generateId,
    generateTitle,
    firestoreWrite,
    firestoreQuery,
    writeHistory,
    composeDelegationMarker,
    PROJECTS,
    makeAddress,
    addressFromMeta,
    AGENT_EMAIL,
    AGENT_ID,
    now
  } = deps;

  const rawTargetEmail = decision.target_email;
  const delegateInstruction = decision.instruction || '';
  const delegateCriteria = decision.accept_criteria || '';
  const delegateProjectId = decision.project_id || envelope.project_id || null;

  // ---- Validation gate 0: the delegation skill must be installed ----
  // The skill is role-scoped to fleet agents (skill.json roles). Primes never
  // delegate — they operate fleet agents directly.
  const delegationInstalled = Array.isArray(deps.SKILL_INDEX)
    && deps.SKILL_INDEX.some(s => s.id === 'delegation');
  if (!delegationInstalled) {
    log('ERROR', 'delegate: delegation skill not installed for this agent — delegation NOT sent');
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] delegation is not available to this agent. Primes never delegate — operate the fleet directly instead: SSH into the agent VM (system-shell / gcp-admin), read its work with the work-log tools, test or upgrade it (fleet-verify, fleet-upgrade), or do the work locally with checkpoint_plan.' }]
    };
  }

  // ---- Validation gate 0.5: delegation is project-scoped ----
  // Delegation exists only within a project context (shared team + GChat
  // space). An unscoped mission has no delegation route.
  if (!delegateProjectId || !PROJECTS[delegateProjectId]) {
    const spacedProjects = Object.values(PROJECTS)
      .filter(p => p && p.gchat_space_id && p.status !== 'archived')
      .map(p => `"${p.id}" (${p.name || p.id})`);
    log('ERROR', `delegate: no project context (project_id=${delegateProjectId || 'none'}) — delegation NOT sent`);
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: `[SYSTEM] delegate: delegation is only available within a project context, and this mission ${delegateProjectId ? `names unknown project "${delegateProjectId}"` : 'has no project'} — the delegation was NOT sent. ${spacedProjects.length ? `Set project_id to one of the delegation-capable projects: ${spacedProjects.join(', ')}, or do the work locally.` : 'No delegation-capable project exists — do the work locally or use needs_input.'}` }]
    };
  }

  if (!rawTargetEmail) {
    log('ERROR', 'delegate: missing target_email');
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] delegate requires a target_email. Check project team members for available agents.' }]
    };
  }

  // ---- Validation gate 1: email shape ----
  // Normalize before anything else — regex-extracted targets can carry a
  // trailing sentence period ("agent@example.com.") that GChat rejects.
  const { email: targetEmail, valid: emailValid } = normalizeTargetEmail(rawTargetEmail);
  if (!emailValid) {
    log('ERROR', `delegate: target_email "${rawTargetEmail}" is not a valid email — delegation NOT sent`);
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: `[SYSTEM] delegate: target_email "${rawTargetEmail}" is not a valid email address — the delegation was NOT sent. Copy the exact address from the project team roster or the fleet registry (fleet_status); never compose one from memory.` }]
    };
  }

  // ---- Validation gate 2: self-delegation ----
  const selfEmail = (AGENT_EMAIL || AGENT_ID || '').toLowerCase();
  if (selfEmail && targetEmail === selfEmail) {
    log('WARN', `delegate: target resolves to SELF (${targetEmail}) — delegation NOT sent`);
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] delegate: the target is yourself — delegating to yourself loops forever, so it was NOT sent. Do the work locally with checkpoint_plan instead.' }]
    };
  }

  // ---- Validation gate 3: fleet registry (Cortex can hallucinate emails) ----
  try {
    const fleetSnap = await firestoreQuery('fleet', [
      { field: 'email', op: 'EQUAL', value: { stringValue: targetEmail } },
    ], { noOrderBy: true });
    const onlineMatch = fleetSnap.find(a => a.status === 'online');
    if (!onlineMatch) {
      let roster = '';
      try {
        const allAgents = await firestoreQuery('fleet', [], { noOrderBy: true });
        roster = allAgents.length
          ? ` Registered fleet agents: ${allAgents.map(a => `${a.email} (${a.specialty || 'unknown'}, ${a.status || 'unknown'})`).join('; ')}.`
          : ' The fleet registry is empty — no agents are available to delegate to.';
      } catch { /* roster hint is best-effort */ }
      log('ERROR', `delegate: "${targetEmail}" not found online in fleet registry — delegation NOT sent`);
      return {
        continue: true,
        priorResultsAppend: [{ agent: 'system', result: `[SYSTEM] delegate: "${targetEmail}" is not a registered online fleet agent — the delegation was NOT sent.${roster} Use an exact registered email, or needs_input if no suitable agent exists.` }]
      };
    }
  } catch (e) {
    log('WARN', `delegate: fleet registry validation failed (${e.message}) — proceeding with ${targetEmail} as-is`);
  }

  // ---- Validation gate 4: deliverable route ----
  // Delegations deliver through the shared project GChat space. A project
  // without a space is structurally undeliverable — the mouth would drop the
  // address and retry into the void. Fail fast with the actual options.
  const spaceId = (delegateProjectId && PROJECTS[delegateProjectId]?.gchat_space_id) || null;
  if (!spaceId) {
    const spacedProjects = Object.values(PROJECTS)
      .filter(p => p && p.gchat_space_id && p.status !== 'archived')
      .map(p => `"${p.id}" (${p.name || p.id})`);
    log('ERROR', `delegate: project "${delegateProjectId || 'none'}" has no GChat space — delegation NOT sent`);
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: `[SYSTEM] delegate: project "${delegateProjectId || 'none'}" has no GChat space, so the delegation message cannot be delivered — it was NOT sent. ${spacedProjects.length ? `Re-issue the delegate action with project_id set to a project that has a space: ${spacedProjects.join(', ')}.` : 'No project has a GChat space configured — use needs_input to ask the operator to set one up or to handle this directly.'}` }]
    };
  }

  log('INFO', `Cortex delegate: target=${targetEmail} project=${delegateProjectId}`);

  // C-15: R->M->C->T — the delegation lives under a Checkpoint, never directly
  // under the Mission. Generate all ids up front so envelopes can reference
  // each other (the T carries its delivery envelope id for delivery-failure
  // fast-fail in checkWaitingEnvelopes).
  const cpId = generateId('w');
  const delegTaskId = generateId('w');
  const delegOutputId = generateId('w');
  const ackId = generateId('w');
  const agentName = targetEmail.split('@')[0].replace(/-/g, ' ');

  // #3-reality (C-24): give the delegate a retrievable git-branch pointer to any inputs
  // the delegator has already committed. Those live on branch mission/<envelope.id> of
  // the DELEGATOR's OWN project repo — sanitizeRepoId(envelope.project_id), NOT
  // decision.project_id (which can differ on a cross-project delegation and would name the
  // wrong repo). Only emit when the delegator has a project repo (a project-less mission
  // has no such branch). Enrich ONLY the delegation T's instruction — the reconciler
  // materializes the delegate mission from t.instruction; the title + ping stay clean.
  // (The cortex-direct path does not itself commit before delegating, so the branch may be
  // empty for a fresh mission — the wording is honest about that and says to report, not
  // loop, on a missing file.)
  let delegateInstructionEnriched = delegateInstruction;
  if (envelope.project_id) {
    const _delegRepoId = sanitizeRepoId(envelope.project_id);
    const _delegMissionBranch = `mission/${envelope.id}`;
    delegateInstructionEnriched = delegateInstruction
      + `\n\n[INPUT FILES — from the delegator's git branch]\n`
      + `Any files the delegator has already committed for this task are on branch \`${_delegMissionBranch}\` of repo \`${_delegRepoId}\` `
      + `in the shared git store (they may not yet be on \`main\`). If your instruction names an input file, retrieve it first:\n`
      + `  work-clone ${_delegRepoId} --ref ${_delegMissionBranch} --dir delegator-inputs\n`
      + `then read from \`delegator-inputs/\`. If a named file is absent, it was not produced — do not loop; report what is missing.`;
  }

  const cpEnvelope = {
    id: cpId,
    type: 'C',
    parent_id: envelope.id,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'waiting',
    intent: 'checkpoint',
    title: `Delegate to ${agentName}`,
    instruction: delegateInstruction,
    accept_criteria: delegateCriteria,
    context_summary: null,
    output: null,
    children: [delegTaskId, ackId],
    context_forward: null,
    error: null,
    source_channel: 'brain',
    source_meta: {
      dispatched_by: envelope.id,
      step_type: 'delegation',
      delegated_to: targetEmail,
    },
    project_id: delegateProjectId,
    created_at: now(),
    started_at: now(),
    completed_at: null,
    updated_at: now(),
    iteration: 0,
  };
  await firestoreWrite('work', cpId, cpEnvelope);
  await writeHistory(cpId, null, 'waiting', 'brain', `Delegation checkpoint: ${agentName}`);

  // Create Task envelope with status='waiting'
  const delegTaskEnvelope = {
    id: delegTaskId,
    type: 'T',
    parent_id: cpId,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'waiting',
    intent: 'delegation',
    title: await generateTitle(delegateInstruction, 'task'),
    instruction: delegateInstructionEnriched,
    accept_criteria: delegateCriteria,
    context_summary: null,
    output: null,
    children: [],
    context_forward: null,
    error: null,
    source_channel: 'brain',
    source_meta: {
      step_type: 'delegation',
      delegated_to: targetEmail,
      target_agent_email: targetEmail,
      delivery_envelope_id: delegOutputId,
    },
    project_id: delegateProjectId,
    created_at: now(),
    started_at: now(),
    completed_at: null,
    updated_at: now(),
    iteration: 0,
  };

  await firestoreWrite('work', delegTaskId, delegTaskEnvelope);
  await writeHistory(delegTaskId, null, 'waiting', 'brain', `Delegating to ${targetEmail}`);

  // B-2 (C-27): the delegation ping is conversational PROSE — the mouth voices it and
  // appends the correlation tag post-voicing. The ref + accept_criteria live on the
  // durable delegation T (the reconciler reads them); the ping carries no raw marker.
  await firestoreWrite('work', delegOutputId, {
    id: delegOutputId,
    type: 'T',
    parent_id: delegTaskId,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'complete',
    intent: 'delegation_send',
    title: `Delegation to ${targetEmail}`,
    instruction: delegateInstruction,
    output: delegateInstruction,
    delegation_ref: delegTaskId,
    delivery_status: 'pending',
    delivery_target: targetEmail,
    delivery_space_id: spaceId,
    delivery_address: makeAddress('gchat', { space: spaceId }),
    project_id: delegateProjectId,
    source_channel: 'brain',
    created_at: now(),
    updated_at: now(),
  });

  log('INFO', `Delegation output envelope created: ${delegOutputId} → ${targetEmail}`);

  // Delegation ACK: notify the original requester that work has been delegated
  await firestoreWrite('work', ackId, {
    id: ackId,
    type: 'T',
    parent_id: cpId,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'complete',
    intent: 'notification',
    title: 'Delegation acknowledgment',
    instruction: 'Notify operator of delegation',
    output: `I've delegated this to ${agentName}. I'll follow up when they complete their work.`,
    delivery_status: 'pending',
    delivery_address: addressFromMeta(envelope.source_meta, envelope.source_channel),
    source_channel: envelope.source_channel || 'brain',
    source_meta: envelope.source_meta || {},
    project_id: delegateProjectId,
    created_at: now(),
    updated_at: now(),
  });
  log('INFO', `Delegation ack envelope created: ${ackId} → original requester`);

  // Set mission to waiting
  envelope.children = envelope.children || [];
  envelope.children.push(cpId);
  envelope.status = 'waiting';
  envelope.updated_at = now();
  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'active', 'waiting', 'brain', `Waiting for delegation to ${targetEmail}`);

  log('INFO', `Mission ${envelope.id} waiting for delegation to ${targetEmail}`);
  return { exit: true };
}
