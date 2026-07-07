// Action handler: wait
export async function handleWait(ctx, deps) {
  const { envelope, decision, _tokenUsage } = ctx;
  const { firestoreWrite, writeHistory, CONTRACTS, toStr } = deps;

  const minMin = CONTRACTS.dispatch?.wait_min_minutes || 1;
  const maxMin = CONTRACTS.dispatch?.wait_max_minutes || 1440;
  const defMin = CONTRACTS.dispatch?.wait_default_minutes || 5;

  let minutes = parseInt(decision.minutes || decision.duration || defMin, 10);
  if (isNaN(minutes)) minutes = defMin;
  if (minutes < minMin) minutes = minMin;
  if (minutes > maxMin) minutes = maxMin;

  const reason = decision.reason || 'Waiting for external event';
  const resumeInstruction = decision.then || decision.instruction || 'Continue mission';
  const waitResumeAt = new Date(Date.now() + minutes * 60000).toISOString();

  envelope.status = 'waiting';
  envelope.wait_resume_at = waitResumeAt;
  envelope.resume_instruction = resumeInstruction;
  envelope.updated_at = new Date().toISOString();

  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'active', 'waiting', 'brain',
    `Waiting ${minutes}m (until ${waitResumeAt.substring(11, 16)}): ${toStr(reason).substring(0, 200)}`);

  return { exit: true };
}
