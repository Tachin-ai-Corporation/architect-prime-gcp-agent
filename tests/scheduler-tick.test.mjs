// tests/scheduler-tick.test.mjs — the tick loop keeps every schedule armed, in its own zone.
//
// Regression (2026-09-24): cronNextFire looked 48h ahead and the tick loop skipped a
// null next-fire forever, so a WEEKLY responsibility fired once after a restart and
// then never again. r-weekly-exec-update's Thursday slot passed silently while the
// daily consolidation beside it fired every morning — a daily slot is always inside
// 48h, a weekly one never is. Separately, the declared `timezone` was ignored, so a
// schedule written for Central time was matched in UTC.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScheduler } from '../platform/work/scheduler.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

function harness(responsibilities, extraDeps = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sched-tick-'));
  mkdirSync(join(root, 'corekit'), { recursive: true });
  writeFileSync(join(root, 'corekit', 'responsibilities.json'),
    JSON.stringify({ version: 2, responsibilities }));
  const missions = []; // responsibility id of each mission created
  const missionDocs = []; // the first write of each M, as written
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
      // fireResponsibility writes each M twice (created, then with recalled memory) — count the first.
      if (col === 'work' && doc.type === 'M' && doc.memory_context === null) {
        missions.push(doc.source_meta.responsibility_id);
        missionDocs.push(JSON.parse(JSON.stringify(doc)));
      }
    },
    ...extraDeps,
  });
  s.loadResponsibilities();
  const firesAt = async (iso) => {
    const before = missions.length;
    await s.tick(new Date(iso));
    return missions.length - before;
  };
  const done = () => { s.stop(); rmSync(root, { recursive: true, force: true }); };
  return { s, logs, firesAt, missionDocs, done };
}

describe('scheduler tick — long-period schedules stay armed', () => {
  it('a weekly responsibility fires on consecutive weeks without a restart', async () => {
    const h = harness([{ id: 'r-weekly', name: 'Weekly', schedule: '30 15 * * 4', enabled: true, min_spacing_minutes: 1440 }]);
    try {
      h.s.start(new Date('2026-09-11T12:00:00Z')); // a Friday: the next slot is 6 days out
      h.s.stop();
      assert.equal(h.s.getNextFires()['r-weekly']?.toISOString(), '2026-09-17T15:30:00.000Z',
        'armed at start — with the 48h horizon this was null');
      assert.equal(await h.firesAt('2026-09-17T15:30:20Z'), 1, 'week 1');
      assert.equal(h.s.getNextFires()['r-weekly']?.toISOString(), '2026-09-24T15:30:00.000Z',
        'firing re-arms a week out — this is the step that used to go null');
      assert.equal(await h.firesAt('2026-09-24T15:29:20Z'), 0, 'not before its minute');
      assert.equal(await h.firesAt('2026-09-24T15:30:20Z'), 1, 'week 2 — the slot that was missed live');
    } finally { h.done(); }
  });

  it('a min-spacing skip re-arms the following week (the live 2026-09-17 path)', async () => {
    // Live, an operator run 20.5h before the slot put it inside min_spacing; the skip
    // then re-armed to null. A spacing wider than a week reproduces the skip via tick.
    const h = harness([{ id: 'r-weekly', name: 'Weekly', schedule: '30 15 * * 4', enabled: true, min_spacing_minutes: 20000 }]);
    try {
      h.s.start(new Date('2026-09-11T12:00:00Z'));
      h.s.stop();
      assert.equal(await h.firesAt('2026-09-17T15:30:20Z'), 1);
      assert.equal(await h.firesAt('2026-09-24T15:30:20Z'), 0, 'inside min spacing → skipped');
      assert.ok(h.logs.some((l) => l.includes('r-weekly skipped (min spacing')));
      assert.equal(h.s.getNextFires()['r-weekly']?.toISOString(), '2026-10-01T15:30:00.000Z',
        'the skip must re-arm a week out, not to null');
      assert.equal(await h.firesAt('2026-10-01T15:30:20Z'), 1);
    } finally { h.done(); }
  });

  it('a slot beyond the horizon is armed as it comes into range (monthly)', async () => {
    const h = harness([{ id: 'r-monthly', name: 'Monthly', schedule: '0 9 1 * *', enabled: true }]);
    try {
      h.s.start(new Date('2026-09-01T09:30:00Z'));
      h.s.stop();
      assert.equal(h.s.getNextFires()['r-monthly'], null, 'Oct 1 is 30 days out — beyond the horizon at start');
      assert.equal(await h.firesAt('2026-09-24T09:00:00Z'), 0);
      assert.equal(h.s.getNextFires()['r-monthly']?.toISOString(), '2026-10-01T09:00:00.000Z',
        'a null next-fire is re-armed, not skipped forever');
      assert.equal(await h.firesAt('2026-10-01T09:00:20Z'), 1);
    } finally { h.done(); }
  });

  it('an event-only responsibility (no schedule) is left to fireEvent, not crashed on', () => {
    const h = harness([{ id: 'r-event', name: 'Event', event: 'mission.failed', enabled: true }]);
    try {
      assert.doesNotThrow(() => { h.s.start(new Date('2026-09-24T10:00:00Z')); h.s.stop(); });
      assert.equal(h.s.getNextFires()['r-event'], undefined);
    } finally { h.done(); }
  });
});

describe('scheduler tick — the declared timezone is honored', () => {
  it('a zoned weekly responsibility fires at its local time on both sides of DST', async () => {
    const h = harness([{ id: 'r-exec', name: 'Exec', schedule: '15 10 * * 4', timezone: 'America/Chicago', enabled: true }]);
    try {
      h.s.start(new Date('2026-10-23T12:00:00Z'));
      h.s.stop();
      assert.equal(await h.firesAt('2026-10-29T10:15:20Z'), 0, '10:15 UTC is not 10:15 Central');
      assert.equal(await h.firesAt('2026-10-29T15:15:20Z'), 1, 'CDT: 10:15 local = 15:15Z');
      assert.equal(await h.firesAt('2026-11-05T15:15:20Z'), 0, 'after DST ends, 15:15Z is 09:15 local');
      assert.equal(await h.firesAt('2026-11-05T16:15:20Z'), 1, 'CST: 10:15 local = 16:15Z');
    } finally { h.done(); }
  });

  it('an unknown timezone schedules in UTC with a warning instead of breaking the loop', async () => {
    const h = harness([{ id: 'r-typo', name: 'Typo', schedule: '0 12 * * *', timezone: 'America/Chicgo', enabled: true }]);
    try {
      h.s.start(new Date('2026-09-24T10:00:00Z'));
      h.s.stop();
      assert.equal(h.s.getNextFires()['r-typo']?.toISOString(), '2026-09-24T12:00:00.000Z');
      assert.ok(h.logs.some((l) => l.startsWith('WARN') && l.includes("unknown timezone 'America/Chicgo'")));
      assert.equal(await h.firesAt('2026-09-24T12:00:20Z'), 1);
    } finally { h.done(); }
  });
});

describe('scheduler — processRef is honored', () => {
  // Documented as "the playbook the fired mission recalls", processRef was read by nothing: the
  // mission saw only context.process. It is now resolved at fire time and carried as a prior.
  const PLAYBOOK = { id: 'p-probe', name: 'Probe Playbook', narrative: 'Gather first, then synthesize from the full notes.', status: 'active' };
  const resp = { id: 'r-pb', name: 'PB', schedule: '0 8 * * *', enabled: true, processRef: 'p-probe', instruction: 'Do the thing.' };

  it('carries the playbook narrative into the mission as its planning prior, and stamps it for the lesson reflex', async () => {
    const h = harness([resp], { getProcess: async (id) => (id === 'p-probe' ? PLAYBOOK : null) });
    try {
      h.s.start(new Date('2026-09-24T07:00:00Z')); h.s.stop();
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1);
      const [m] = h.missionDocs;
      assert.match(m.context_summary, /PLAYBOOK — Probe Playbook \(p-probe\): Gather first, then synthesize from the full notes\./);
      assert.equal(m.source_meta.process_ref, 'p-probe');
      assert.deepEqual(m.recalled_processes, ['p-probe']);
    } finally { h.done(); }
  });

  it('a missing or retired playbook degrades to context.process alone — loudly, never silently', async () => {
    for (const found of [null, { ...PLAYBOOK, status: 'deprecated' }, { ...PLAYBOOK, narrative: '' }]) {
      const h = harness([resp], { getProcess: async () => found });
      try {
        h.s.start(new Date('2026-09-24T07:00:00Z')); h.s.stop();
        assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1, 'still fires');
        const [m] = h.missionDocs;
        assert.doesNotMatch(m.context_summary || '', /PLAYBOOK —/);
        assert.equal('process_ref' in m.source_meta, false);
        assert.ok(h.logs.some((l) => l.startsWith('WARN') && l.includes("processRef 'p-probe'")));
      } finally { h.done(); }
    }
  });

  it('with no process registry wired, it fires exactly as before', async () => {
    const h = harness([resp]);
    try {
      h.s.start(new Date('2026-09-24T07:00:00Z')); h.s.stop();
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1);
      assert.equal('recalled_processes' in h.missionDocs[0], false);
    } finally { h.done(); }
  });
});

describe('shipped responsibilities', () => {
  it('every processRef resolves to a shipped playbook seed', () => {
    const seeds = new Set();
    for (const dir of [join(repo, 'corekit', 'config', 'processes'), join(repo, 'operator', 'processes')]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json')) seeds.add(JSON.parse(readFileSync(join(dir, f), 'utf8')).id);
      }
    }
    const files = [
      join(repo, 'corekit', 'config', 'responsibilities.json'),
      join(repo, 'corekit', 'config', 'responsibilities-prime.json'),
      ...readdirSync(join(repo, 'specialties'), { withFileTypes: true }).filter((d) => d.isDirectory())
        .flatMap((d) => readdirSync(join(repo, 'specialties', d.name)).filter((f) => /^responsibilities-.+\.json$/.test(f))
          .map((f) => join(repo, 'specialties', d.name, f))),
    ];
    let refs = 0;
    for (const f of files) {
      for (const r of JSON.parse(readFileSync(f, 'utf8')).responsibilities || []) {
        if (!r.processRef) continue;
        refs += 1;
        assert.ok(seeds.has(r.processRef), `${r.id} → processRef '${r.processRef}' has no shipped playbook`);
      }
    }
    assert.ok(refs >= 2, `expected the shipped processRefs (consolidation, weekly exec), saw ${refs}`);
  });

  it('the weekly exec update takes its bindings from a project, not from memory', () => {
    const r = JSON.parse(readFileSync(join(repo, 'specialties', 'assistant', 'responsibilities-assistant.json'), 'utf8'))
      .responsibilities.find((x) => x.id === 'r-weekly-exec-update');
    assert.equal(r.project_id, 'exec-briefing');
    assert.equal(r.processRef, 'p-weekly-exec-update');
    const text = JSON.stringify(r);
    assert.doesNotMatch(text, /from (core )?memory|core-memory-read|READ MEMORY/i, 'ids are project resources — memory is pruned nightly');
    assert.match(text, /READ THE PROJECT/);
  });

  it('the weekly exec update never widens sharing, never trusts a remembered doc id, and finds notes by name', () => {
    // 2026-09-24: a run edited a TRASHED doc it remembered by id, and added "anyone with the link"
    // to an executive briefing because the text asked for a "shareable link". Google also re-creates
    // its Meet folders whenever the root is shared, so a pinned folder id goes stale.
    const r = JSON.parse(readFileSync(join(repo, 'specialties', 'assistant', 'responsibilities-assistant.json'), 'utf8'))
      .responsibilities.find((x) => x.id === 'r-weekly-exec-update');
    const text = JSON.stringify(r);
    assert.doesNotMatch(text, /shareable/i, '"shareable link" read as "make it link-shareable"');
    assert.match(text, /NEVER change the doc's sharing/);
    assert.match(text, /never reuse a doc id carried over from recall or an earlier run/);
    assert.doesNotMatch(text, /UPDATE that one/, 'the update path lost the scaffold; the doc is created fresh');
    assert.match(text, /BY ITS NAME/, 'Meet folders are forked by Google — the name is the stable handle');
    const playbook = JSON.parse(readFileSync(join(repo, 'operator', 'processes', 'p-weekly-exec-update.json'), 'utf8')).narrative;
    assert.doesNotMatch(playbook, /shareable|update that one|at exactly those ids/i, 'the playbook must not contradict the responsibility');
  });

  it('declare only five-field schedules in timezones the scheduler can honor', () => {
    // An unknown zone only WARNs at runtime and schedules in UTC — a typo in shipped
    // content would move a fire time by hours with nothing but a log line to show it.
    const files = [];
    const add = (dir, re) => {
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) if (re.test(f)) files.push(join(dir, f));
    };
    add(join(repo, 'corekit', 'config'), /^responsibilities.*\.json$/);
    add(join(repo, 'operator', 'responsibilities'), /\.json$/);
    for (const d of readdirSync(join(repo, 'specialties'), { withFileTypes: true })) {
      if (d.isDirectory()) add(join(repo, 'specialties', d.name), /^responsibilities-.+\.json$/);
    }
    let checked = 0;
    for (const f of files) {
      for (const r of JSON.parse(readFileSync(f, 'utf8')).responsibilities || []) {
        if (!r.schedule) continue;
        checked += 1;
        assert.equal(r.schedule.trim().split(/\s+/).length, 5, `${r.id}: five-field cron`);
        const tz = r.timezone || 'UTC';
        assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }),
          `${r.id} declares an unknown timezone '${tz}'`);
      }
    }
    assert.ok(checked >= 5, `expected the shipped schedules, saw ${checked}`);
  });
});
