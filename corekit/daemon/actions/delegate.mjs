// Action handler: delegate
export async function handleDelegate(ctx, deps) {
  const { envelope, decision } = ctx;
  const {
    log,
    generateId,
    generateTitle,
    firestoreWrite,
    writeHistory,
    composeDelegationMarker,
    PROJECTS,
    makeAddress,
    addressFromMeta,
    AGENT_EMAIL,
    AGENT_ID,
    now
  } = deps;

  const targetEmail = decision.target_email;
  const delegateInstruction = decision.instruction || '';
  const delegateCriteria = decision.accept_criteria || '';
  const delegateProjectId = decision.project_id || envelope.project_id || null;

  if (!targetEmail) {
    log('ERROR', 'delegate: missing target_email');
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] delegate requires a target_email. Check project team members for available agents.' }]
    };
  }

  log('INFO', `Cortex delegate: target=${targetEmail} project=${delegateProjectId}`);

  // Create Task envelope with status='waiting'
  const delegTaskId = generateId('w');
  const delegTaskEnvelope = {
    id: delegTaskId,
    type: 'T',
    parent_id: envelope.id,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'waiting',
    intent: 'delegation',
    title: await generateTitle(delegateInstruction, 'task'),
    instruction: delegateInstruction,
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

  // Compose delegation marker as output envelope for Mouth
  const delegMarker = composeDelegationMarker({
    targetEmail,
    ref: delegTaskId,
    from: AGENT_EMAIL || AGENT_ID,
    project: delegateProjectId || 'none',
    body: delegateInstruction,
  });

  const delegOutputId = generateId('w');
  await firestoreWrite('work', delegOutputId, {
    id: delegOutputId,
    type: 'T',
    parent_id: delegTaskId,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'complete',
    intent: 'delegation_send',
    title: `Delegation to ${targetEmail}`,
    instruction: delegateInstruction,
    output: delegMarker,
    delivery_status: 'pending',
    delivery_target: targetEmail,
    delivery_space_id: (delegateProjectId && PROJECTS[delegateProjectId]?.gchat_space_id) || null,
    delivery_address: makeAddress('gchat', {
      space: (delegateProjectId && PROJECTS[delegateProjectId]?.gchat_space_id)
        ? `spaces/${PROJECTS[delegateProjectId].gchat_space_id}`
        : null,
    }),
    project_id: delegateProjectId,
    source_channel: 'brain',
    created_at: now(),
    updated_at: now(),
  });

  log('INFO', `Delegation output envelope created: ${delegOutputId} → ${targetEmail}`);

  // Delegation ACK: notify the original requester that work has been delegated
  const ackId = generateId('w');
  const agentName = targetEmail.split('@')[0].replace(/-/g, ' ');
  await firestoreWrite('work', ackId, {
    id: ackId,
    type: 'T',
    parent_id: envelope.id,
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
  envelope.children.push(delegTaskId);
  envelope.status = 'waiting';
  envelope.updated_at = now();
  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'active', 'waiting', 'brain', `Waiting for delegation to ${targetEmail}`);

  log('INFO', `Mission ${envelope.id} waiting for delegation to ${targetEmail}`);
  return { exit: true };
}

