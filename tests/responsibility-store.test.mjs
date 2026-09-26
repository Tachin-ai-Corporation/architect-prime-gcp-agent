// tests/responsibility-store.test.mjs — an agent's own responsibilities, without Prime or an upgrade.
//
// Every writer used to edit the installed responsibilities-job.json in place — the
// agent's responsibility-manage, the dashboard toggle — and the next CoreKit upgrade
// reinstalled that file over them, so an agent's own changes vanished and the only
// change that stuck was a repo commit plus an upgrade (C-36). Three upgrades in one
// day moved one weekly job by five minutes. These tests pin the replacement: the
// agent's store (Firestore) layered over the shipped defaults, merged by one module
// that the scheduler, the dashboard and the CLI all share.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScheduler, cronNextFire } from '../platform/work/scheduler.mjs';
import {
  mergeResponsibilities, planWrite, applyPatch, checkCron, checkFrequency,
  storeParent, resolvePolicy, describeProvenance, DEFAULT_POLICY,
} from '../platform/work/responsibility-store.mjs';
import { sealRevision } from '../platform/contracts/index.mjs';
import { importResponsibility } from '../platform/deployment/importer.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const shippedExec = () => ({
  id: 'r-exec',
  name: 'Weekly Exec',
  schedule: '15 10 * * 4',
  timezone: 'America/Chicago',
  enabled: true,
  singleton: true,
  instruction: 'Produce this week\'s executive update from the meeting notes.',
  success_criteria: 'One doc for this week exists and its sections were read back.',
  context: { purpose: 'Run the weekly exec sync.', process: ['gather', 'synthesize', 'deliver'] },
  _source: 'responsibilities-job.json',
});
const lockedBase = () => ({
  id: 'r-memory-consolidation', name: 'Consolidation', schedule: '0 8 * * *', enabled: true, locked: true,
  instruction: 'Consolidate memory every night.', context: { success_criteria: 'Memory was consolidated and reported.' },
  _source: 'responsibilities.json',
});
const own = (over = {}) => ({
  id: 'r-standup', name: 'Standup digest', schedule: '0 9 * * 1-5', timezone: 'UTC', enabled: true,
  instruction: 'Post a digest of yesterday\'s work to the team space.',
  success_criteria: 'A digest was posted and names each finished item.',
  context: { purpose: 'Keep the team current.', process: ['read the ledger', 'write the digest', 'post it'] },
  ...over,
});
const opts = { policy: DEFAULT_POLICY, nextFire: cronNextFire };

describe('layering: shipped defaults, overrides, and the agent\'s own', () => {
  it('an override changes only the fields it names — the rest keeps flowing from the shipped default', () => {
    const doc = { id: 'r-exec', mode: 'override', status: 'active', revision: 2, updated_by: 'millie', patch: { schedule: '20 10 * * 4', context: { process: ['gather by name', 'deliver'] } } };
    const { effective, issues } = mergeResponsibilities([shippedExec()], [doc], opts);
    assert.deepEqual(issues, []);
    const r = effective[0];
    assert.equal(r.schedule, '20 10 * * 4');
    assert.equal(r.timezone, 'America/Chicago', 'untouched fields come from the shipped default');
    assert.deepEqual(r.context.process, ['gather by name', 'deliver']);
    assert.equal(r.context.purpose, 'Run the weekly exec sync.', 'context merges key by key');
    assert.equal(r._provenance.origin, 'override');
    assert.equal(r._provenance.revision, 2);
    assert.match(describeProvenance(r), /responsibilities-job\.json \+ override \(rev 2, by millie\)/);
  });

  it('a responsibility the agent created is added; one it adopted replaces the shipped default', () => {
    const docs = [
      { id: 'r-standup', mode: 'own', status: 'active', revision: 1, updated_by: 'millie', body: own() },
      { id: 'r-exec', mode: 'own', status: 'active', revision: 1, updated_by: 'millie', adopted_from: 'responsibilities-job.json', body: { ...shippedExec(), _source: undefined, instruction: 'Her own version of the weekly update.' } },
    ];
    const { effective } = mergeResponsibilities([shippedExec()], docs, opts);
    const byId = Object.fromEntries(effective.map((r) => [r.id, r]));
    assert.equal(byId['r-standup']._provenance.origin, 'agent');
    assert.equal(byId['r-exec'].instruction, 'Her own version of the weekly update.');
    assert.match(describeProvenance(byId['r-exec']), /adopted from responsibilities-job\.json/);
  });

  it('a locked platform responsibility ignores every store record', () => {
    const doc = { id: 'r-memory-consolidation', mode: 'override', status: 'active', revision: 1, updated_by: 'millie', patch: { enabled: false } };
    const { effective, issues } = mergeResponsibilities([lockedBase()], [doc], opts);
    assert.equal(effective[0].enabled, true, 'consolidation keeps running');
    assert.match(issues[0].reason, /locked/);
  });

  it('a bad store record never takes a responsibility away — the shipped default keeps running', () => {
    const docs = [
      { id: 'r-exec', mode: 'override', status: 'active', revision: 3, updated_by: 'x', patch: { schedule: 'every thursday' } },
      { id: 'r-loop', mode: 'own', status: 'active', revision: 1, updated_by: 'x', body: own({ id: 'r-loop', schedule: '*/5 * * * *' }) },
      { id: 'r-gone', mode: 'override', status: 'active', revision: 1, updated_by: 'x', patch: { enabled: false } },
      { id: 'r-old', mode: 'own', status: 'removed', revision: 2, updated_by: 'x', body: own({ id: 'r-old' }) },
    ];
    const { effective, issues } = mergeResponsibilities([shippedExec()], docs, opts);
    assert.deepEqual(effective.map((r) => r.id), ['r-exec']);
    assert.equal(effective[0].schedule, '15 10 * * 4', 'an unreadable override falls back to the default');
    assert.equal(effective[0]._provenance.origin, 'shipped');
    const reasons = issues.map((i) => `${i.id}: ${i.reason}`).join('\n');
    assert.match(reasons, /r-exec: .*five-field|r-exec: .*schedule/);
    assert.match(reasons, /r-loop: .*5 minute\(s\) apart/);
    assert.match(reasons, /r-gone: .*no shipped default/);
    assert.doesNotMatch(reasons, /r-old/, 'a removed record is history, not an issue');
  });
});

describe('authoring: planWrite decides every write', () => {
  const base = { actor: 'millie', policy: DEFAULT_POLICY, nextFire: cronNextFire, now: '2026-09-26T00:00:00.000Z' };

  it('create writes the agent\'s own record — complete, valid, and never over a shipped id', () => {
    const ok = planWrite({ ...base, verb: 'create', id: 'r-standup', input: own() });
    assert.equal(ok.ok, true);
    assert.equal(ok.doc.mode, 'own');
    assert.equal(ok.doc.revision, 1);
    assert.equal(ok.doc.updated_by, 'millie');
    const missing = planWrite({ ...base, verb: 'create', id: 'r-x', input: { id: 'r-x', name: 'X', schedule: '0 9 * * *' } });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /instruction/);
    assert.match(missing.error, /context\.purpose/);
    const clash = planWrite({ ...base, verb: 'create', id: 'r-exec', input: own({ id: 'r-exec' }), shipped: shippedExec() });
    assert.match(clash.error, /use update to change it, or adopt/);
  });

  it('update on a shipped default stores only the change, as an override', () => {
    const p = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { schedule: '20 10 * * 4' }, shipped: shippedExec() });
    assert.equal(p.ok, true);
    assert.equal(p.doc.mode, 'override');
    assert.deepEqual(p.doc.patch, { schedule: '20 10 * * 4' });
    const next = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { enabled: false }, shipped: shippedExec(), current: { ...p.doc, updateTime: 't' } });
    assert.deepEqual(next.doc.patch, { schedule: '20 10 * * 4', enabled: false }, 'patches accumulate');
    assert.equal(next.doc.revision, 2);
  });

  it('refuses what the scheduler could not run: bad cron, unknown zone, a schedule under the floor', () => {
    const cron = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { schedule: '15 10 * * THU' }, shipped: shippedExec() });
    assert.match(cron.error, /day of week 'THU'/);
    const zone = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { timezone: 'Central' }, shipped: shippedExec() });
    assert.match(zone.error, /not an IANA zone/);
    const fast = planWrite({ ...base, verb: 'create', id: 'r-fast', input: own({ id: 'r-fast', schedule: '*/10 * * * *' }) });
    assert.match(fast.error, /10 minute\(s\) apart; the floor between two fires is 15/);
  });

  it('locked platform upkeep cannot be changed, disabled, adopted or reset by anyone', () => {
    for (const verb of ['update', 'adopt', 'reset']) {
      const p = planWrite({ ...base, verb, id: 'r-memory-consolidation', input: verb === 'update' ? { enabled: false } : {}, shipped: lockedBase() });
      assert.equal(p.ok, false, verb);
      assert.match(p.error, /locked/);
    }
    const self = planWrite({ ...base, verb: 'create', id: 'r-mine', input: own({ id: 'r-mine', locked: true }) });
    assert.match(self.error, /reserved for platform responsibilities/);
  });

  it('remove deletes only what the agent created; reset drops changes to a shipped default', () => {
    const current = { id: 'r-standup', mode: 'own', status: 'active', revision: 4, body: own(), updateTime: 't' };
    const rm = planWrite({ ...base, verb: 'remove', id: 'r-standup', current });
    assert.equal(rm.doc.status, 'removed');
    assert.equal(rm.doc.revision, 5, 'removal is a revision — the history keeps it');
    const shippedRm = planWrite({ ...base, verb: 'remove', id: 'r-exec', shipped: shippedExec() });
    assert.match(shippedRm.error, /toggle, or drop your changes with reset/);
    const override = { id: 'r-exec', mode: 'override', status: 'active', revision: 1, patch: { enabled: false }, updateTime: 't' };
    const reset = planWrite({ ...base, verb: 'reset', id: 'r-exec', current: override, shipped: shippedExec() });
    assert.equal(reset.doc.status, 'removed');
  });

  it('adopt copies the running definition (default + override) into the agent\'s own record', () => {
    const override = { id: 'r-exec', mode: 'override', status: 'active', revision: 1, patch: { schedule: '20 10 * * 4' }, updateTime: 't' };
    const p = planWrite({ ...base, verb: 'adopt', id: 'r-exec', current: override, shipped: shippedExec() });
    assert.equal(p.ok, true);
    assert.equal(p.doc.mode, 'own');
    assert.equal(p.doc.body.schedule, '20 10 * * 4', 'the override it already had is kept');
    assert.equal(p.doc.adopted_from, 'responsibilities-job.json');
    assert.equal(p.doc.body._source, undefined, 'scratch fields never reach the store');
  });

  it('revert restores an earlier revision as a new one', () => {
    const current = { id: 'r-standup', mode: 'own', status: 'active', revision: 3, body: own({ schedule: '0 7 * * 1-5' }), updateTime: 't' };
    const rev1 = { id: 'r-standup', mode: 'own', status: 'active', revision: 1, body: own() };
    const p = planWrite({ ...base, verb: 'revert', id: 'r-standup', current, revisionDoc: rev1 });
    assert.equal(p.doc.revision, 4);
    assert.equal(p.doc.reverted_from, 1);
    assert.equal(p.doc.body.schedule, '0 9 * * 1-5');
  });

  it('Prime can edit a fleet agent it cannot see into: an override is written and checked field by field', () => {
    const p = planWrite({ ...base, actor: 'prime:candicejr', verb: 'update', id: 'r-exec', input: { schedule: '20 10 * * 4' }, shippedKnown: false });
    assert.equal(p.ok, true);
    assert.equal(p.doc.mode, 'override');
    assert.equal(p.doc.updated_by, 'prime:candicejr');
    assert.match(p.summary, /applies if the agent ships 'r-exec'/);
    const bad = planWrite({ ...base, actor: 'prime:candicejr', verb: 'update', id: 'r-exec', input: { schedule: 'weekly' }, shippedKnown: false });
    assert.equal(bad.ok, false);
  });

  it('caps what one agent may own outright', () => {
    const p = planWrite({ ...base, verb: 'create', id: 'r-26', input: own({ id: 'r-26' }), ownCount: DEFAULT_POLICY.max_per_agent });
    assert.match(p.error, /limit is 25/);
  });
});

describe('the scheduler runs the agent\'s store without a restart', () => {
  function harness(shipped, loadStore) {
    const root = mkdtempSync(join(tmpdir(), 'sched-store-'));
    mkdirSync(join(root, 'corekit'), { recursive: true });
    writeFileSync(join(root, 'corekit', 'responsibilities-job.json'), JSON.stringify({ version: 2, responsibilities: shipped }));
    const missions = [];
    const logs = [];
    let n = 0;
    const s = createScheduler({
      config: { coreDir: root, agentId: 'probe' },
      logger: (level, msg) => logs.push(`${level} ${msg}`),
      generateId: (p) => `${p}-${++n}`,
      writeHistory: async () => {},
      recallMemory: async () => ({}),
      processEnvelope: async () => {},
      getDefaultProjectId: () => null,
      firestoreWrite: async (col, _id, doc) => {
        if (col === 'work' && doc.type === 'M' && doc.memory_context === null) missions.push(doc);
      },
      loadStore,
      policy: { ...DEFAULT_POLICY, refresh_ms: 60_000 },
    });
    s.loadResponsibilities();
    const done = () => { s.stop(); rmSync(root, { recursive: true, force: true }); };
    return { s, missions, logs, done };
  }
  const exec = () => { const r = shippedExec(); delete r._source; return r; };

  it('an override written after start moves the fire time within one refresh', async () => {
    let docs = [];
    const h = harness([exec()], async () => docs);
    try {
      h.s.start(new Date('2026-09-26T12:00:00Z'));
      h.s.stop();
      await h.s.refreshStore(new Date('2026-09-26T12:00:00Z'), { force: true });
      assert.equal(h.s.getNextFires()['r-exec'].toISOString(), '2026-10-01T15:15:00.000Z');
      docs = [{ id: 'r-exec', mode: 'override', status: 'active', revision: 1, updated_by: 'millie', patch: { schedule: '20 10 * * 4' } }];
      await h.s.tick(new Date('2026-09-26T12:05:00Z'));
      assert.equal(h.s.getNextFires()['r-exec'].toISOString(), '2026-10-01T15:20:00.000Z', 'no restart, no upgrade');
      assert.equal(await (async () => { await h.s.tick(new Date('2026-10-01T15:20:20Z')); return h.missions.length; })(), 1);
      assert.equal(h.missions[0].source_meta.responsibility_origin, 'override');
      assert.equal(h.missions[0].source_meta.responsibility_revision, 1, 'the work pins the revision that produced it (C-32)');
    } finally { h.done(); }
  });

  it('a responsibility the agent creates is armed and fires — even when nothing was shipped', async () => {
    const docs = [{ id: 'r-standup', mode: 'own', status: 'active', revision: 1, updated_by: 'millie', body: own() }];
    const h = harness([], async () => docs);
    try {
      h.s.start(new Date('2026-09-28T08:00:00Z'));
      h.s.stop();
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      assert.equal(h.s.getNextFires()['r-standup'].toISOString(), '2026-09-28T09:00:00.000Z');
      await h.s.tick(new Date('2026-09-28T09:00:20Z'));
      assert.equal(h.missions.length, 1);
      assert.equal(h.missions[0].source_meta.responsibility_origin, 'agent');
    } finally { h.done(); }
  });

  it('an unreadable store keeps the last good set', async () => {
    let fail = false;
    const docs = [{ id: 'r-standup', mode: 'own', status: 'active', revision: 1, updated_by: 'millie', body: own() }];
    const h = harness([], async () => { if (fail) throw new Error('HTTP 503'); return docs; });
    try {
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      fail = true;
      await h.s.refreshStore(new Date('2026-09-28T08:05:00Z'), { force: true });
      assert.deepEqual(h.s.getResponsibilities().map((r) => r.id), ['r-standup'], 'an outage is not "no responsibilities"');
      assert.ok(h.logs.some((l) => /store unreadable .*keeping the last good set/.test(l)));
    } finally { h.done(); }
  });

  it('changing one responsibility does not re-arm the others (a due slot is never dropped)', async () => {
    let docs = [];
    const other = { ...exec(), id: 'r-daily', schedule: '0 9 * * *', timezone: 'UTC' };
    const h = harness([exec(), other], async () => docs);
    try {
      h.s.start(new Date('2026-09-28T08:59:00Z'));
      h.s.stop();
      await h.s.refreshStore(new Date('2026-09-28T08:59:00Z'), { force: true });
      // r-daily came due at 09:00; before the tick that would fire it, an unrelated edit lands.
      docs = [{ id: 'r-exec', mode: 'override', status: 'active', revision: 1, updated_by: 'millie', patch: { enabled: false } }];
      await h.s.refreshStore(new Date('2026-09-28T09:00:30Z'), { force: true });
      assert.equal(h.s.getNextFires()['r-daily'].toISOString(), '2026-09-28T09:00:00.000Z', 'still armed for the slot that is due');
      await h.s.tick(new Date('2026-09-28T09:00:40Z'));
      assert.deepEqual(h.missions.map((m) => m.source_meta.responsibility_id), ['r-daily']);
    } finally { h.done(); }
  });

  it('an event responsibility fires from the effective set, not only the platform base file', async () => {
    const docs = [{ id: 'r-on-fail', mode: 'own', status: 'active', revision: 1, updated_by: 'millie', body: own({ id: 'r-on-fail', schedule: null, event: 'on_failure' }) }];
    const h = harness([], async () => docs);
    try {
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      await h.s.fireEvent('on_failure', { mission_id: 'w-1' });
      assert.deepEqual(h.missions.map((m) => m.source_meta.responsibility_id), ['r-on-fail']);
      assert.equal(h.missions[0].source_meta.fired_by_event, 'on_failure');
    } finally { h.done(); }
  });

  it('an on_complete responsibility cannot loop on its own missions, and events are spaced', async () => {
    const docs = [{ id: 'r-after', mode: 'own', status: 'active', revision: 1, updated_by: 'millie', body: own({ id: 'r-after', schedule: null, event: 'on_complete', min_spacing_minutes: 0 }) }];
    const h = harness([], async () => docs);
    try {
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      await h.s.fireEvent('on_complete', { mission_id: 'w-user' });
      assert.equal(h.missions.length, 1, 'a user mission completing fires it');
      // Its own mission completes: the brain passes where that mission came from.
      await h.s.fireEvent('on_complete', { mission_id: 'w-2', responsibility_id: 'r-after', fired_by_event: 'on_complete' });
      assert.equal(h.missions.length, 1, 'no chain from an event-fired mission');
      await h.s.fireEvent('on_complete', { mission_id: 'w-user-2' });
      assert.equal(h.missions.length, 1, 'the floor spaces events even when min_spacing_minutes is 0');
      assert.ok(h.logs.some((l) => /skipping .* min 15m/.test(l)));
    } finally { h.done(); }
  });
});

describe('where the store lives, and what may never write an installed file', () => {
  it('the store sits beside Core Memory: a fleet agent under its prime, a Prime at its root', () => {
    assert.equal(storeParent({ primeId: 'candicejr', agentId: 'millie' }), 'primes/candicejr/fleet/millie');
    assert.equal(storeParent({ primeId: 'candicejr', isPrime: true }), 'primes/candicejr');
    assert.throws(() => storeParent({ primeId: 'candicejr' }), /agentId is required/);
  });

  it('no responsibility writer edits an installed responsibilities file any more', () => {
    const introspect = readFileSync(join(repo, 'platform', 'runtime', 'agent-introspect.mjs'), 'utf8');
    assert.doesNotMatch(introspect, /writeFileSync\([^)]*respFiles|writeFileSync\(filePath, JSON\.stringify\(data/,
      'the dashboard toggle edited responsibilities-job.json in place — the next upgrade reverted it');
    const cli = readFileSync(join(repo, 'corekit', 'brain', 'responsibility-manage.mjs'), 'utf8')
      + readFileSync(join(repo, 'corekit', 'brain', 'responsibility-manage'), 'utf8');
    assert.doesNotMatch(cli, /responsibilities-job\.json|open\('\$RESP_FILE', 'w'\)/, 'the CLI writes the store, never the installed file');
    assert.match(cli, /db\.commit\(/);
  });

  it('platform upkeep is locked; the policy is a contract value', () => {
    for (const [f, ids] of [
      ['corekit/config/responsibilities.json', ['r-memory-consolidation', 'r-git-gc']],
      ['corekit/config/responsibilities-prime.json', ['r-fleet-improvement-review', 'r-fleet-drift-check']],
    ]) {
      const list = JSON.parse(readFileSync(join(repo, f), 'utf8')).responsibilities;
      for (const id of ids) assert.equal(list.find((r) => r.id === id)?.locked, true, `${id} must be locked`);
    }
    const contracts = JSON.parse(readFileSync(join(repo, 'infra', 'contracts.json'), 'utf8'));
    assert.deepEqual(resolvePolicy(contracts), { refresh_ms: 60000, min_interval_minutes: 15, max_per_agent: 25 });
  });

  it('every shipped default can be turned off by its agent — except locked platform upkeep', () => {
    // Measured on the real files: a toggle is the smallest override, and it must never be
    // refused over a field the agent did not touch (a template ships YOUR_PROJECT_ID).
    const files = [join(repo, 'corekit', 'config', 'responsibilities.json'), join(repo, 'corekit', 'config', 'responsibilities-prime.json')];
    for (const d of readdirSync(join(repo, 'specialties'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of readdirSync(join(repo, 'specialties', d.name))) {
        if (/^responsibilities-.+\.json$/.test(f)) files.push(join(repo, 'specialties', d.name, f));
      }
    }
    let n = 0;
    for (const f of files) {
      for (const r of JSON.parse(readFileSync(f, 'utf8')).responsibilities || []) {
        n += 1;
        const p = planWrite({ verb: 'update', id: r.id, input: { enabled: false }, shipped: r, actor: 'probe', policy: DEFAULT_POLICY, nextFire: cronNextFire });
        if (r.locked) assert.equal(p.ok, false, `${r.id} is locked`);
        else assert.equal(p.ok, true, `${f}: ${r.id} — ${p.error}`);
      }
    }
    assert.ok(n >= 4, `expected the shipped responsibilities, saw ${n}`);
  });
});

describe('Prime\'s release path carries what the scheduler reads', () => {
  it('a catalog responsibility imports into a valid v2 revision with its playbook and guards', () => {
    const raw = JSON.parse(readFileSync(join(repo, 'corekit', 'config', 'responsibilities.json'), 'utf8'))
      .responsibilities.find((r) => r.id === 'r-memory-consolidation');
    const draft = importResponsibility(raw, 'base');
    assert.equal(draft.trigger, undefined, 'the v1 trigger object is gone');
    assert.equal(draft.processRef, raw.processRef);
    assert.equal(draft.locked, true);
    assert.equal(draft.triggerable, true);
    assert.ok(sealRevision('responsibility', draft, { actor: 'seed' }), 'the registry accepts it');
  });

  it('the compiler emits processRef, triggerable and locked', () => {
    const compiler = readFileSync(join(repo, 'platform', 'deployment', 'compiler.mjs'), 'utf8');
    for (const f of ['processRef', 'triggerable', 'locked']) assert.match(compiler, new RegExp(`${f}:`), f);
  });
});

describe('cron validation matches what the scheduler can read', () => {
  it('accepts the forms the matcher implements and refuses the rest', () => {
    for (const ok of ['0 8 * * *', '20 10 * * 4', '*/15 * * * *', '0 9 * * 1-5', '0 9,17 * * *', '0 9 1 * *']) {
      assert.equal(checkCron(ok), null, ok);
    }
    for (const bad of ['0 8 * *', '0 25 * * *', '0 9 * * 7', '0 9 * * MON', '0 9 1-5/2 * *', '*/0 * * * *']) {
      assert.notEqual(checkCron(bad), null, bad);
    }
    assert.equal(checkFrequency('0 9 * * *', 15, cronNextFire), null);
    assert.match(checkFrequency('0,5 9 * * *', 15, cronNextFire), /5 minute/);
  });

  it('applyPatch never lets a patch rename a responsibility', () => {
    assert.equal(applyPatch({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }).id, 'a');
  });
});
