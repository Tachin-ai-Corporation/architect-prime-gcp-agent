// test/primitive-contracts.test.mjs — C-14: every primitive is an executable contract
//
// A primitive named in the closed set must exist in the running system, not only
// in documentation. `Plan` was carried in the set for months with a 212-line
// specification, a lifecycle state diagram, three named functions
// (`createPlan`/`approvePlan`/`stampPlan`) and two mutually contradictory
// Firestore paths (`plans/{planId}` in the primitive doc, `primes/{id}/plans/`
// in CULTURE_OF_WORK) — and zero lines of implementation. Documentation that
// describes machinery nobody built is worse than no documentation: it is a
// promise the system silently breaks.
//
// This test keeps the doc set, the canon count, and the code in agreement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/**
 * The closed set. Each entry names a token that must be findable in runtime
 * source — the proof that the primitive is implemented and not merely described.
 */
const PRIMITIVES = [
  { file: '01-TASK.md', name: 'Task', evidence: /type: ?'T'|'T'|"T"/ },
  { file: '02-CHECKPOINT.md', name: 'Checkpoint', evidence: /checkpoint/i },
  { file: '03-MISSION.md', name: 'Mission', evidence: /mission/i },
  { file: '04-PROJECT.md', name: 'Project', evidence: /createProjectRegistry/ },
  { file: '05-PROCESS.md', name: 'Process', evidence: /createProcessRegistry/ },
  { file: '06-RESPONSIBILITY.md', name: 'Responsibility', evidence: /responsibilit/i },
  { file: '07-ARTIFACT.md', name: 'Artifact', evidence: /artifact/i },
  { file: '08-SKILL.md', name: 'Skill', evidence: /skill/i },
];

/** Names retired from the closed set. Reintroducing one needs a canon amendment. */
const RETIRED = [{ name: 'Plan', functions: ['createPlan', 'approvePlan', 'stampPlan', 'amendPlan'] }];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.mjs$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

let runtimeSource = '';
function corekitSource() {
  if (!runtimeSource) {
    runtimeSource = walk(join(REPO, 'corekit'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
  }
  return runtimeSource;
}

test('the primitives directory is exactly the closed set, numbered contiguously', () => {
  const files = readdirSync(join(REPO, 'docs', 'primitives')).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(
    files,
    PRIMITIVES.map((p) => p.file),
    'the primitive docs must match the closed set exactly — no gaps, no extras'
  );
});

test('every primitive is implemented in the runtime, not only documented', () => {
  const src = corekitSource();
  for (const p of PRIMITIVES) {
    assert.match(src, p.evidence, `${p.name} is documented but has no runtime implementation`);
  }
});

test('retired primitives have no implementation and no documentation', () => {
  const src = corekitSource();
  for (const retired of RETIRED) {
    for (const fn of retired.functions) {
      assert.doesNotMatch(
        src,
        new RegExp(`\\b${fn}\\b`),
        `${fn} reappeared — ${retired.name} was retired from the closed set (C-14)`
      );
    }
    const docs = readdirSync(join(REPO, 'docs', 'primitives'));
    assert.ok(
      !docs.some((f) => f.toUpperCase().includes(retired.name.toUpperCase() + '.MD')),
      `a primitive doc for the retired ${retired.name} reappeared`
    );
  }
});

test('the canon and the Culture of Work agree on the primitive count', () => {
  const canon = read('docs/PRODUCT_CANON.md');
  const cow = read('docs/CULTURE_OF_WORK.md');

  assert.match(canon, /### C-14 · The eight primitives are a closed set/);
  assert.match(cow, /It defines \*\*8 primitives\*\*/);
  assert.doesNotMatch(canon, /nine primitives/i);
  assert.doesNotMatch(cow, /\*\*9 primitives\*\*/);
});

test('the Culture of Work primitive table lists exactly the closed set', () => {
  const cow = read('docs/CULTURE_OF_WORK.md');
  const table = /\| Primitive \| Envelope Type \| Purpose \|[\s\S]*?\n\n/.exec(cow);
  assert.ok(table, 'the primitive table must exist');

  const listed = [...table[0].matchAll(/^\| \*\*(\w+)\*\* \|/gm)].map((m) => m[1]);
  assert.deepEqual(
    listed,
    PRIMITIVES.map((p) => p.name),
    'the table must list the closed set, in order'
  );
});

test('every primitive doc is linked from the Culture of Work reference list', () => {
  const cow = read('docs/CULTURE_OF_WORK.md');
  for (const p of PRIMITIVES) {
    assert.match(
      cow,
      new RegExp(`primitives/${p.file.replace('.', '\\.')}`),
      `${p.file} is not linked from CULTURE_OF_WORK.md`
    );
  }
});

test('no doc links a renumbered or deleted primitive path', () => {
  const stale = ['06-PLAN.md', '07-RESPONSIBILITY.md', '08-ARTIFACT.md', '09-SKILL.md'];
  const docs = walkMd(join(REPO, 'docs')).concat([
    join(REPO, 'CLAUDE.md'),
    join(REPO, 'MISSION_PLAN.md'),
    join(REPO, 'README.md'),
  ]);
  const offenders = [];
  for (const file of docs) {
    const src = readFileSync(file, 'utf8');
    for (const s of stale) {
      if (src.includes(s)) offenders.push(`${file.slice(REPO.length + 1)} → ${s}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

function walkMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkMd(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}
