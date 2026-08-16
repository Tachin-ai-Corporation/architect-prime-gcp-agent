// Action handler: wait
export async function handleWait(ctx, deps) {
  const { envelope, decision } = ctx;
  const {
    firestoreWrite, writeHistory, CONTRACTS, toStr,
    generateId, AGENT_EMAIL, AGENT_ID, addressFromMeta, makeAddress,
  } = deps;

  const minMin = CONTRACTS.dispatch?.wait_min_minutes || 1;
  const maxMin = CONTRACTS.dispatch?.wait_max_minutes || 1440;
  const defMin = CONTRACTS.dispatch?.wait_default_minutes || 5;

  let minutes = parseInt(decision.minutes ?? decision.wait_minutes ?? decision.duration ?? defMin, 10);
  if (isNaN(minutes)) minutes = defMin;
  if (minutes < minMin) minutes = minMin;
  if (minutes > maxMin) minutes = maxMin;

  const reason = decision.reason || decision.wait_reason || 'Waiting for external event';
  const resumeInstruction = decision.then || decision.wait_then || decision.instruction || 'Continue mission';
  const waitResumeAt = new Date(Date.now() + minutes * 60000).toISOString();

  envelope.status = 'waiting';
  envelope.wait_resume_at = waitResumeAt;
  envelope.resume_instruction = resumeInstruction;
  envelope.updated_at = new Date().toISOString();

  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'active', 'waiting', 'brain',
    `Waiting ${minutes}m (until ${waitResumeAt.substring(11, 16)}): ${toStr(reason).substring(0, 200)}`);

  // Notify the operator that the mission is pausing (top-level missions only)
  if (!envelope.parent_id && generateId) {
    const nowIso = new Date().toISOString();
    const notifId = generateId('w');
    await firestoreWrite('work', notifId, {
      id: notifId, type: 'T', parent_id: null,
      owner: AGENT_EMAIL || AGENT_ID, status: 'complete', intent: 'notification',
      instruction: 'Wait notification',
      output: `⏳ Pausing for ${minutes} minute${minutes === 1 ? '' : 's'} — ${toStr(reason).substring(0, 200)}. I'll continue automatically after that.`,
      source_channel: envelope.source_channel || 'system',
      source_meta: { notification_type: 'wait' },
      created_at: nowIso, started_at: nowIso, completed_at: nowIso, updated_at: nowIso,
      children: [], accept_criteria: null, context_summary: null, context_forward: null,
      error: null, iteration: 0,
      delivery_status: 'pending',
      delivery_address: addressFromMeta ? addressFromMeta(envelope.source_meta, envelope.source_channel) : (makeAddress ? makeAddress('dashboard') : null),
    });
  }

  return { exit: true };
}
