// tests/model-pins.test.mjs — an agent runs the contract's models, not the ones it was hired with.
//
// 2026-10-05 survey of all ten VMs: the bootstraps had copied the contract's models into each
// organ's workspace config.json at hire time, the gateway prefers that pin over the contract, and
// upgrades never touch workspace-*/. Seven agents were still on gemini-2.5-flash (fallback
// gemini-2.5-pro) while the contract said gemini-3.6-flash; three newer hires were frozen on 3.6.
// A model change in the contract reached almost nothing. These tests pin the repair: no pins at
// hire, the old ones retired on upgrade, and one source for every Flash id the code names.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripShippedPins, migrateWorkspacePins, SHIPPED_DEFAULT_MODELS } from '../platform/deployment/model-pins.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const contracts = JSON.parse(read('infra/contracts.json'));

describe('stripShippedPins', () => {
  it('REPRODUCES the survey: a 2.5-era pin and its 2.5-pro fallback are removed; maxSteps stays', () => {
    const { config, removed, kept } = stripShippedPins({
      model: 'vertex-google/gemini-2.5-flash', fallbackModel: 'vertex-google/gemini-2.5-pro', maxSteps: 50,
    });
    assert.deepEqual(config, { maxSteps: 50 });
    assert.deepEqual(removed.map((r) => r.key), ['model', 'fallbackModel']);
    assert.deepEqual(kept, []);
  });

  it('removes 3.5- and 3.6-era pins and the cortex Opus pin — all of them shipped defaults', () => {
    for (const m of ['vertex-google/gemini-3.6-flash', 'vertex-google/gemini-3.5-flash', 'vertex-anthropic/claude-opus-4-6', 'gemini-2.5-flash']) {
      assert.deepEqual(stripShippedPins({ model: m }).config, {}, m);
    }
  });

  it('keeps a model nobody shipped as a default — that is a deliberate override', () => {
    const { config, removed, kept } = stripShippedPins({ model: 'vertex-google/gemini-9.9-ultra', fallbackModel: 'vertex-google/gemini-3.6-flash' });
    assert.deepEqual(config, { model: 'vertex-google/gemini-9.9-ultra' });
    assert.deepEqual(removed.map((r) => r.key), ['fallbackModel']);
    assert.deepEqual(kept, [{ key: 'model', value: 'vertex-google/gemini-9.9-ultra' }]);
  });

  it('the shipped list covers every model the contract has ever named', () => {
    // The contract's CURRENT models are not in the list on purpose only if they were never
    // pinned; every model it names today must still be strippable once it is replaced.
    for (const m of Object.values(contracts.vertex.models)) {
      const bare = m.split('/').pop();
      if (bare === 'gemini-3.8-flash') continue; // never pinned: no bootstrap pins since this change
      assert.ok(SHIPPED_DEFAULT_MODELS.includes(bare), `${bare} is a shipped default and must be in SHIPPED_DEFAULT_MODELS`);
    }
  });
});

describe('migrateWorkspacePins — once per workspace, on upgrade', () => {
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), 'model-pins-'));
    const ws = (name, cfg) => {
      mkdirSync(join(root, name), { recursive: true });
      if (cfg !== undefined) writeFileSync(join(root, name, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
    };
    ws('workspace', { model: 'vertex-anthropic/claude-opus-4-6', fallbackModel: 'vertex-google/gemini-2.5-pro', maxSteps: 50 });
    ws('workspace-motor', { model: 'vertex-google/gemini-2.5-flash', fallbackModel: 'vertex-google/gemini-2.5-pro', maxSteps: 50 });
    ws('workspace-cerebellum', { model: 'vertex-google/some-operator-choice', maxSteps: 50 });
    ws('workspace-temporal-memory', '{not json');
    ws('workspace-empty');
    ws('shared', { model: 'vertex-google/gemini-2.5-flash' }); // not an organ workspace
    return root;
  };

  it('removes shipped pins, keeps overrides, backs up once, and leaves non-workspaces alone', () => {
    const root = tree();
    try {
      const report = migrateWorkspacePins(root);
      const by = Object.fromEntries(report.map((r) => [r.workspace, r]));
      assert.deepEqual(JSON.parse(read(relative(REPO, join(root, 'workspace-motor', 'config.json')))), { maxSteps: 50 });
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'workspace', 'config.json'), 'utf8')), { maxSteps: 50 });
      assert.equal(JSON.parse(readFileSync(join(root, 'workspace-cerebellum', 'config.json'), 'utf8')).model, 'vertex-google/some-operator-choice');
      assert.equal(by['workspace-motor'].backedUp, true);
      assert.ok(existsSync(join(root, 'workspace-motor', 'config.json.pre-model-migration')));
      assert.equal(JSON.parse(readFileSync(join(root, 'workspace-motor', 'config.json.pre-model-migration'), 'utf8')).model, 'vertex-google/gemini-2.5-flash');
      assert.ok(!existsSync(join(root, 'workspace-cerebellum', 'config.json.pre-model-migration')), 'nothing removed, nothing backed up');
      assert.match(by['workspace-temporal-memory'].error, /unreadable/);
      assert.equal(JSON.parse(readFileSync(join(root, 'shared', 'config.json'), 'utf8')).model, 'vertex-google/gemini-2.5-flash');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('is idempotent: a second upgrade changes nothing and keeps the first backup', () => {
    const root = tree();
    try {
      migrateWorkspacePins(root);
      const backup = readFileSync(join(root, 'workspace-motor', 'config.json.pre-model-migration'), 'utf8');
      const second = migrateWorkspacePins(root);
      assert.ok(second.every((r) => r.removed.length === 0));
      assert.equal(readFileSync(join(root, 'workspace-motor', 'config.json.pre-model-migration'), 'utf8'), backup);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the wiring', () => {
  it('neither bootstrap pins a model at hire any more', () => {
    for (const f of ['infra/bootstrap/fleet-bootstrap.sh', 'infra/bootstrap/prime-bootstrap.sh']) {
      const src = read(f);
      const block = src.slice(src.indexOf('agent_config = {'), src.indexOf("json.dump(agent_config"));
      assert.ok(block.length > 0, `${f} still writes a workspace config`);
      assert.doesNotMatch(block, /'model'|'fallbackModel'/, `${f} must not copy models into the workspace`);
      assert.match(block, /'maxSteps'/);
    }
  });

  it('the upgrade retires old pins before it restarts the services, and installs the module', () => {
    const up = read('corekit/system/upgrade-corekit');
    const migrate = up.indexOf('platform/deployment/model-pins.mjs');
    const restart = up.indexOf('# ---- Restart services ----');
    assert.ok(migrate > 0 && restart > 0 && migrate < restart);
    assert.match(read('infra/manifests/base.txt'), /^platform\/deployment\/model-pins\.mjs platform\/deployment\/model-pins\.mjs$/m);
  });

  it('the strong tier is Claude Opus, and the Anthropic path never sends top_p (Opus 4.6+ rejects it)', () => {
    assert.match(contracts.vertex.models.subagentStrong, /^vertex-anthropic\/claude-opus-/);
    const loop = read('corekit/brain/loop.mjs');
    const req = loop.slice(loop.indexOf('async function runAnthropicTurnSync'), loop.indexOf('async function', loop.indexOf('async function runAnthropicTurnSync') + 10));
    assert.doesNotMatch(req, /top_p\s*:/);
  });
});

describe('one source for every Flash model the code names', () => {
  // The next migration should be one contract edit. Every Gemini Flash id hard-coded in shipped
  // code — a fallback for a missing contract key — must equal the contract's current one.
  const FLASH = /gemini-\d+(?:\.\d+)?-flash[\w.-]*/g;
  const contractFlash = contracts.vertex.models.subagent.split('/').pop();
  const EXEMPT = new Set([
    'platform/deployment/model-pins.mjs',            // the history of shipped defaults, by design
    'app/src/app/api/models/scan/route.ts',          // a catalog scanner of the provider's models
  ]);
  const walk = (dir, out = []) => {
    for (const name of readdirSync(join(REPO, dir))) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const rel = `${dir}/${name}`;
      const st = statSync(join(REPO, rel));
      if (st.isDirectory()) walk(rel, out);
      else if (!/\.(md|json|png|jpg|svg|lock)$/.test(name) || rel.endsWith('skill.json')) out.push(rel);
    }
    return out;
  };

  it(`every hard-coded Flash id equals the contract's (${contractFlash})`, () => {
    const files = [...walk('platform'), ...walk('corekit'), ...walk('skills'), ...walk('infra/bootstrap'), ...walk('app/src')]
      .filter((f) => !EXEMPT.has(f) && !f.includes('/test/'));
    assert.ok(files.length > 100, 'the scan reached the code');
    const stale = [];
    for (const f of files) {
      for (const m of read(f).match(FLASH) || []) if (m !== contractFlash) stale.push(`${f}: ${m}`);
    }
    assert.deepEqual(stale, [], 'a stale Flash id survives a contract change — read it from the contract or update it');
  });
});
