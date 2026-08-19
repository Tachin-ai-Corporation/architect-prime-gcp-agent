// A process authored into the registry must reach the agent (P0-9, first half).
//
// It could not before, and not because of a field mismatch: `compileAgentSpec`
// never took a `processes` argument and emitted no process file, so a process
// authored through the registry was delivered NOWHERE. Meanwhile the runtime read
// processes from local CoreKit files (`process-registry.mjs:48`) plus a
// tenant-global Firestore collection that overrides local by id (`:81`) — two
// authorities, and the release plane was neither of them.
//
// SCOPE, stated so this is not over-read. This half is ADDITIVE: the bundle now
// carries the processes. process-registry.mjs still reads local + Firestore, and
// switching it is Phase D item 11, gated on proving the bundle matches the legacy
// sources. Flipping the reader now would leave every agent with no processes at
// all, because no release has ever contained one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileAgentSpec } from '../platform/deployment/compiler.mjs';
import { schemaFor } from '../platform/contracts/index.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const registrySrc = readFileSync(join(repo, 'platform', 'work', 'process-registry.mjs'), 'utf8');
const daemon = readFileSync(join(repo, 'platform', 'runtime', 'agent-content-sync.mjs'), 'utf8');

const role = { id: 'assistant', revision: 'rev-aaaaaaaaaaaa', default_skills: [], responsibilities: [] };
const proc = (over = {}) => ({
  id: 'p-triage',
  kind: 'process',
  // Revisions match /^rev-[0-9a-f]{12}$/. Inventing a shorter one is how the first
  // run of this file failed — the fifth fixture this session written from memory
  // instead of from the constraint.
  revision: 'rev-bbbbbbbbbbbb',
  name: 'Triage',
  description: 'How to triage inbound work',
  narrative: 'Read the request. Decide whether it is one job or several. Say which.',
  intent_keywords: ['triage', 'inbound'],
  ...over,
});

const compile = (processes) => compileAgentSpec({
  agentId: 'millie',
  platformVersion: 'abc123',
  fleetRelease: 'fr-1',
  role,
  personas: [],
  skills: [],
  responsibilities: [],
  processes,
  firmware: {},
  compiledAt: '2026-08-19T00:00:00.000Z',
});

// ---- delivery ----------------------------------------------------------

test('a release with a process emits it into the bundle', () => {
  const { files } = compile([proc()]);
  const path = 'corekit/processes-job.json';
  assert.ok(files[path], `the bundle must carry ${path} — before this it carried nothing at all`);

  const parsed = JSON.parse(files[path]);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.processes.length, 1);
  assert.equal(parsed.processes[0].id, 'p-triage');
});

test('the emitted record carries every field the runtime loader reads', () => {
  // process-registry.mjs keys by `id` and skips `status === 'deprecated'`, so both
  // must survive compilation. `narrative` is the content itself.
  const rec = JSON.parse(compile([proc()]).files['corekit/processes-job.json']).processes[0];
  for (const f of ['id', 'name', 'status', 'description', 'narrative', 'intent_keywords']) {
    assert.ok(f in rec, `the loader reads ${f}; the compiled record must carry it`);
  }
  assert.equal(rec.status, 'active', 'an unset status must default to active, not undefined');
  assert.equal(rec.revision, 'rev-bbbbbbbbbbbb', 'and the revision, so a process can be traced to a release');
});

test('a release with no processes emits no process file', () => {
  // Not an empty file: an empty `processes-job.json` would be a managed path that
  // says "this release defines no processes", which the reader could not tell from
  // "this release predates process delivery".
  const { files } = compile([]);
  assert.equal(files['corekit/processes-job.json'], undefined);
});

test('the process file is part of the digested bundle', () => {
  // If it were emitted outside `files` it would not be digested, verified on
  // staging, or removable when a release drops it — the Finding D shape.
  const { spec, files } = compile([proc()]);
  const path = 'corekit/processes-job.json';
  assert.ok(spec.bundle.files[path], 'the process file must have a recorded digest');
  assert.equal(Object.keys(files).length, Object.keys(spec.bundle.files).length);
});

test('two releases differing only in a process have different digests', () => {
  // Otherwise a process change would be invisible to the desired/actual loop and
  // an agent could never be told to re-apply for it.
  const a = compile([proc()]).spec.digest;
  const b = compile([proc({ narrative: 'A different narrative entirely, long enough to matter.' })]).spec.digest;
  assert.notEqual(a, b);
});

// ---- the daemon supplies them -----------------------------------------

test('the daemon passes the release processes to the compiler', () => {
  assert.match(daemon, /const processes = \[\.\.\.definitions\.values\(\)\]\.filter\(\(d\) => d\.kind === 'process'/,
    'processes come from the release definitions, not from disk');
  assert.match(daemon, /role, personas, skills, responsibilities, processes, firmware,/,
    'and must actually be handed to compileAgentSpec');
});

test('a deprecated process is not delivered', () => {
  // The local loader skips deprecated ones. If the release delivered them anyway,
  // switching the reader later would resurrect every retired process at once.
  assert.match(daemon, /d\.status !== 'deprecated'/);
});

// ---- the contract already covered this, which is why the gap was invisible ----

test('the process schema declares what the runtime needs', () => {
  const props = schemaFor('process').spec.properties;
  for (const f of ['name', 'description', 'narrative', 'intent_keywords']) {
    assert.ok(props[f], `${f} must be authorable`);
  }
});

test('every shipped local process would survive compilation', () => {
  // Parity groundwork for item 11: if a bundled process could not be expressed as
  // a compiled record, the migration would silently drop it.
  const dir = join(repo, 'corekit', 'config', 'processes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5, `expected the shipped process set, found ${files.length}`);

  const missing = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!p.id || !p.name || !p.narrative) missing.push(`${f}: needs id+name+narrative`);
  }
  assert.deepEqual(missing, [], 'a local process the compiler cannot represent would be lost in the migration');
});

// ---- and the reader is deliberately unchanged --------------------------

test('process-registry still reads the legacy sources — the switch is item 11', () => {
  // Asserted so this commit cannot be mistaken for the whole fix. The reader
  // switch needs the parity proof first.
  assert.match(registrySrc, /corekit\/processes/, 'local files are still read');
  assert.doesNotMatch(registrySrc, /readReleaseDefinitions/,
    'if this ever changes, the parity proof and the deploy plan change with it');
});
