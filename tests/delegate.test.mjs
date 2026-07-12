// tests/delegate.test.mjs — normalizeTargetEmail + handleDelegate validation
// gates and the C-15 checkpoint wrap (M→C→T, never T directly under M).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTargetEmail } from '../corekit/lib/delegation.mjs';
import { handleDelegate } from '../corekit/daemon/actions/delegate.mjs';

describe('normalizeTargetEmail', () => {
  it('strips a trailing sentence period (regex-extraction artifact)', () => {
    assert.deepEqual(normalizeTargetEmail('assistant-agent-millie@example.com.'),
      { email: 'assistant-agent-millie@example.com', valid: true });
  });
  it('strips @mention prefixes and wrapping brackets/quotes', () => {
    assert.equal(normalizeTargetEmail('@agent@example.com').email, 'agent@example.com');
    assert.equal(normalizeTargetEmail('<agent@example.com>').email, 'agent@example.com');
    assert.equal(normalizeTargetEmail('"agent@example.com"').email, 'agent@example.com');
  });
  it('lowercases (workspace addresses are case-insensitive)', () => {
    assert.equal(normalizeTargetEmail('Agent@Example.COM').email, 'agent@example.com');
  });
  it('rejects shapes without a mailbox@domain.tld form', () => {
    assert.equal(normalizeTargetEmail('not-an-email').valid, false);
    assert.equal(normalizeTargetEmail('missing@tld').valid, false);
    assert.equal(normalizeTargetEmail('').valid, false);
    assert.equal(normalizeTargetEmail(null).valid, false);
  });
  it('keeps multi-part punctuation strips idempotent', () => {
    assert.equal(normalizeTargetEmail('agent@example.com.;!').email, 'agent@example.com');
  });
});

// ---- handleDelegate harness ----

const MILLIE = 'assistant-agent-millie@example.com';

function makeDeps({ fleet, projects, fleetThrows = false, skillIndex } = {}) {
  const writes = [];
  let n = 0;
  const deps = {
    SKILL_INDEX: skillIndex !== undefined ? skillIndex : [{ id: 'delegation', name: 'Cross-Agent Delegation' }],
    log: () => {},
    now: () => '2026-07-12T00:00:00.000Z',
    generateId: () => `w-test-${++n}`,
    generateTitle: async (s) => String(s).slice(0, 40),
    firestoreWrite: async (col, id, doc) => { writes.push({ col, id, doc: JSON.parse(JSON.stringify(doc)) }); },
    firestoreQuery: async (col, filters) => {
      if (fleetThrows) throw new Error('registry unavailable');
      if (col !== 'fleet') return [];
      const all = fleet || [];
      if (!filters || filters.length === 0) return all;
      const email = filters[0]?.value?.stringValue;
      return all.filter(a => a.email === email);
    },
    writeHistory: async () => {},
    composeDelegationMarker: ({ targetEmail, ref }) => `@${targetEmail} [DELEGATION ref:${ref}]`,
    PROJECTS: projects || {},
    makeAddress: (channel, opts) => ({ channel, ...opts }),
    addressFromMeta: () => ({ channel: 'dashboard', fleet_agent: null }),
    AGENT_EMAIL: 'prime-agent-test@example.com',
    AGENT_ID: 'test',
  };
  return { deps, writes };
}

function makeEnvelope(overrides = {}) {
  return {
    id: 'm-1', type: 'M', status: 'active', children: [],
    source_channel: 'dashboard', source_meta: {}, project_id: 'proj-a',
    ...overrides,
  };
}

const FLEET_OK = [{ email: MILLIE, status: 'online', specialty: 'assistant' }];
const PROJECTS_OK = { 'proj-a': { id: 'proj-a', name: 'Project A', status: 'active', gchat_space_id: 'spaces/XYZ' } };

describe('handleDelegate validation gates', () => {
  it('rejects when the delegation skill is not installed (Prime) with direct-operation guidance', async () => {
    const { deps, writes } = makeDeps({ fleet: FLEET_OK, projects: PROJECTS_OK, skillIndex: [] });
    const res = await handleDelegate(
      { envelope: makeEnvelope(), decision: { target_email: MILLIE, instruction: 'x' } }, deps);
    assert.equal(res.continue, true);
    assert.match(res.priorResultsAppend[0].result, /not available to this agent/);
    assert.match(res.priorResultsAppend[0].result, /SSH/);
    assert.equal(writes.length, 0);
  });

  it('rejects a projectless mission (delegation is project-scoped)', async () => {
    const { deps, writes } = makeDeps({ fleet: FLEET_OK, projects: PROJECTS_OK });
    const res = await handleDelegate(
      { envelope: makeEnvelope({ project_id: null }), decision: { target_email: MILLIE, instruction: 'x' } }, deps);
    assert.equal(res.continue, true);
    assert.match(res.priorResultsAppend[0].result, /only available within a project context/);
    assert.match(res.priorResultsAppend[0].result, /proj-a/);
    assert.equal(writes.length, 0);
  });

  it('rejects an unknown project id', async () => {
    const { deps, writes } = makeDeps({ fleet: FLEET_OK, projects: PROJECTS_OK });
    const res = await handleDelegate(
      { envelope: makeEnvelope({ project_id: 'no-such-project' }), decision: { target_email: MILLIE, instruction: 'x' } }, deps);
    assert.equal(res.continue, true);
    assert.match(res.priorResultsAppend[0].result, /unknown project "no-such-project"/);
    assert.equal(writes.length, 0);
  });

  it('rejects an invalid email shape without writing anything', async () => {
    const { deps, writes } = makeDeps({ fleet: FLEET_OK, projects: PROJECTS_OK });
    const res = await handleDelegate(
      { envelope: makeEnvelope(), decision: { target_email: 'millie', instruction: 'do the thing' } }, deps);
    assert.equal(res.continue, true);
    assert.match(res.priorResultsAppend[0].result, /not a valid email/);
    assert.equal(writes.length, 0);
  });

  it('rejects self-delegation', async () => {
    const { deps, writes } = makeDeps({ fleet: FLEET_OK, projects: PROJECTS_OK });
    const res = await handleDelegate(
      { envelope: makeEnvelope(), decision: { target_email: 'prime-agent-test@example.com', instruction: 'x' } }, deps);
    assert.equal(res.continue, true);
    assert.match(res.priorResultsAppend[0].result, /yourself/);
    assert.equal(writes.length, 0);
  });

  it('rejects an unregistered target and lists the fleet roster', async () => {
    const { deps, writes } = makeDeps({ fleet: FLEET_OK, projects: PROJECTS_OK });
    const res = await handleDelegate(
      { envelope: makeEnvelope(), decision: { target_email: 'ghost-agent@example.com', instruction: 'x' } }, deps);
    assert.equal(res.continue, true);
    assert.match(res.priorResultsAppend[0].result, /not a registered online fleet agent/);
    assert.match(res.priorResultsAppend[0].result, new RegExp(MILLIE));
    assert.equal(writes.length, 0);
  });

  it('rejects an offline target', async () => {
    const { deps, writes } = makeDeps({
      fleet: [{ email: MILLIE, status: 'offline', specialty: 'assistant' }],
      projects: PROJECTS_OK,
    });
    const res = await handleDelegate(
      { envelope: makeEnvelope(), decision: { target_email: MILLIE, instruction: 'x' } }, deps);
    assert.equal(res.continue, true);
    assert.equal(writes.length, 0);
  });

  it('rejects a spaceless project and names the projects that have spaces', async () => {
    const { deps, writes } = makeDeps({
      fleet: FLEET_OK,
      projects: {
        general: { id: 'general', name: 'General', status: 'active' },
        'proj-a': PROJECTS_OK['proj-a'],
      },
    });
    const res = await handleDelegate(
      { envelope: makeEnvelope({ project_id: 'general' }), decision: { target_email: MILLIE, instruction: 'x' } }, deps);
    assert.equal(res.continue, true);
    assert.match(res.priorResultsAppend[0].result, /no GChat space/);
    assert.match(res.priorResultsAppend[0].result, /proj-a/);
    assert.equal(writes.length, 0);
  });

  it('advises needs_input when NO project has a space', async () => {
    const { deps } = makeDeps({ fleet: FLEET_OK, projects: { general: { id: 'general' } } });
    const res = await handleDelegate(
      { envelope: makeEnvelope({ project_id: 'general' }), decision: { target_email: MILLIE, instruction: 'x' } }, deps);
    assert.match(res.priorResultsAppend[0].result, /needs_input/);
  });

  it('proceeds when the fleet registry is unavailable (degraded, not blocked)', async () => {
    const { deps, writes } = makeDeps({ projects: PROJECTS_OK, fleetThrows: true });
    const res = await handleDelegate(
      { envelope: makeEnvelope(), decision: { target_email: MILLIE, instruction: 'do the thing' } }, deps);
    assert.equal(res.exit, true);
    assert.ok(writes.length > 0);
  });
});

describe('handleDelegate checkpoint wrap (C-15)', () => {
  it('builds M→C→{T(delegation), T(ack)} with the send envelope under the delegation T', async () => {
    const { deps, writes } = makeDeps({ fleet: FLEET_OK, projects: PROJECTS_OK });
    const envelope = makeEnvelope();
    const res = await handleDelegate(
      { envelope, decision: { target_email: `${MILLIE}.`, instruction: 'analyze the mission', accept_criteria: 'a report' } }, deps);

    assert.equal(res.exit, true);

    const c = writes.find(w => w.doc.type === 'C');
    assert.ok(c, 'a Checkpoint envelope is created');
    assert.equal(c.doc.parent_id, 'm-1');
    assert.equal(c.doc.status, 'waiting');

    const t = writes.find(w => w.doc.intent === 'delegation');
    assert.equal(t.doc.parent_id, c.id, 'delegation T is parented to the Checkpoint, not the Mission');
    assert.equal(t.doc.status, 'waiting');
    // trailing dot normalized before anything was addressed
    assert.equal(t.doc.source_meta.target_agent_email, MILLIE);

    const send = writes.find(w => w.doc.intent === 'delegation_send');
    assert.equal(send.doc.parent_id, t.id);
    assert.equal(send.doc.delivery_target, MILLIE);
    assert.equal(send.doc.delivery_address.space, 'spaces/XYZ');
    assert.equal(t.doc.source_meta.delivery_envelope_id, send.id,
      'T carries its delivery envelope id for delivery-failure fast-fail');

    const ack = writes.find(w => w.doc.intent === 'notification');
    assert.equal(ack.doc.parent_id, c.id, 'ack T is parented to the Checkpoint, not the Mission');

    assert.deepEqual(c.doc.children, [t.id, ack.id]);

    const m = writes.find(w => w.id === 'm-1');
    assert.deepEqual(m.doc.children, [c.id], 'mission child is the Checkpoint');
    assert.equal(m.doc.status, 'waiting');
  });
});
