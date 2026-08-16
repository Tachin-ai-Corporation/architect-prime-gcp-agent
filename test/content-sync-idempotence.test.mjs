// test/content-sync-idempotence.test.mjs — applying a release twice is applying it once
//
// The defect this exists to stop, found on a live canary: content-sync read an
// organ's base firmware from `workspace-<organ>/SOUL.md`, which is its own
// output from the previous apply. Each pass composed the overlay onto the
// previous render, so millie's soul carried the assistant-cortex layer twice
// and grew by one copy per apply. Every downstream symptom followed from it —
// the spec digest changed on every pass, so missions never grouped by spec and
// the rollout gate reported no evidence at all.
//
// Nothing in the staging / digest-verify / atomic-swap path was wrong. The
// input was. So these tests exercise the loop rather than a single apply: a
// second apply from a real rendered tree must produce identical bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileAgentSpec } from '../platform/deployment/compiler.mjs';
import {
  planApply, reconcile, bundleMatches, installPath, firmwarePath,
} from '../platform/deployment/content-sync.mjs';
import { bytesDigest } from '../platform/contracts/digest.mjs';

const AT = '2026-08-15T12:00:00Z';
const BASE_SOUL = '# Cortex\n\nI decide what happens next.\n';
const OVERLAY = 'I am an assistant. I keep the calendar honest.';

const role = {
  id: 'assistant', revision: 'rev-000000000001', kind: 'role',
  capabilities: [], default_skills: [], responsibilities: [],
  egress_class: 'tenant',
};
const personas = [{
  id: 'assistant-cortex', revision: 'rev-0000000000a1', kind: 'persona',
  role_id: 'assistant', organ: 'cortex', layer: 'role', body: OVERLAY,
}];

const compile = (firmware) => compileAgentSpec({
  agentId: 'millie', platformVersion: '6f238c45b259', fleetRelease: 'fr-6a524ab97fd1',
  role, personas, skills: [], responsibilities: [], firmware, compiledAt: AT,
});

/** A tiny in-memory VM tree, keyed the way the install root is. */
function vm(initial = {}) {
  const disk = { ...initial };
  return {
    disk,
    /** Read firmware exactly as the daemon does — via firmwarePath, per organ. */
    firmware(organs) {
      const out = {};
      for (const organ of organs) {
        const path = firmwarePath(organ);
        if (!(path in disk)) throw new Error(`no base firmware at ${path}`);
        out[organ] = disk[path];
      }
      return out;
    },
    /** The apply: bundle paths land at their install paths. */
    apply(files) {
      for (const [bundlePath, content] of Object.entries(files)) disk[installPath(bundlePath)] = content;
    },
    /** Digests keyed by bundle path, as the daemon reports them. */
    digests(bundlePaths) {
      const out = {};
      for (const p of bundlePaths) if (installPath(p) in disk) out[p] = bytesDigest(disk[installPath(p)]);
      return out;
    },
  };
}

// ── The regression ─────────────────────────────────────────────────────

test('applying the same release twice leaves the same bytes', () => {
  const box = vm({ 'workspace/SOUL.base.md': BASE_SOUL, 'workspace/SOUL.md': BASE_SOUL });
  const organs = ['cortex'];

  const first = compile(box.firmware(organs));
  box.apply(first.files);
  const afterFirst = box.disk['workspace/SOUL.md'];

  const second = compile(box.firmware(organs));
  box.apply(second.files);

  assert.equal(second.spec.bundle.tree_digest, first.spec.bundle.tree_digest,
    'the second apply must be a no-op; a changed tree digest means the render fed itself');
  assert.equal(box.disk['workspace/SOUL.md'], afterFirst);
  assert.equal(second.spec.digest, first.spec.digest,
    'and the spec digest must hold, or missions never group by spec and the rollout gate sees nothing');
});

test('the overlay appears exactly once no matter how many times a release is applied', () => {
  const box = vm({ 'workspace/SOUL.base.md': BASE_SOUL, 'workspace/SOUL.md': BASE_SOUL });
  for (let i = 0; i < 5; i++) box.apply(compile(box.firmware(['cortex'])).files);

  const soul = box.disk['workspace/SOUL.md'];
  assert.equal(soul.split(OVERLAY).length - 1, 1, `overlay body appears ${soul.split(OVERLAY).length - 1}× after five applies`);
  assert.equal(soul.split('<!-- role: assistant-cortex').length - 1, 1);
  assert.ok(soul.startsWith('# Cortex'), 'and the base is still the base');
});

test('a second apply plans no writes at all', () => {
  const box = vm({ 'workspace/SOUL.base.md': BASE_SOUL, 'workspace/SOUL.md': BASE_SOUL });
  const first = compile(box.firmware(['cortex']));
  box.apply(first.files);

  const second = compile(box.firmware(['cortex']));
  const plan = planApply(box.digests(Object.keys(second.files)), second.files);
  assert.deepEqual(plan.write, [], 'nothing changed, so nothing should be written');
  assert.deepEqual(plan.remove, []);
});

test('reading the base from the render is the bug, and this is what it looked like', () => {
  // Kept as a live demonstration rather than a comment: if someone reinstates
  // the SOUL.md fallback, the difference between the two paths is right here.
  const box = vm({ 'workspace/SOUL.md': BASE_SOUL });
  for (let i = 0; i < 3; i++) {
    const compiled = compile({ cortex: box.disk['workspace/SOUL.md'] });  // ← reads its own output
    box.apply(compiled.files);
  }
  assert.equal(box.disk['workspace/SOUL.md'].split(OVERLAY).length - 1, 3,
    'composing onto the render accumulates one copy per apply — the defect');
});

test('firmware is read from a file nothing renders to', () => {
  for (const organ of ['cortex', 'motor', 'prefrontal', 'cerebellum']) {
    const src = firmwarePath(organ);
    assert.ok(src.endsWith('/SOUL.base.md'), `${organ}: base firmware must be SOUL.base.md, got ${src}`);
    assert.notEqual(src, installPath(`workspace-${organ}/SOUL.md`),
      `${organ}: the file read and the file written must differ, or composition feeds itself`);
  }
  assert.equal(firmwarePath('cortex'), 'workspace/SOUL.base.md', 'cortex keeps its historical workspace/ path');
});

// ── Convergence is re-derived, not remembered ──────────────────────────

test('a converged agent whose disk drifted re-applies instead of trusting the record', () => {
  const box = vm({ 'workspace/SOUL.base.md': BASE_SOUL, 'workspace/SOUL.md': BASE_SOUL });
  const { spec, files } = compile(box.firmware(['cortex']));
  box.apply(files);

  const assignment = {
    desired_release: 'fr-6a524ab97fd1', actual_release: 'fr-6a524ab97fd1',
    desired_spec_digest: spec.digest, actual_spec_digest: spec.digest,
  };
  const args = { assignment, spec, envelopes: [], agentEmail: 'millie@example.com' };

  assert.equal(reconcile({ ...args, installed: box.digests(Object.keys(files)) }).action, 'skip');

  // A platform upgrade reinstalls Foundation files from the manifest and can
  // revert the rendered soul underneath a record that still says "converged".
  box.disk['workspace/SOUL.md'] = BASE_SOUL;
  const d = reconcile({ ...args, installed: box.digests(Object.keys(files)) });
  assert.equal(d.action, 'apply');
  assert.equal(d.detail.drift, true);
  assert.match(d.reason, /drifted/);
});

test('repairing drift still waits for an idle boundary', () => {
  const box = vm({ 'workspace/SOUL.base.md': BASE_SOUL, 'workspace/SOUL.md': BASE_SOUL });
  const { spec, files } = compile(box.firmware(['cortex']));
  box.apply(files);
  const installed = box.digests(Object.keys(files));
  box.disk['workspace/SOUL.md'] = BASE_SOUL;

  const d = reconcile({
    assignment: {
      desired_release: 'fr-6a524ab97fd1', actual_release: 'fr-6a524ab97fd1',
      desired_spec_digest: spec.digest, actual_spec_digest: spec.digest,
    },
    spec, agentEmail: 'millie@example.com',
    envelopes: [{ status: 'active', owner: 'millie@example.com', type: 'M' }],
    installed: box.digests(Object.keys(files)),
  });
  assert.equal(d.action, 'wait', 'drift is not an emergency — C-32 still holds');
  assert.ok(installed);
});

test('bundleMatches compares every declared file', () => {
  const spec = { bundle: { files: { 'a': 'sha256:1', 'b': 'sha256:2' } } };
  assert.equal(bundleMatches({ a: 'sha256:1', b: 'sha256:2' }, spec), true);
  assert.equal(bundleMatches({ a: 'sha256:1' }, spec), false, 'a missing file is not a match');
  assert.equal(bundleMatches({ a: 'sha256:1', b: 'sha256:9' }, spec), false);
});

// ── The other writer of SOUL.md ────────────────────────────────────────

test('assemble-persona renders rather than appends, so running it twice changes nothing', (t) => {
  let bash;
  try {
    bash = execFileSync('bash', ['--version'], { encoding: 'utf8' });
  } catch {
    return t.skip('bash unavailable');
  }
  assert.ok(bash);

  const root = mkdtempSync(join(tmpdir(), 'persona-'));
  try {
    mkdirSync(join(root, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'SOUL.base.md'), BASE_SOUL);
    writeFileSync(join(root, 'workspace', 'SOUL.md'), BASE_SOUL);
    const specDir = join(root, 'corekit', 'specialties', 'assistant', 'brain', 'cortex');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'SOUL_APPEND.md'), OVERLAY + '\n');

    const script = join(process.cwd(), 'corekit', 'brain', 'assemble-persona');
    const run = () => execFileSync('bash', [script, 'assistant'], { env: { ...process.env, CORE_DIR: root }, encoding: 'utf8' });

    run();
    const once = readFileSync(join(root, 'workspace', 'SOUL.md'), 'utf8');
    run(); run();
    const thrice = readFileSync(join(root, 'workspace', 'SOUL.md'), 'utf8');

    assert.equal(thrice, once, 'three runs must leave what one run left');
    assert.equal(thrice.split(OVERLAY).length - 1, 1, 'the specialty layer appears exactly once');
    assert.equal(readFileSync(join(root, 'workspace', 'SOUL.base.md'), 'utf8'), BASE_SOUL,
      'and the base is never written to');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
