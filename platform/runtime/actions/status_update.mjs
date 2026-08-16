// Action handler: status_update
export async function handleStatusUpdate(ctx, deps) {
  const { envelope, decision } = ctx;
  const { deliverStatusUpdate, log } = deps;

  const message = decision.message || 'Working on it...';
  await deliverStatusUpdate(envelope.id, message);
  log('INFO', `Status update sent for envelope ${envelope.id}`);
  return { continue: true };
}
