// test/prompt-conformance.test.mjs — active prompts agree with legal runtime moves
//
// Locking a prompt's content hash (`brain/ORGAN_LOCK.json`) prevents unauthorized
// edits. It does not prevent *semantic* rot: at v2026.08.15.1.0 the Prime cortex
// SOUL still instructed `follow_process` and the delegation SKILL still listed it
// in a decision table, months after the action handler was deleted in the
// process-as-narrative migration. An organ that names a move the daemon will
// reject is a guaranteed wasted iteration.
//
// This test derives the legal set from the daemon itself — the single authority —
// and fails when any prompt-bearing surface names something outside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTION_NAMES } from '../corekit/daemon/actions/index.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Prompt-bearing surfaces: organ firmware, role overlays, and skill procedures. */
const PROMPT_ROOTS = ['brain', 'specialties', 'skills', 'operator'];

/** Actions that existed once and are now illegal. Naming one is a defect. */
const RETIRED_ACTIONS = ['follow_process', 'execute_process', 'run_process', 'simple_dispatch'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(md|json)$/.test(name)) out.push(full);
  }
  return out;
}

function promptFiles() {
  return PROMPT_ROOTS.flatMap((root) => walk(join(REPO, root)));
}

test('the legal action set is non-empty and self-consistent', () => {
  assert.ok(ACTION_NAMES.length > 0);
  assert.equal(new Set(ACTION_NAMES).size, ACTION_NAMES.length, 'no duplicate action names');
  for (const retired of RETIRED_ACTIONS) {
    assert.ok(!ACTION_NAMES.includes(retired), `${retired} must not be reintroduced as a legal action`);
  }
});

test('no prompt surface instructs a retired action', () => {
  const offenders = [];

  for (const file of promptFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const retired of RETIRED_ACTIONS) {
      // Word-boundary match so prose like "the follow_process action was removed"
      // in a changelog is still caught here — prompt surfaces should not carry
      // that history at all; it belongs in docs/ and README.
      if (new RegExp(`\\b${retired}\\b`).test(src)) {
        const line = src.split('\n').findIndex((l) => new RegExp(`\\b${retired}\\b`).test(l)) + 1;
        offenders.push(`${relative(REPO, file).replace(/\\/g, '/')}:${line} names '${retired}'`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'A prompt-bearing surface instructs a move the daemon will reject.\n' +
      'Legal actions come from corekit/daemon/actions/index.mjs ACTION_NAMES.\n' +
      offenders.join('\n')
  );
});

test('every backticked action-shaped token in a prompt is a legal action', () => {
  // Only inspect tokens that look like an action reference: a backticked
  // snake_case identifier appearing next to action vocabulary. This stays quiet
  // about field names and tool flags, and loud about invented moves.
  const ACTION_CONTEXT = /(action|move|emit|return|use|pick|choose|prefer)[^\n`]{0,40}`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/gi;
  const KNOWN = new Set(ACTION_NAMES);
  const offenders = [];

  for (const file of promptFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(ACTION_CONTEXT)) {
      const token = m[2];
      if (KNOWN.has(token)) continue;
      if (!RETIRED_ACTIONS.includes(token)) continue; // retired ones only — see the test above
      offenders.push(`${relative(REPO, file).replace(/\\/g, '/')} → \`${token}\``);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});
