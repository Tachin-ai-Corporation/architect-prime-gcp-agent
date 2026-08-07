// Action handler: project_bootstrap
//
// A PM/lead stands up a delivery project from a chat ask. The GChat space the ask
// arrived on becomes the project's comms space. The handler does the deterministic work
// (C-4/C-5): create projects/{id} bound to the origin space, seed team/canon/context,
// then RE-SCOPE this mission to the new project so its own delegations route through that
// space — the mission auto-continues into the delivery (cortex plans it next iteration).
//
// Boundary: adding the delegate bots as MEMBERS of the space needs a Chat-admin scope the
// fleet does not hold — so this states the precondition and relies on the delegate action's
// clear "not delivered" signal if a teammate is missing. It never fabricates a teammate email.
import {
  projectBootstrapEnabled, missionOriginSpace, findProjectBySpace,
  slugifyProjectId, resolveTeam, buildProjectDoc,
} from '../../lib/project-bootstrap.mjs';

export async function handleProjectBootstrap(ctx, deps) {
  const { envelope, decision } = ctx;
  const {
    log, firestoreWrite, firestoreQuery, writeHistory,
    PROJECTS, CONTRACTS, AGENT_EMAIL, AGENT_ID, now,
  } = deps;

  const append = (result) => ({ priorResultsAppend: [{ agent: 'system', result: `[SYSTEM] ${result}` }] });

  if (!projectBootstrapEnabled(CONTRACTS)) {
    return append('project_bootstrap is not enabled for this agent. Use checkpoint_plan for local work, or needs_input to ask the operator to create the project.');
  }

  const spec = (decision && decision.project) || {};

  // The space the ask arrived on IS the project's space (operator's design). No space → cannot bind.
  const space = missionOriginSpace(envelope);
  if (!space) {
    return append('project_bootstrap: this request did not arrive from a GChat space, so there is no space to bind a project to. Use needs_input to ask the operator to start this from the project\'s chat space (or set the project up from the dashboard).');
  }

  // Idempotent adopt: if a live project is already bound to this space, reuse it; else pick a free id.
  const taken = Object.keys(PROJECTS || {});
  let id = findProjectBySpace(PROJECTS, space);
  const adopted = !!id;
  if (!id) id = (spec.id && !taken.includes(String(spec.id))) ? String(spec.id) : slugifyProjectId(spec.name || spec.id || envelope.title || 'project', taken);

  // Resolve the team to REAL fleet emails (never invent one).
  let roster = [];
  try { roster = await firestoreQuery('fleet', [], { noOrderBy: true }); }
  catch (e) { log('WARN', `project_bootstrap: fleet roster read failed (${e.message}) — team will be best-effort`); }
  const { team, unresolved } = resolveTeam(spec.team || [], roster, {});

  // The PM (this agent) leads the project — ensure it is on the team.
  const selfEmail = AGENT_EMAIL || AGENT_ID || '';
  if (selfEmail && !team.some(t => (t.email || '').toLowerCase() === selfEmail.toLowerCase())) {
    team.unshift({ email: selfEmail, role: 'lead', name: (selfEmail.split('@')[0] || 'lead'), type: 'agent', responsibilities: 'Product/PM lead: turns the operator ask into a plan, delegates to specialists, coordinates and reports.' });
  }
  // The requester (operator) is the human owner.
  const ownerEmail = (envelope.source_meta && envelope.source_meta.senderEmail) || '';
  if (ownerEmail && !team.some(t => (t.email || '').toLowerCase() === ownerEmail.toLowerCase())) {
    team.push({ email: ownerEmail, role: 'owner', name: ownerEmail.split('@')[0], type: 'human', responsibilities: 'Operator/owner: sets direction and approves promotions to production.' });
  }

  // Build + write the project doc (bound to the origin space). On adopt, merge onto the existing doc.
  const nowIso = now();
  const built = buildProjectDoc({
    id, name: spec.name, description: spec.description, goal: spec.goal, spaceId: space,
    team, canon: spec.canon, context: spec.context, owner: ownerEmail || selfEmail, createdBy: AGENT_ID, now: nowIso,
  });
  const doc = adopted ? { ...(PROJECTS[id] || {}), ...built, created_at: (PROJECTS[id] && PROJECTS[id].created_at) || nowIso } : built;
  try {
    await firestoreWrite('projects', id, doc);
  } catch (e) {
    log('ERROR', `project_bootstrap: failed to write project ${id}: ${e.message}`);
    return append(`project_bootstrap: could not write the project registry (${e.message}). The project was NOT created; retry, or ask the operator to create it from the dashboard.`);
  }
  await writeHistory(envelope.id, envelope.status, envelope.status, 'brain', `${adopted ? 'Adopted' : 'Bootstrapped'} project ${id} bound to ${space}`);
  log('INFO', `[TELEMETRY] project_bootstrapped mission=${envelope.id} project=${id} space=${space} adopted=${adopted} team=${team.length} unresolved=${unresolved.length}`);

  // ---- Re-scope THIS mission to the new project (the auto-continue) ----
  // From now on the mission's delegations resolve PROJECTS[id].gchat_space_id = the origin
  // space, so they deliver. Refresh the in-memory map so this same iteration's downstream
  // (and the next decide) see the project immediately.
  envelope.project_id = id;
  envelope.updated_at = nowIso;
  await firestoreWrite('work', envelope.id, envelope);
  if (PROJECTS) PROJECTS[id] = doc;

  // Compose the continue nudge: state what's set up, the membership precondition (the one
  // thing the fleet can't do), any unresolved roles, then hand to delivery planning.
  const teammates = team.filter(t => t.type === 'agent' && (t.email || '').toLowerCase() !== selfEmail.toLowerCase()).map(t => t.email);
  const parts = [
    `Project "${id}" is set up and this mission is now scoped to it; its comms space is linked (${space}).`,
    `Team: ${team.map(t => `${t.name || t.email} (${t.role})`).join(', ') || '(just you)'}.`,
  ];
  if (unresolved.length) parts.push(`NOTE: could not match these requested roles to a registered fleet agent and left them off: ${unresolved.join(', ')}.`);
  parts.push(`Delegations are delivered IN this space. The teammates you delegate to (${teammates.join(', ') || 'none yet'}) must be MEMBERS of this space — you cannot add them (that needs the operator). If a delegation reports it was not delivered, use needs_input to ask the operator to add that teammate to the space.`);
  parts.push(`Now plan the delivery with checkpoint_plan and delegate to the team as the work needs.`);
  return append(parts.join(' '));
}
