// Two generic biases that made the cerebellum FAIL a clean authoring milestone.
//
// A real autonomous mission authored a correct, surgical, equal-length edit to a
// skill's procedure. The cerebellum FAILED the checkpoint anyway, for two reasons
// that have nothing to do with the skill being improved and everything to do with
// how the change was described and measured:
//
//   1. The diff summary reported only the NET length delta — "rewritten (+0 chars)"
//      for an equal-length edit — which reads as "nothing changed". The verifier
//      concluded "no actual change or improvement" and failed the milestone.
//   2. The evidence-floor heuristic recognized a "write" only as a workspace file
//      write, so a `fleet-config change edit` (a registry mutation via git-store)
//      was flagged "no writes" and the verifier was handed an [EVIDENCE WARNING].
//
// Both are generic — they hit any authoring mission, on any definition. Fixed in
// diff.mjs (report the changed span + length) and checkpoint-executor.mjs (a
// registry authoring verb IS a write).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedSpan, diffRevision } from '../platform/deployment/diff.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- the changed-span measure (pure) -------------------------------------

test('an equal-length surgical edit has a non-zero changed span', () => {
  const a = 'the value is NOT the plain-text offset; mixing them styles the wrong span';
  const b = 'the value is a raw API index instead; mixing them styles the wrong span';
  const { changed } = changedSpan(a, b);
  assert.ok(changed > 0, 'a real edit must not measure as zero change even when net length is ~0');
});

test('identical strings change nothing', () => {
  assert.equal(changedSpan('same text here', 'same text here').changed, 0);
});

test('the span ignores a shared head and tail', () => {
  // Only the middle word differs; prefix and suffix are shared.
  const r = changedSpan('alpha BRAVO omega', 'alpha DELTA omega');
  assert.equal(r.prefix, 6);
  assert.equal(r.suffix, 6);
  assert.equal(r.changed, 5); // BRAVO / DELTA
});

// ---- the diff summary an operator and the verifier read ------------------

const bigProc = (mid) => `# Procedure\n\n${'Read the request carefully. '.repeat(12)}${mid}${' Then verify the result and report.'.repeat(6)}`;

test('an equal-length prose edit is NOT summarized as "+0 chars"', () => {
  const before = { id: 's', kind: 'skill', name: 'S', summary: 'x'.repeat(20), triggers: ['t'], procedure: bigProc('use --anchor here') };
  const after = { id: 's', kind: 'skill', name: 'S', summary: 'x'.repeat(20), triggers: ['t'], procedure: bigProc('use --index here') };
  const d = diffRevision('skill', before, after);
  assert.ok(d, 'a real change must produce a diff');
  assert.doesNotMatch(d.summary, /\+0 chars/, 'the "+0 chars" wording is exactly what read as "no change"');
  assert.match(d.summary, /chars changed/, 'the summary must state that content changed');
});

test('the summary shows length before→after, so a body collapse is visible', () => {
  const before = { id: 's', kind: 'skill', name: 'S', summary: 'x'.repeat(20), triggers: ['t'], procedure: 'y'.repeat(40268) };
  const after = { id: 's', kind: 'skill', name: 'S', summary: 'x'.repeat(20), triggers: ['t'], procedure: 'a stub that replaced the whole body' };
  const d = diffRevision('skill', before, after);
  assert.match(d.summary, /40268→3[0-9]/, 'the collapse from 40268 to a stub must be legible in the summary');
});

// ---- registry authoring counts as a write (evidence floor) ---------------

test('the evidence floor recognizes a registry mutation as a write', () => {
  // Asserted against the real source: the hasWrites test must accept a fleet-config
  // authoring verb, or a clean authoring task is flagged "no writes" and the
  // verifier is biased against it. (The heuristic is inline in a large executor
  // function; this pins the fix without reimplementing the function.)
  const src = readFileSync(join(repo, 'platform', 'work', 'checkpoint-executor.mjs'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('const hasWrites'));
  assert.ok(line, 'the evidence-floor write detector must still exist');
  assert.match(line, /fleet-config\\s\+\(\?:change\|release\|assign\|rollback\)/,
    'a registry authoring verb must count as a durable write');

  // And prove the pattern behaves: a fleet-config change edit is a write; a plain
  // read is not. Build the exact regex from the source line so this is not a
  // second authority — it tests the shipped pattern.
  const m = line.match(/\/(.*)\/i\.test/);
  assert.ok(m, 'could not extract the hasWrites regex from source');
  const re = new RegExp(m[1], 'i');
  assert.ok(re.test('[TOOL] fleet-config change edit skill/workspace-docs --find X --replace Y'), 'authoring must read as a write');
  assert.ok(!re.test('[TOOL] fleet-config get skill workspace-docs'), 'a read must not read as a write');
});
