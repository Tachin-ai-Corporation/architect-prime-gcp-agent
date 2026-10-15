// platform/deployment/model-pins.mjs — retire the model pins agents were hired with.
//
// The bootstraps used to write each organ's `workspace*/config.json` with `model` and
// `fallbackModel` COPIED from the contract on the day the agent was hired, and the gateway
// prefers that pin over the contract (corekit/brain/config.mjs). Upgrades never touch
// workspace-*/, so every agent kept running whatever model was current when it was hired: a
// 2026-10-05 survey found seven of ten agents still on gemini-2.5-flash while the contract said
// gemini-3.6-flash, and a model change in the contract reached almost nothing (C-7: the contract
// is the single source of truth).
//
// The upgrade runs this once per workspace: a pin whose value is a model the platform itself has
// shipped as a default is a copy, not a choice, and is removed — the organ then follows the
// contract. Any other value is somebody's deliberate override; it is kept and reported. The
// original file is backed up once, before the first change. Idempotent (C-18).
//
// Usage (upgrade-corekit): node platform/deployment/model-pins.mjs <core-root>

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every model the platform has shipped as a default (git history of the contract sources). */
export const SHIPPED_DEFAULT_MODELS = Object.freeze([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'claude-opus-4-6',
]);

/** The keys a hire-time pin occupies. maxSteps is left alone — it is not a model. */
export const PIN_KEYS = Object.freeze(['model', 'fallbackModel']);

const bare = (m) => String(m || '').split('/').pop();

/**
 * Remove the pins that merely restate a shipped default.
 *
 * @param {object} config - a workspace config.json
 * @returns {{config: object, removed: Array<{key:string, value:string}>, kept: Array<{key:string, value:string}>}}
 */
export function stripShippedPins(config) {
  const next = { ...(config || {}) };
  const removed = [];
  const kept = [];
  for (const key of PIN_KEYS) {
    if (!(key in next)) continue;
    const value = next[key];
    if (SHIPPED_DEFAULT_MODELS.includes(bare(value))) {
      delete next[key];
      removed.push({ key, value });
    } else {
      kept.push({ key, value });
    }
  }
  return { config: next, removed, kept };
}

/**
 * Apply stripShippedPins to every organ workspace under a core root.
 *
 * @param {string} coreRoot - e.g. /opt/corekit
 * @param {object} [io] - injectable for tests
 * @returns {Array<{workspace:string, removed:Array, kept:Array, backedUp:boolean}>}
 */
export function migrateWorkspacePins(coreRoot, io = {}) {
  const fs = { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, ...io };
  const report = [];
  const workspaces = fs.readdirSync(coreRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name === 'workspace' || d.name.startsWith('workspace-')))
    .map((d) => d.name)
    .sort();
  for (const ws of workspaces) {
    const path = join(coreRoot, ws, 'config.json');
    if (!fs.existsSync(path)) continue;
    let config;
    try {
      config = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
      report.push({ workspace: ws, removed: [], kept: [], backedUp: false, error: 'unreadable config.json — left as it is' });
      continue;
    }
    const { config: next, removed, kept } = stripShippedPins(config);
    let backedUp = false;
    if (removed.length > 0) {
      const backup = `${path}.pre-model-migration`;
      if (!fs.existsSync(backup)) {
        fs.copyFileSync(path, backup);
        backedUp = true;
      }
      fs.writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    }
    report.push({ workspace: ws, removed, kept, backedUp });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] || '/opt/corekit';
  for (const r of migrateWorkspacePins(root)) {
    if (r.error) { console.log(`  ${r.workspace}: ${r.error}`); continue; }
    for (const p of r.removed) console.log(`  ${r.workspace}: removed hire-time pin ${p.key}=${p.value} — follows the contract now`);
    for (const p of r.kept) console.log(`  ${r.workspace}: KEPT ${p.key}=${p.value} — not a shipped default, treated as a deliberate override`);
  }
}
