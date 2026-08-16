// test/contract-liveness.test.mjs — a contract key nothing reads is not a control
//
// C-7 makes contracts.json the single source of truth. A key that no code reads
// is worse than clutter: it is an operator-facing control wired to nothing. The
// one that prompted this was `fleet_config.sync_enabled` — documented as the
// switch governing Fleet Definition sync, present and `true`, and consumed by
// absolutely nothing. It is the switch someone would reach for in an incident
// and find inert.
//
// This is a RATCHET, not a cleanup. The known-unread keys below are recorded
// debt: the list may shrink, and a new entry fails the build. Freezing the
// number is the point — the previous state had no way to notice a control going
// dead, which is how one did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const norm = (p) => p.split(/[\\/]/).join('/');

/**
 * Keys with no reader today.
 *
 * Each line is a debt, not an exemption. Removing a key from the contract, or
 * wiring it to the code that should honour it, is how an entry leaves.
 */
const KNOWN_UNREAD = new Set([
  // Flag-gated brain guards whose gate was never wired to the guard.
  'dispatch.process_checkpoint_verification',
  'dispatch.delegation.reclaim_enabled',

  // Declared budgets that no call site consults.
  'utility.context_budgets.cortex_step',
  'utility.context_budgets.dispatch_success',
  'utility.context_budgets.dispatch_failure',
  'utility.disable_thinking',

  // A secret NAME, resolved at runtime by the broker rather than by this key.
  'github.tokenSecret',

  // VERIFIED DEAD: nothing exports contracts.env into any daemon — no systemd
  // Environment= line, no bootstrap write. The genai SDK reads
  // GOOGLE_GENAI_USE_VERTEXAI from process.env, which this never sets; Vertex is
  // configured explicitly in code instead. Safe to delete, pending a fleet
  // restart to confirm nothing regressed.
  'env.GOOGLE_GENAI_USE_VERTEXAI',
  'env.GCE_METADATA_HOST',

  // Documentation of the commit format, consumed by humans and CI shell rather
  // than by application code.
  'versioning.commitFormat',
  'versioning.canonicalRegex',
  'versioning.backcompatRegex',
]);

function walk(dir, test_, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, test_, out);
    else if (test_(e)) out.push(norm(p));
  }
  return out;
}

/** Every leaf key path in the compiled contract, ignoring `_comment` prose. */
function leafKeys(obj, path = [], out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    const p = [...path, k];
    if (v && typeof v === 'object' && !Array.isArray(v)) leafKeys(v, p, out);
    else out.push(p.join('.'));
  }
  return out;
}

test('every contract key has a reader, or is recorded as debt', () => {
  const contracts = JSON.parse(readFileSync(join(ROOT, 'infra', 'contracts.json'), 'utf8'));
  const keys = leafKeys(contracts);
  assert.ok(keys.length > 100, `expected a substantial contract, found ${keys.length} keys — the scan is broken`);

  const code = [];
  // platform/ carries the runtime; corekit/ still holds the gateway module,
  // system tools and config. A scan root that misses where the code lives does
  // not report less coverage — it reports the contract as dead.
  for (const dir of ['platform', 'corekit', 'app/src', 'infra']) {
    for (const f of walk(join(ROOT, dir), (e) => /\.(mjs|ts|tsx|sh|yml)$/.test(e) || extname(e) === '')) {
      // The contract sources are where the keys are DEFINED, not read.
      if (/(contracts|fleet-policy|platform-defaults)\.json$/.test(f)) continue;
      if (f.includes('/node_modules/')) continue;
      try { code.push(readFileSync(f, 'utf8')); } catch { /* unreadable */ }
    }
  }
  assert.ok(code.length > 50, 'the code corpus is suspiciously small — the scan is broken');

  const unread = keys.filter((k) => {
    const leaf = k.slice(k.lastIndexOf('.') + 1);
    const rx = new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return !code.some((txt) => rx.test(txt));
  });

  const surprises = unread.filter((k) => !KNOWN_UNREAD.has(k));
  assert.deepEqual(surprises, [],
    `contract key(s) with no reader:\n  ${surprises.join('\n  ')}\n\n` +
    `A key nothing reads is a control wired to nothing. Either honour it in code, ` +
    `remove it from the contract, or add it to KNOWN_UNREAD with the reason.`);
});

test('the debt list only shrinks — an entry that gained a reader must be removed', () => {
  // Otherwise the list becomes a graveyard nobody revisits, and the ratchet
  // stops meaning anything.
  const contracts = JSON.parse(readFileSync(join(ROOT, 'infra', 'contracts.json'), 'utf8'));
  const keys = new Set(leafKeys(contracts));
  const stale = [...KNOWN_UNREAD].filter((k) => !keys.has(k));
  assert.deepEqual(stale, [],
    `KNOWN_UNREAD names key(s) that are no longer in the contract: ${stale.join(', ')}. Remove them.`);
});

test('fleet_config.sync_enabled is honoured — the switch that started this', () => {
  const src = readFileSync(join(ROOT, 'platform', 'runtime', 'agent-content-sync.mjs'), 'utf8');
  assert.match(src, /sync_enabled/,
    'the daemon must consult the flag that documents whether it should run at all');
  assert.match(src, /flag !== false/,
    'absent must mean ON, or every existing deployment stops syncing on upgrade');
});
