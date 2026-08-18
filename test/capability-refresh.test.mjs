// An applied release must be a LIVE release (Finding G).
//
// Two things in agent-brain.mjs were built once at module load and never rebuilt:
// SKILL_INDEX, and CAPABILITY_MAP — the high-level map cortex plans against.
// content-sync restarts nothing, so a skill delivered by a Fleet release reached
// neither. Every other correctness property in the release path sits upstream of
// that, which makes this the step that decides whether any of it is observable.
//
// CAPABILITY_MAP was the worse of the two. It preferred a FILE,
// skill-capability-map.md, that skill-setup generated on DEPLOY — so the map
// refreshed only at a platform upgrade, and a brain restart did not help because
// it re-read the same stale file.
//
// agent-brain.mjs exports nothing and runs on import, so these tests lift the real
// function bodies out of the source and execute them. Reimplementing them here
// would prove only that two authors agreed (R-11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const brainSrc = readFileSync(join(repo, 'platform', 'runtime', 'agent-brain.mjs'), 'utf8');
const skillSetup = readFileSync(join(repo, 'corekit', 'system', 'skill-setup'), 'utf8');

/** Lift a top-level function body out of the daemon, anchored on a brace in column 0. */
function fnSource(name) {
  const lines = brainSrc.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`agent-brain.mjs no longer defines ${name}() — this test is stale, not passing`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

const FORMAT_FN = fnSource('formatCapabilityMapFromIndex');
const REFRESH_FN = fnSource('refreshCapabilities');

/**
 * Stand the two functions up over mutable module-ish state, with buildSkillIndex
 * and log injected so a rebuild can be driven.
 */
function harness(initialIndex, rebuilds) {
  const logs = [];
  const factory = new Function('deps', `
    let SKILL_INDEX = deps.initialIndex;
    let CAPABILITY_MAP = '';
    const log = deps.log;
    const buildSkillIndex = deps.buildSkillIndex;
    ${FORMAT_FN}
    ${REFRESH_FN}
    CAPABILITY_MAP = formatCapabilityMapFromIndex(SKILL_INDEX);
    return {
      refresh: refreshCapabilities,
      format: formatCapabilityMapFromIndex,
      state: () => ({ index: SKILL_INDEX, map: CAPABILITY_MAP }),
    };
  `);
  const queue = [...(rebuilds || [])];
  return {
    logs,
    ...factory({
      initialIndex,
      log: (level, msg) => logs.push(`${level}: ${msg}`),
      buildSkillIndex: () => (queue.length ? queue.shift() : initialIndex),
    }),
  };
}

const skill = (id, over = {}) => ({
  id, name: id, agent_parts: ['motor'], when_to_use: '', category: '', summary: '', ...over,
});

const BASE = [skill('workspace-git'), skill('web-search')];

// ---- the derivation itself ------------------------------------------------

test('the map groups by organ in the canonical order', () => {
  const h = harness(BASE);
  const map = h.format([
    skill('a', { agent_parts: ['motor'] }),
    skill('b', { agent_parts: ['cortex'] }),
    skill('c', { agent_parts: ['cerebellum'] }),
  ]);
  const organs = [...map.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(organs, ['cortex', 'motor', 'cerebellum'],
    'planning organs come first — the order is the reading order for cortex');
});

test('summary wins over when_to_use', () => {
  // The precedence the deleted out-of-process generator used. Losing it would
  // silently reword the map for the two shipped skills that set `summary`, which
  // is exactly the kind of difference nobody notices.
  const h = harness(BASE);
  const map = h.format([skill('x', { summary: 'the summary', when_to_use: 'the when_to_use' })]);
  assert.match(map, /the summary/);
  assert.doesNotMatch(map, /the when_to_use/);
});

test('a skill carries no path into the map', () => {
  // Cortex plans by outcome and must not be able to name another organ's tooling.
  const h = harness(BASE);
  const map = h.format([skill('x', { path: '/opt/corekit/skills/x/SKILL.md', when_to_use: 'do a thing' })]);
  assert.doesNotMatch(map, /SKILL\.md|\/opt\//);
});

test('an empty index yields an empty map, not a broken one', () => {
  const h = harness(BASE);
  assert.equal(h.format([]), '');
});

// ---- the refresh ----------------------------------------------------------

test('a release that adds a skill updates BOTH the index and the map', () => {
  // The map is the half that mattered: refreshing only SKILL_INDEX would leave
  // cortex planning against a capability set that no longer exists.
  const next = [...BASE, skill('legal-review', { name: 'Legal Review', summary: 'review contracts' })];
  const h = harness(BASE, [next]);

  assert.doesNotMatch(h.state().map, /Legal Review/, 'not there before the boundary');
  h.refresh('mission m-1');
  assert.equal(h.state().index.length, 3);
  assert.match(h.state().map, /Legal Review — review contracts/,
    'the capability map must move too, or an applied release is still not a live one');
  assert.ok(h.logs.some((l) => l.includes('+[legal-review]')), 'a real change must be reported');
});

test('a release that retires a skill removes it from both', () => {
  const next = [skill('workspace-git')];
  const h = harness(BASE, [next]);
  h.refresh('mission m-2');
  assert.deepEqual(h.state().index.map((s) => s.id), ['workspace-git']);
  assert.ok(h.logs.some((l) => l.includes('-[web-search]')));
});

test('an EMPTY rebuild is refused, and the previous capabilities are kept', () => {
  // buildSkillIndex swallows every error it meets and returns a SHORTER list
  // rather than failing. Shorter is legitimate — a release can retire a skill.
  // Empty never is: an agent always has base skills, so an empty result means the
  // scan glitched. Adopting it would strip every capability at that instant.
  const h = harness(BASE, [[]]);
  h.refresh('mission m-3');
  assert.equal(h.state().index.length, 2, 'the previous index must survive a failed scan');
  assert.match(h.state().map, /workspace-git/);
  assert.ok(h.logs.some((l) => l.startsWith('WARN') && /empty/.test(l)),
    'and it must say so — a silently smaller agent is the failure this guards');
});

test('an unchanged rebuild logs nothing', () => {
  // This runs before every mission. A line per mission saying "nothing changed"
  // is how a real change gets missed.
  const h = harness(BASE, [BASE.map((s) => ({ ...s }))]);
  h.refresh('mission m-4');
  assert.deepEqual(h.logs, []);
});

// ---- wiring ---------------------------------------------------------------

test('the refresh happens at the mission boundary, before the mission runs', () => {
  // Scoped to processEnvelope's own body. A first draft of this used indexOf on
  // the whole file and failed — because there is an EARLIER call to
  // _processEnvelopeInner, from the crash-recovery resume path. That is the next
  // test, and finding it is the reason this one is scoped rather than global.
  const bodyAt = brainSrc.indexOf('async function processEnvelope(');
  assert.ok(bodyAt > 0, 'processEnvelope must be findable');
  const body = brainSrc.slice(bodyAt);

  const call = body.indexOf('refreshCapabilities(`mission ');
  const inner = body.indexOf('await _processEnvelopeInner(');
  assert.ok(call > 0, 'refreshCapabilities must actually be called at the boundary');
  assert.ok(inner > 0);
  assert.ok(call < inner,
    'it must run BEFORE the mission body — refreshing after it would change nothing for that mission');
});

test('a resuming mission does NOT re-derive its capabilities (C-32)', () => {
  // The crash-recovery path re-enters _processEnvelopeInner directly to carry
  // checkpoint results back to cortex. That is one mission CONTINUING, not a new
  // one starting, and its capability set must stay fixed for its whole life — the
  // same rule content-sync's idle boundary enforces for the files themselves.
  // Refreshing there would let a release change an agent's abilities halfway
  // through work already planned against the old set.
  const resumeAt = brainSrc.indexOf('await _processEnvelopeInner(envelope, memory, null, true)');
  assert.ok(resumeAt > 0, 'the crash-recovery resume must be findable for this check to mean anything');

  // Nothing in the 1500 characters leading up to that re-entry may refresh.
  const before = brainSrc.slice(Math.max(0, resumeAt - 1500), resumeAt);
  assert.doesNotMatch(before, /refreshCapabilities\(/,
    'a resuming mission must keep the capabilities it was planned with');
});

test('the daemon no longer prefers the deploy-time file', () => {
  assert.doesNotMatch(brainSrc, /readFileSync\([^)]*skill-capability-map\.md/,
    'reading that file is what made the map refresh only at a platform upgrade');
});

test('skill-setup no longer writes the file, and removes the stale one', () => {
  assert.doesNotMatch(skillSetup, /wrote capability map/,
    'the generator must be gone, not merely uncalled');
  assert.match(skillSetup, /retire_capability_map/,
    'and the file it used to write must be cleaned up, or it becomes a trap on every VM');
  assert.match(skillSetup, /rm -f "\$stale"/);
});
