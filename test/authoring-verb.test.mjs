// Prime can now WRITE a definition (Finding C).
//
// The registry had import/list/get/diff/validate/release/assign/rollback/compile/
// status/observe/evaluate/finding — every verb for moving content around, and
// none for creating it. Every definition got there through `import`, a one-time
// seed of the catalog shipped with the platform, so "Prime improves the fleet"
// bottomed out in a human editing repo files.
//
// The rule that shapes the command: PRIME'S SHELL NEVER WRITES A DEFINITION. The
// body arrives on stdin, the command resolves the base revision, and
// registry.createChange() seals, validates and commits. An agent with a shell
// could otherwise put anything into the registry, unsealed and unattributed.
//
// fleet-config is a CLI that resolves a GCP project on load, so these tests lift
// cmdChange out of the source and run it against stubs — the same technique used
// for install.sh and agent-brain, and for the same reason (R-11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { sealRevision } from '../platform/contracts/index.mjs';
import { diffRevision } from '../platform/deployment/diff.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = readFileSync(join(repo, 'corekit', 'system', 'fleet-config'), 'utf8');

function fnSource(name) {
  const lines = cli.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`fleet-config no longer defines ${name}() — this test is stale, not passing`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  const body = lines.slice(start, end + 1).join('\n');
  if (!body.includes('createChange')) throw new Error('extracted block does not reach createChange — wrong block');
  return body;
}

const CMD_CHANGE = fnSource('cmdChange');

/** A minimal but REAL skill definition — it must survive sealRevision's schema check. */
const skillDraft = (over = {}) => ({
  id: 'legal-review',
  name: 'Legal Review',
  summary: 'reviewing contracts before signature',
  triggers: ['a contract needs review'],
  procedure: '1. Read the contract end to end.\n2. Flag anything unusual.\n',
  ...over,
});

/**
 * Run the real cmdChange against stubs, capturing what it would have written.
 */
function run(args, { existing = [] } = {}, stdin = null) {
  const calls = { createChange: [], emitted: [] };
  const definitions = new Map(existing.map((d) => [`${d.kind}/${d.id}`, d]));

  const tmp = stdin === null ? null : (() => {
    const dir = mkdtempSync(join(tmpdir(), 'verb-'));
    const f = join(dir, 'body.json');
    writeFileSync(f, typeof stdin === 'string' ? stdin : JSON.stringify(stdin), 'utf8');
    return { dir, f };
  })();

  const registry = {
    async readDefinitions() { return { definitions }; },
    async createChange(input) {
      calls.createChange.push(input);
      return {
        ok: true,
        branch: 'change/fc-test',
        change: { id: 'fc-test', revisions: input.edits.map((e) => ({ kind: e.kind, id: e.draft.id })), diff: input.diff },
      };
    },
  };

  const deps = {
    registry,
    // die() exits the process in the CLI; throwing makes it assertable.
    die: (m) => { const e = new Error(m); e.isDie = true; throw e; },
    emit: (v) => calls.emitted.push(v),
    note: () => {},
    argValue: (a, flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; },
    actorId: () => 'prime-test',
    sealRevision,
    diffRevision,
    renderDiff: () => '',
    readFileSync,
  };

  const fn = new Function('deps', `
    const { registry, die, emit, note, argValue, actorId, sealRevision, diffRevision, renderDiff, readFileSync } = deps;
    ${CMD_CHANGE}
    return cmdChange;
  `)(deps);

  const finalArgs = tmp ? [...args, '--file', tmp.f] : args;
  return fn(registry, finalArgs)
    .then(() => ({ ok: true, calls }))
    .catch((e) => {
      // Surface an unexpected failure. A test that only asserts `ok === false`
      // tells you nothing about WHY, and this harness swallows the reason by
      // construction.
      if (process.env.VERB_DEBUG) console.error('  [verb] ' + e.message);
      return { ok: false, error: e, calls };
    })
    .finally(() => { if (tmp) rmSync(tmp.dir, { recursive: true, force: true }); });
}

const sealed = (draft) => sealRevision('skill', draft, { actor: 'seed' });

// ---- the preconditions that make create and update different verbs --------

test('create refuses a definition that already exists', async () => {
  const r = await run(['create', 'skill', '--title', 'add it'],
    { existing: [sealed(skillDraft())] }, skillDraft());
  assert.equal(r.ok, false);
  assert.match(r.error.message, /already exists at revision/);
  assert.equal(r.calls.createChange.length, 0, 'nothing may be written when the precondition fails');
});

test('update refuses a definition that does not exist', async () => {
  const r = await run(['update', 'skill', '--title', 'edit it'], {}, skillDraft());
  assert.equal(r.ok, false);
  assert.match(r.error.message, /no such definition/);
  assert.equal(r.calls.createChange.length, 0);
});

test('create passes a null baseRevision; update passes the current one (CAS)', async () => {
  const created = await run(['create', 'skill', '--title', 'add it'], {}, skillDraft());
  assert.equal(created.ok, true);
  assert.equal(created.calls.createChange[0].edits[0].baseRevision, null,
    'a create has nothing to compare against');

  const before = sealed(skillDraft());
  const updated = await run(['update', 'skill', '--title', 'edit it'],
    { existing: [before] }, skillDraft({ summary: 'reviewing contracts and NDAs before signature' }));
  assert.equal(updated.ok, true);
  assert.equal(updated.calls.createChange[0].edits[0].baseRevision, before.revision,
    'an update must carry the revision it was drafted against, or a concurrent edit is lost');
});

// ---- deprecate is an edit, not a delete ----------------------------------

test('deprecate sets status and keeps the definition', async () => {
  const before = sealed(skillDraft());
  const r = await run(['deprecate', 'skill/legal-review', '--title', 'retire it'], { existing: [before] });
  assert.equal(r.ok, true);

  const edit = r.calls.createChange[0].edits[0];
  assert.equal(edit.draft.status, 'deprecated');
  assert.equal(edit.draft.id, 'legal-review', 'the definition survives — a rollback needs something to roll back to');
  assert.equal(edit.baseRevision, before.revision, 'deprecation is CAS-protected like any other edit');
  assert.ok(!('digest' in edit.draft) && !('revision' in edit.draft),
    'derived fields must be stripped so the new revision is sealed, not copied');
});

test('deprecate refuses a definition that is already deprecated', async () => {
  const before = sealed(skillDraft({ status: 'deprecated' }));
  const r = await run(['deprecate', 'skill/legal-review', '--title', 'again'], { existing: [before] });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /already deprecated/);
});

test('deprecate refuses a definition that does not exist', async () => {
  const r = await run(['deprecate', 'skill/ghost', '--title', 'retire it']);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /nothing to deprecate/);
});

// ---- the guards ----------------------------------------------------------

test('a schema-invalid body is refused BEFORE anything is pushed', async () => {
  // The local seal exists for exactly this: import does the same. A change that
  // fails validation halfway through would leave a branch with some definitions
  // on it and no record.
  const r = await run(['create', 'skill', '--title', 'bad'], {}, { id: 'broken' });
  assert.equal(r.ok, false);
  assert.equal(r.calls.createChange.length, 0, 'the push must not be attempted');
});

test('a change with no title is refused', async () => {
  const r = await run(['create', 'skill'], {}, skillDraft());
  assert.equal(r.ok, false);
  assert.match(r.error.message, /--title is required/);
});

test('a body that is not JSON is refused with a readable reason', async () => {
  const r = await run(['create', 'skill', '--title', 't'], {}, 'not json at all');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /not valid JSON/);
});

test('an unknown operation is refused', async () => {
  const r = await run(['destroy', 'skill', '--title', 't'], {}, skillDraft());
  assert.equal(r.ok, false);
  assert.match(r.error.message, /usage: fleet-config change/);
});

// ---- what the change carries --------------------------------------------

test('the change carries a field-level diff, not just revision ids', async () => {
  const before = sealed(skillDraft());
  const r = await run(['update', 'skill', '--title', 'edit it'],
    { existing: [before] }, skillDraft({ summary: 'reviewing contracts and NDAs before signature' }));
  assert.equal(r.ok, true);
  const { diff } = r.calls.createChange[0];
  assert.ok(Array.isArray(diff) && diff.length > 0,
    'a reviewer needs to see WHAT changed, not only that something did');
});

test('several definitions can move in one change', async () => {
  const r = await run(['create', 'skill', '--title', 'two at once'], {},
    [skillDraft({ id: 'a' }), skillDraft({ id: 'b' })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls.createChange[0].edits.map((e) => e.draft.id), ['a', 'b'],
    'a coherent change is one change — splitting it would let half of it release');
});

// ---- the verb is reachable ----------------------------------------------

test('change is registered as a command', () => {
  assert.match(cli, /change: cmdChange,/, 'a command nobody can invoke is not a verb');
});
