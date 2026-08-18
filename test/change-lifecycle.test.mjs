// The Change lifecycle, and the evidence link that was never connected.
//
// Two things here, and the second is the defect:
//
// 1. The Change state machine was implicit across three writers — createChange
//    stamped `draft`, recordValidation flipped `validated`/`draft`, createRelease
//    stamped `released`. "May a released change go back to draft?" had no place
//    to be asked. Now it has one table, in the shape work-transitions.mjs
//    already established for Work envelopes.
//
// 2. `change.evaluation_ids` was initialised to [] and NOTHING EVER APPENDED TO
//    IT. createRelease then flat-mapped that array into the release's evidence,
//    so every release recorded zero evaluations while the code around it said a
//    release carries its evidence (C-31). Structurally empty, exactly like the
//    removal set in Finding D: the consumer was correct and was fed a list that
//    could not be non-empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANGE_STATUSES, LEGAL_TRANSITIONS, TERMINAL_STATUSES,
  canTransition, reachableFrom, isTerminal,
} from '../platform/contracts/change-transitions.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const registrySrc = readFileSync(join(repo, 'platform', 'deployment', 'registry.mjs'), 'utf8');
const cli = readFileSync(join(repo, 'corekit', 'system', 'fleet-config'), 'utf8');

const passing = (over = {}) => ({ status: 'validated', validation: { passed: true }, evaluation_ids: [], ...over });

// ---- the table --------------------------------------------------------

test('every target named in the table is a real status', () => {
  // A typo'd target is a transition that can never fire, and it reads as a rule.
  for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
    assert.ok(CHANGE_STATUSES.includes(from), `'${from}' is not a change status`);
    for (const to of targets) {
      assert.ok(CHANGE_STATUSES.includes(to), `${from} → '${to}' names a status that does not exist`);
    }
  }
});

test('every status is reachable, or is the start', () => {
  // An unreachable status is dead vocabulary — it will be used in a comparison
  // somewhere and quietly never match.
  const reachable = new Set(Object.values(LEGAL_TRANSITIONS).flat());
  for (const s of CHANGE_STATUSES) {
    assert.ok(reachable.has(s) || s === 'draft', `'${s}' cannot be reached from anywhere`);
  }
});

test('released is terminal — an immutable release stays immutable', () => {
  assert.ok(isTerminal('released'));
  assert.deepEqual(reachableFrom('released'), []);
  const r = canTransition('released', 'draft', passing({ status: 'released' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /terminal/);
});

test('a failed validation sends a change BACK to draft', () => {
  // Re-authoring after a failure is the normal path. A forward-only lifecycle
  // makes an author abandon and re-create, losing the change's history exactly
  // when it is most informative.
  assert.equal(canTransition('validated', 'draft', passing()).ok, true);
  assert.equal(canTransition('evaluated', 'draft', passing({ status: 'evaluated' })).ok, true);
});

test('recording the same status twice is a no-op, not an error', () => {
  // Idempotence (C-18). Without it every retry after a partial failure becomes a
  // manual repair.
  const r = canTransition('validated', 'validated', passing());
  assert.equal(r.ok, true);
  assert.match(r.reason, /no-op/);
});

test('a change with no passing validation cannot be released', () => {
  const r = canTransition('validated', 'released', { status: 'validated', validation: { passed: false } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /carries its evidence/);
});

test('validated may go straight to released — evaluation is evidence, not a gate', () => {
  // Stated as a test because it is a CHOICE. `import` produces a change nobody
  // can evaluate: there is no baseline to evaluate it against. A mandatory
  // evaluation gate would have blocked the seed path on day one, which is how a
  // gate gets switched off.
  assert.equal(canTransition('validated', 'released', passing()).ok, true);
});

test('a change cannot be marked evaluated with no evaluation attached', () => {
  const bare = canTransition('validated', 'evaluated', passing());
  assert.equal(bare.ok, false);
  assert.match(bare.reason, /once an evaluation is attached/);

  const withEval = canTransition('validated', 'evaluated', passing({ evaluation_ids: ['fe-1'] }));
  assert.equal(withEval.ok, true);
});

test('an unknown status is refused, and an ABSENT one is treated as draft', () => {
  assert.equal(canTransition('validated', 'shipped', passing()).ok, false);
  // A record written before this field existed must not be stranded.
  assert.equal(canTransition(undefined, 'validated', { validation: { passed: true } }).ok, true);
});

// ---- the evidence link ------------------------------------------------

test('attachEvaluation exists, is idempotent, and is exported', () => {
  assert.match(registrySrc, /async function attachEvaluation\(changeId, evaluationId\)/);
  assert.match(registrySrc, /ids\.includes\(evaluationId\) \? ids : \[\.\.\.ids, evaluationId\]/,
    'attaching the same evaluation twice must not duplicate evidence');
  assert.match(registrySrc, /^\s+attachEvaluation,$/m, 'a method nobody can call is not a method');
});

test('the transition check runs against the change as it WILL be', () => {
  // `evaluated` requires an attached evaluation. Checking the change as it was
  // would refuse the very transition that attaching one enables — a guard that
  // makes its own precondition unreachable.
  assert.match(registrySrc, /canTransition\(change\.status, 'evaluated', \{ \.\.\.change, evaluation_ids \}\)/);
});

test('saving an evaluation attaches it to the change', () => {
  const at = cli.indexOf("if (args.includes('--save'))");
  assert.ok(at > 0);
  const block = cli.slice(at, at + 900);
  assert.match(block, /registry\.attachEvaluation\(changeId, record\.id\)/,
    'a saved evaluation nobody can find from the change it grades is a file, not evidence');
  assert.match(block, /attached to nothing/,
    'and when there is no --change the gap must be SAID, not left silent');
});

test('recordValidation consults the machine before writing', () => {
  assert.match(registrySrc, /const move = canTransition\(change\.status, next, change\);/);
  assert.match(registrySrc, /if \(!move\.ok\) throw new Error/);
});

// ---- scope, so the machine is not over-read ---------------------------

test('the release lifecycle is NOT in this table', () => {
  // Two objects, two lifecycles. The plan's single chain spans both, and folding
  // them together would invent states neither object has — a Change is never
  // `canary`, a Release is never `validated`.
  for (const s of ['canary', 'active', 'superseded', 'rolled-back']) {
    assert.ok(!CHANGE_STATUSES.includes(s), `'${s}' is a RELEASE state and must not be a change status`);
  }
  // And the release states that do exist are still enforced where they always were.
  assert.match(registrySrc, /const status = pinned \? 'canary' : 'active';/);
});

test('terminal statuses are exactly the ones with no moves', () => {
  for (const s of CHANGE_STATUSES) {
    const dead = (LEGAL_TRANSITIONS[s] || []).length === 0;
    assert.equal(dead, TERMINAL_STATUSES.includes(s),
      `'${s}' disagrees: ${dead ? 'has no moves but is not listed terminal' : 'is listed terminal but has moves'}`);
  }
});
