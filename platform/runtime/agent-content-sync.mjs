#!/usr/bin/env node
// agent-content-sync — reconcile this agent's content with its assigned release.
//
// Runs on a timer, independent of any platform upgrade. That independence is the
// point: rolling out a soul change used to require a CoreKit upgrade, which
// conflated "the machinery changed" with "this deployment changed its mind"
// (C-36). A content release now reaches an agent without touching the platform,
// and a platform upgrade no longer overwrites deployment-owned content.
//
// One pass:
//   1. read the assignment            what should this agent be running
//   2. compile the spec locally       from the release's pinned content commit
//   3. verify digest == assigned      or refuse — see below
//   4. render to staging, verify      a partial render never reaches the live tree
//   5. wait for an idle boundary      definitions never change under running work
//   6. swap, keeping the previous     so a bad apply can be undone locally
//   7. report actual back             closing the desired/actual loop
//
// Step 3 is the one that matters most: if the spec this VM compiles differs from
// the digest the registry assigned, something upstream is not what was approved,
// and installing it anyway would make the evaluation and approval meaningless.
//
// Usage:
//   agent-content-sync              one pass, then exit (timer-driven)
//   agent-content-sync --watch      keep running
//   agent-content-sync --dry-run    decide and report, change nothing
//   agent-content-sync --emergency  apply without waiting for an idle boundary

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { createRegistry } from '../deployment/registry.mjs';
import { compileAgentSpec } from '../deployment/compiler.mjs';
import {
  reconcile, planApply, verifyStaged, installPath, firmwarePath, STAGING_DIR, PREVIOUS_DIR,
} from '../deployment/content-sync.mjs';
import { bytesDigest } from '../contracts/digest.mjs';
import { createClient } from '../persistence/firestore.mjs';

const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
const log = (level, msg) => console.log(`[content-sync] ${level}: ${msg}`);

const DRY_RUN = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const EMERGENCY = process.argv.includes('--emergency');

function contracts() {
  try {
    return JSON.parse(readFileSync(join(CORE_DIR, 'corekit', 'contracts.json'), 'utf8'));
  } catch {
    return {};
  }
}

function chatConfig() {
  try {
    return JSON.parse(readFileSync(join(CORE_DIR, 'corekit', 'chat-config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function platformVersion() {
  try {
    const state = JSON.parse(readFileSync(join(CORE_DIR, 'corekit', 'STATE.json'), 'utf8'));
    // STATE.json's `version` is a schema counter (a number), not the platform
    // coordinate. The commit the VM actually installed is `coreRef`, and that is
    // what a definition's compatibility range and a mission's stamp must name.
    return String(state.coreRef || state.version || 'unknown');
  } catch {
    return 'unknown';
  }
}

async function resolveProject() {
  if (process.env.GCP_PROJECT_ID) return process.env.GCP_PROJECT_ID;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  return (await r.text()).trim();
}

/** The agent id this VM answers to. */
function agentId() {
  return process.env.AGENT_ID
    || chatConfig().agentId
    || (chatConfig().agentUserEmail || '').split('@')[0].split('-').pop()
    || 'unknown';
}

/** Digests of the content currently installed, so a no-op is recognizable. */
function currentDigests(files) {
  const out = {};
  for (const bundlePath of files) {
    const live = join(CORE_DIR, installPath(bundlePath));
    if (existsSync(live)) out[bundlePath] = bytesDigest(readFileSync(live));
  }
  return out;
}

/** Work this agent owns, for the idle-boundary check. */
async function inFlight(db, agentEmail) {
  try {
    const docs = await db.query('', 'work', [
      { field: 'owner', op: 'EQUAL', value: { stringValue: agentEmail } },
      { field: 'status', op: 'EQUAL', value: { stringValue: 'active' } },
    ], { noOrderBy: true, limit: 50 });
    return docs || [];
  } catch (e) {
    // Fail closed: if we cannot tell whether work is running, do not swap
    // content underneath it.
    log('WARN', `cannot read in-flight work (${e.message}) — treating the agent as busy`);
    return [{ status: 'active', owner: agentEmail, type: 'M' }];
  }
}

/**
 * Is the Fleet Definition sync switched on for this deployment?
 *
 * `fleet_config.sync_enabled` existed in the contract and NOTHING READ IT — the
 * daemon consumed only `sync_interval_ms`. A flag that is documented as a
 * control and wired to nothing is worse than no flag: it is an off switch an
 * operator would reach for in an incident and find inert.
 *
 * Blast radius was in fact enforced elsewhere, by assignment presence — an agent
 * with no `fleet_assignments` record skips, so an un-assigned VM was never
 * touched whatever this said. That is a real gate, but it is not this one, and
 * only one of them was written down.
 *
 * Defaults to ON when absent: existing deployments have no such key and must
 * keep working. An explicit `false` is honoured.
 */
function syncEnabled() {
  const flag = contracts().fleet_config?.sync_enabled;
  return flag !== false;
}

async function onePass() {
  if (!syncEnabled()) {
    log('INFO', 'skip: fleet_config.sync_enabled is false — content sync is switched off for this deployment');
    return { action: 'skip', reason: 'sync disabled by contract' };
  }

  const projectId = await resolveProject();

  // git-store resolves its bucket and Firestore base from the environment and
  // caches that on first use. Under systemd (and under sudo) the daemon inherits
  // neither GCP_PROJECT_ID nor GOOGLE_CLOUD_PROJECT, which yielded a `projects//`
  // URL and a 400 that reads like a malformed request rather than a missing
  // variable. Set it from the value we just resolved, before anything touches
  // the store.
  process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || projectId;

  const agent = agentId();
  const cfg = chatConfig();
  const agentEmail = cfg.agentUserEmail || `${agent}@local`;

  const db = createClient({ projectId, logger: () => {} });
  const registry = createRegistry({ projectId, actor: agent, logger: (l, m) => log(l, m) });

  const assignment = await db.read(`fleet_assignments/${agent}`);
  if (!assignment) {
    log('INFO', `no assignment for '${agent}' — nothing to reconcile`);
    return { action: 'skip' };
  }

  // Compile locally from the release's content. Compiling here rather than
  // trusting a pushed bundle is what lets step 3 be a real check.
  //
  // This read is pinned to the ASSIGNED RELEASE's commit. It used to call
  // readDefinitions(), which reads the mutable branch tip — so an agent assigned
  // to release A compiled whatever the branch said at that moment and then
  // stamped the result `desired_release: A`. Approve a skill change, let the
  // branch move, and the fleet quietly diverges from the thing that was approved
  // while every coordinate still reads correct. Canary attribution, holdback,
  // evaluation and rollback all rest on a release id meaning one set of bytes.
  //
  // readReleaseDefinitions also fails closed on a tampered revision or a digest
  // mismatch, so a release that cannot be reproduced is never applied.
  let spec = null;
  let files = {};
  try {
    const { definitions } = await registry.readReleaseDefinitions(assignment.desired_release);
    const role = definitions.get(`role/${assignment.role_id}`);
    if (!role) throw new Error(`role '${assignment.role_id}' is not in the release`);

    const personas = [...definitions.values()].filter((d) => d.kind === 'persona' && d.role_id === role.id);
    const skills = (role.default_skills || []).map((id) => definitions.get(`skill/${id}`)).filter(Boolean);
    const responsibilities = (role.responsibilities || []).map((id) => definitions.get(`responsibility/${id}`)).filter(Boolean);

    const firmware = {};
    for (const organ of new Set(personas.map((p) => p.organ))) {
      // Base firmware is Foundation and stays manifest-installed; the overlay is
      // what the registry owns. Reading the *installed* base means a platform
      // upgrade to the firmware is picked up without a content release.
      //
      // It must be SOUL.base.md and nothing else. SOUL.md is this daemon's own
      // output, and composing onto it means composing onto the previous apply —
      // the overlay lands again on every pass. Falling back to SOUL.md when the
      // base is missing looks forgiving and is exactly how that happened, so a
      // missing base is an error now.
      const rel = firmwarePath(organ);
      const base = join(CORE_DIR, rel);
      if (!existsSync(base)) {
        throw new Error(
          `no base firmware at ${rel} for organ '${organ}'. ` +
          `Composing onto the rendered SOUL.md would duplicate the overlay; ` +
          `install the platform manifest that provides the base first.`
        );
      }
      firmware[organ] = readFileSync(base, 'utf8');
    }

    const compiled = compileAgentSpec({
      agentId: agent,
      platformVersion: platformVersion(),
      fleetRelease: assignment.desired_release,
      role, personas, skills, responsibilities, firmware,
      compiledAt: new Date().toISOString(),
    });
    spec = compiled.spec;
    files = compiled.files;
    for (const w of compiled.warnings) log('WARN', w);
  } catch (e) {
    log('ERROR', `compile failed: ${e.message}`);
    if (!DRY_RUN) await registry.reportApplied({ agentId: agent, releaseId: assignment.desired_release, specDigest: null, error: `compile: ${e.message}` });
    return { action: 'fail', reason: e.message };
  }

  const envelopes = await inFlight(db, agentEmail);
  const installed = currentDigests(Object.keys(files));
  const decision = reconcile({ assignment, spec, envelopes, agentEmail, installed, emergency: EMERGENCY });

  log('INFO', `${decision.action}: ${decision.reason}`);
  if (DRY_RUN) {
    const plan = planApply(installed, files);
    log('INFO', `would write ${plan.write.length}, remove ${plan.remove.length}, leave ${plan.unchanged.length}`);
    return decision;
  }
  if (decision.action === 'fail') {
    await registry.reportApplied({ agentId: agent, releaseId: assignment.desired_release, specDigest: null, error: decision.reason });
    return decision;
  }
  if (decision.action !== 'apply') return decision;

  // ---- Render to staging and verify there ----
  const staging = join(CORE_DIR, STAGING_DIR);
  rmSync(staging, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(staging, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  const staged = {};
  for (const path of Object.keys(files)) staged[path] = readFileSync(join(staging, path), 'utf8');

  const verdict = verifyStaged(staged, spec);
  if (!verdict.ok) {
    log('ERROR', `staged render rejected: ${verdict.reason}`);
    rmSync(staging, { recursive: true, force: true });
    await registry.reportApplied({ agentId: agent, releaseId: assignment.desired_release, specDigest: null, error: `staging: ${verdict.reason}` });
    return { action: 'fail', reason: verdict.reason };
  }

  // ---- Swap, keeping the previous bundle ----
  const plan = planApply(installed, files);
  const previous = join(CORE_DIR, PREVIOUS_DIR);
  rmSync(previous, { recursive: true, force: true });

  for (const bundlePath of plan.write) {
    const live = join(CORE_DIR, installPath(bundlePath));
    if (existsSync(live)) {
      const backup = join(previous, bundlePath);
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, readFileSync(live));
    }
    mkdirSync(dirname(live), { recursive: true });
    // Rename within the same filesystem is atomic, so a reader never sees a
    // half-written SOUL — and organ config is read fresh per call, so the next
    // call picks this up with no restart.
    renameSync(join(staging, bundlePath), live);
  }

  for (const bundlePath of plan.remove) {
    const live = join(CORE_DIR, installPath(bundlePath));
    if (!existsSync(live)) continue;
    const backup = join(previous, bundlePath);
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, readFileSync(live));
    rmSync(live, { force: true });
  }

  rmSync(staging, { recursive: true, force: true });
  writeFileSync(join(CORE_DIR, 'corekit', 'CONTENT.json'), JSON.stringify({
    agent, release: assignment.desired_release, spec_digest: spec.digest,
    tree_digest: spec.bundle.tree_digest, applied_at: new Date().toISOString(),
    files: Object.keys(files).length,
  }, null, 2) + '\n', 'utf8');

  await registry.reportApplied({ agentId: agent, releaseId: assignment.desired_release, specDigest: spec.digest });
  log('INFO', `applied ${assignment.desired_release} (${spec.digest.slice(0, 19)}…): ${plan.write.length} written, ${plan.remove.length} removed, ${plan.unchanged.length} unchanged`);
  return { action: 'applied', digest: spec.digest };
}

const intervalMs = (contracts().fleet_config?.sync_interval_ms) || 300_000;

if (WATCH) {
  log('INFO', `watching, every ${Math.round(intervalMs / 1000)}s`);
  for (;;) {
    try { await onePass(); } catch (e) { log('ERROR', e.message); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
} else {
  try {
    const result = await onePass();
    process.exit(result.action === 'fail' ? 1 : 0);
  } catch (e) {
    log('ERROR', e.message);
    process.exit(1);
  }
}
