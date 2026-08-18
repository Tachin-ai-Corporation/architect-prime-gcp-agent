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
//   5. wait for an idle boundary      unless a previous apply was interrupted
//   6. swap, then record what we manage   atomically, before the evidence is dropped
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

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { createRegistry } from '../deployment/registry.mjs';
import { compileAgentSpec } from '../deployment/compiler.mjs';
import {
  reconcile, planApply, verifyStaged, installPath, firmwarePath, managedFromRecord, STAGING_DIR,
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

/**
 * Digests of the managed content currently installed, so a no-op is recognizable
 * AND a retired file is visible.
 *
 * The caller used to pass `Object.keys(files)` — the DESIRED paths — so `current`
 * could never hold a key `desired` lacked, and planApply's removal set was
 * structurally empty. The pure planner was always correct; it was fed an
 * inventory that made removal impossible. A skill dropped from a release stayed
 * installed, stayed in the runtime index, and the sync reported success.
 *
 * The inventory must be the UNION of what the new bundle wants and what this
 * agent managed last time.
 */
function currentDigests(inventory) {
  const out = {};
  for (const bundlePath of inventory) {
    const live = join(CORE_DIR, installPath(bundlePath));
    if (existsSync(live)) out[bundlePath] = bytesDigest(readFileSync(live));
  }
  return out;
}

/** Where the applied-content record lives. */
const CONTENT_RECORD = () => join(CORE_DIR, 'corekit', 'CONTENT.json');

/**
 * Write a JSON record so a reader sees it wholly old or wholly new.
 *
 * writeFileSync truncates and then writes, so a crash inside it leaves a
 * TRUNCATED file — valid-looking, unparseable, and indistinguishable from a
 * record that legitimately lacks a field. Temp-plus-rename cannot produce that
 * state: rename(2) within a directory is atomic.
 */
function writeRecord(path, value) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/**
 * The path set this agent managed on its last apply, or null if unknowable.
 *
 * The read is here; the decision is in managedFromRecord (B-19), because the case
 * that matters is a CORRUPT record and that case cannot be reached in a test
 * through a daemon that runs on import. `null` is not `[]` — see there.
 */
function previouslyManaged() {
  try {
    return managedFromRecord(readFileSync(CONTENT_RECORD(), 'utf8'));
  } catch {
    return null;
  }
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

  // Retire the directory the previous version of this daemon left behind.
  //
  // `.content-previous` was written by every apply and read by nothing. Removing
  // the code that wrote it does not remove the ~27 stale files already sitting
  // under it on every deployed VM, and a directory named "previous" that nothing
  // maintains is a worse artifact than the code was: the next person to inspect a
  // VM would reasonably read it as a rollback source and reason from bytes that
  // stopped being updated at whatever release was live when this shipped.
  //
  // Idempotent (C-18) and self-deleting: the branch stops firing once it has run,
  // and it costs one existsSync on a pass that is usually a no-op anyway. Disposal
  // belongs to the code that created the mess, not to an operator runbook.
  //
  // Not under --dry-run. That flag is documented as "decide and report, change
  // nothing", and a cleanup is still a change — an operator inspecting a suspect
  // VM with --dry-run must get the same tree back, or the diagnostic destroys the
  // evidence it was run to look at.
  const retired = join(CORE_DIR, '.content-previous');
  if (!DRY_RUN && existsSync(retired)) {
    rmSync(retired, { recursive: true, force: true });
    log('INFO', 'removed .content-previous — it was written by every apply and read by nothing; '
      + 'rollback is registry.rollback() re-rendering from the predecessor release\'s pinned commit');
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

  // A staging tree at the top of a pass means the previous apply died between the
  // render and the end of the swap, so the live tree may be half of one generation
  // and half of another. That is the one state in which waiting for an idle
  // boundary makes things worse rather than safer — see isIdle().
  const staging = join(CORE_DIR, STAGING_DIR);
  const interrupted = existsSync(staging);
  if (interrupted) {
    log('WARN', 'a staging tree is present — the previous apply did not finish; the live tree may be mixed');
  }

  const envelopes = await inFlight(db, agentEmail);
  const prior = previouslyManaged();
  if (prior === null) {
    log('WARN',
      'no managed-path manifest in CONTENT.json (pre-manifest record) — retired files cannot be '
      + 'identified on THIS pass; this apply writes one, and removals work from the next apply on');
  }
  const installed = currentDigests(new Set([...Object.keys(files), ...(prior || [])]));
  const decision = reconcile({
    assignment, spec, envelopes, agentEmail, installed, emergency: EMERGENCY, interrupted,
  });

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
  if (decision.action !== 'apply') {
    // Clear the marker on the way out. A render is never worth keeping — the next
    // apply recomputes it from the release's pinned commit — and leaving it makes
    // `interrupted` latch true forever, which would quietly repeal the idle gate on
    // every later pass. A flag that cannot go back to false is not a flag.
    if (interrupted) {
      rmSync(staging, { recursive: true, force: true });
      log('INFO', 'cleared the stale staging tree; the next apply re-renders from the pinned commit');
    }
    return decision;
  }

  // ---- Render to staging and verify there ----
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

  // ---- Swap ----
  //
  // Per-file rename, and that is as atomic as this gets here. A single-pointer
  // generation switch was designed and rejected: it needs the live paths to be
  // symlinks into a content store, and three existing writers break that on every
  // platform upgrade — install.sh's flagless `cp` writes THROUGH a symlinked dest
  // into the store (corrupting the content-addressed bytes), while its `sed -i`
  // template pass and assemble-persona's `mv -f` each replace the link with a
  // regular file. Nothing would notice, because drift detection hashes content
  // THROUGH the link and never lstats it. It would also buy an invariant no
  // reader can observe: the brain builds its skill index once at module load and
  // caches souls for 60s, so the generation boundary a reader actually sees is
  // already smeared across a process lifetime.
  //
  // What is worth having is below — a record that cannot be torn, written before
  // the evidence of an unfinished apply is dropped.
  const plan = planApply(installed, files);

  for (const bundlePath of plan.write) {
    const live = join(CORE_DIR, installPath(bundlePath));
    mkdirSync(dirname(live), { recursive: true });
    // Rename within the same filesystem is atomic, so a reader never sees a
    // half-written SOUL — and organ config is read fresh per call, so the next
    // call picks this up with no restart.
    renameSync(join(staging, bundlePath), live);
  }

  for (const bundlePath of plan.remove) {
    const live = join(CORE_DIR, installPath(bundlePath));
    if (existsSync(live)) rmSync(live, { force: true });
  }

  // The managed-path record, written atomically and BEFORE the staging tree goes.
  //
  // Both halves are load-bearing. This file is the ONLY record of which paths
  // this agent manages, so a torn write is not a cosmetic loss: a record that
  // will not parse makes previouslyManaged() return null, the next pass cannot
  // see a path the new release dropped, and the following apply rewrites
  // `managed` without it — the retired file becomes permanently invisible and the
  // agent keeps a capability the release removed. That is Finding D reintroduced
  // by a crash instead of by a bug, and it is the one failure on this path that
  // does not self-heal. The record also feeds the coordinate stamp every work
  // envelope carries (agent-brain reads spec_digest from here), so tearing it
  // mislabels provenance as well as losing it.
  //
  // Ordering: the record lands while the staging tree still exists, so there is
  // no window in which the apply is finished, unrecorded, and no longer
  // detectable as unfinished.
  writeRecord(join(CORE_DIR, 'corekit', 'CONTENT.json'), {
    agent, release: assignment.desired_release, spec_digest: spec.digest,
    tree_digest: spec.bundle.tree_digest, applied_at: new Date().toISOString(),
    files: Object.keys(files).length,
    // The managed path set, path -> digest. `files` above is a COUNT and was the
    // only record kept, which is why the previous path set was unrecoverable and
    // nothing could ever be retired. Kept alongside for readers that use it.
    managed: spec.bundle.files || {},
  });

  rmSync(staging, { recursive: true, force: true });

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
