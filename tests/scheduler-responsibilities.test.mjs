// tests/scheduler-responsibilities.test.mjs — loadResponsibilities overlay discovery.
//
// Regression: the scheduler used to hardcode reading only responsibilities.json +
// responsibilities-job.json, so operator/role overlays mapped to any other
// responsibilities-*.json destination (e.g. operator responsibilities installed as
// corekit/responsibilities-devops.json via operator/manifests/job-tachin-website.txt)
// silently never loaded and never fired. loadResponsibilities now reads the base
// first, then every responsibilities-*.json overlay (sorted, base authoritative).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../platform/work/scheduler.mjs';

function setup(files) {
  const root = mkdtempSync(join(tmpdir(), 'sched-'));
  const ck = join(root, 'corekit');
  mkdirSync(ck, { recursive: true });
  for (const [name, obj] of Object.entries(files)) {
    writeFileSync(join(ck, name), JSON.stringify(obj));
  }
  return root;
}

const makeScheduler = (coreDir) => createScheduler({ config: { coreDir }, logger: () => {} });

describe('scheduler loadResponsibilities — overlay discovery', () => {
  it('loads the base, the job overlay, AND operator responsibilities-*.json overlays', () => {
    const root = setup({
      'responsibilities.json': { version: 2, responsibilities: [{ id: 'r-base' }] },
      'responsibilities-job.json': { version: 2, responsibilities: [{ id: 'r-job' }] },
      'responsibilities-devops.json': { version: 2, responsibilities: [{ id: 'r-sync-health-nightly' }] },
    });
    try {
      const s = makeScheduler(root);
      s.loadResponsibilities();
      const ids = s.getResponsibilities().map((r) => r.id);
      assert.deepEqual(new Set(ids), new Set(['r-base', 'r-job', 'r-sync-health-nightly']));
      // The operator overlay is the specific case the old hardcoded list dropped.
      assert.ok(ids.includes('r-sync-health-nightly'), 'operator overlay responsibility must load');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the base authoritative on id collision (first-seen wins)', () => {
    const root = setup({
      'responsibilities.json': { responsibilities: [{ id: 'r-dup', name: 'from-base' }] },
      'responsibilities-job.json': { responsibilities: [{ id: 'r-dup', name: 'from-job' }] },
    });
    try {
      const s = makeScheduler(root);
      s.loadResponsibilities();
      const list = s.getResponsibilities();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'from-base', 'base must win over an overlay on id collision');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not throw when only the base exists', () => {
    const root = setup({ 'responsibilities.json': { responsibilities: [{ id: 'r-only' }] } });
    try {
      const s = makeScheduler(root);
      s.loadResponsibilities();
      assert.deepEqual(s.getResponsibilities().map((r) => r.id), ['r-only']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
