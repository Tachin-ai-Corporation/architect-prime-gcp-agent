// platform/deployment/content-sync.mjs — applying a Fleet release to a VM
//
// The step that makes a definition *live*. It replaces two mechanisms that were
// never designed to carry deployment-owned content:
//
//   * `assemble-persona`, which appended specialty text to the live SOUL.md in
//     place — no staging, no digest, no way to know what an agent is actually
//     running, and correct only because an upgrade happened to reinstall the base
//     file first;
//   * the custom-skill block inside `upgrade-corekit`, which tied content rollout
//     to a platform upgrade (C-36 says those are different things) and keyed its
//     lookup off `agentDisplayName`, so a skill queued under `millie` was read
//     back under `Assistant Agent Millie` and never found.
//
// Shape: render the whole bundle to staging, verify its digest there, and only
// then move it into place. A partial render never reaches the live tree, because
// the digest check happens before anything live is touched.
//
// The planning is pure and testable; the caller owns the filesystem.

import { bytesDigest, treeDigest } from '../contracts/digest.mjs';

/** Where a render is assembled before it is trusted. */
export const STAGING_DIR = '.content-staging';

/** Where the previous bundle is kept so a bad apply can be undone locally. */
export const PREVIOUS_DIR = '.content-previous';

/**
 * Decide what applying a bundle would change.
 *
 * Comparing digests rather than bytes keeps the plan honest about no-ops: a
 * release that only moves an unrelated definition should touch nothing on this
 * agent, and reporting "27 files written" when none changed would make the log
 * useless for spotting a real apply.
 *
 * @param {Record<string,string>} current  - path → digest of what is live
 * @param {Record<string,string>} desired  - path → content of the new bundle
 * @returns {{ write: string[], remove: string[], unchanged: string[] }}
 */
export function planApply(current, desired) {
  const write = [];
  const unchanged = [];

  for (const [path, content] of Object.entries(desired)) {
    if (current[path] === bytesDigest(content)) unchanged.push(path);
    else write.push(path);
  }

  // A file the bundle no longer contains is content this agent should stop
  // having. Leaving it behind is how an agent keeps a skill after the release
  // that removed it — the drift C-36 exists to prevent.
  const remove = Object.keys(current).filter((p) => !(p in desired));

  return { write: write.sort(), remove: remove.sort(), unchanged: unchanged.sort() };
}

/**
 * Verify a staged render before anything live is touched.
 *
 * Two independent checks: every file matches its own recorded digest, and the
 * tree as a whole matches the spec's. The second catches a file that is
 * individually valid but absent or extra — which per-file checks alone miss.
 */
export function verifyStaged(staged, spec) {
  const expected = spec?.bundle?.files || {};
  const problems = [];

  for (const [path, expectedDigest] of Object.entries(expected)) {
    if (!(path in staged)) { problems.push(`${path}: missing from the staged render`); continue; }
    const actual = bytesDigest(staged[path]);
    if (actual !== expectedDigest) problems.push(`${path}: digest mismatch`);
  }
  for (const path of Object.keys(staged)) {
    if (!(path in expected)) problems.push(`${path}: staged but not declared by the spec`);
  }

  if (problems.length) return { ok: false, reason: problems.join('; ') };

  const actualTree = treeDigest(staged);
  if (actualTree !== spec.bundle.tree_digest) {
    return { ok: false, reason: `tree digest ${actualTree} does not match the spec's ${spec.bundle.tree_digest}` };
  }
  return { ok: true, reason: 'staged render verified' };
}

/**
 * Does the content on disk actually match the spec?
 *
 * The registry's `actual_spec_digest` records what an apply *reported*, which is
 * a claim about the past. A platform upgrade reinstalls Foundation files from
 * the manifest and can revert a rendered soul underneath that claim, and the
 * agent then runs Foundation defaults while the registry insists it is
 * converged. Re-deriving from the live tree is the difference between "we said
 * so" and "it is so" (B-28).
 *
 * @param {Record<string,string>} installed - bundle path → digest of what is live
 * @param {object} spec
 */
export function bundleMatches(installed, spec) {
  const expected = spec?.bundle?.files || {};
  for (const [path, digest] of Object.entries(expected)) {
    if (installed[path] !== digest) return false;
  }
  return true;
}

/**
 * Is this agent at a boundary where new content may take effect?
 *
 * Definitions must not change underneath running work (C-32): a mission reads
 * its pinned spec for its whole life, and swapping a soul mid-mission would make
 * the mission's own record of what produced it a lie. An emergency rollback is
 * the one case that does not wait — a regressive candidate should stop being
 * live as fast as possible.
 *
 * @param {Array<{status:string, owner:string, type:string}>} envelopes
 * @param {{ emergency?: boolean, owner?: string }} opts
 */
export function isIdle(envelopes, opts = {}) {
  if (opts.emergency) return { idle: true, reason: 'emergency rollback does not wait for a boundary' };

  const busy = (envelopes || []).filter((e) => {
    if (opts.owner && e.owner !== opts.owner) return false;
    return e.status === 'active';
  });

  if (busy.length) {
    return { idle: false, reason: `${busy.length} mission(s) in flight — content applies at an idle boundary (C-32)` };
  }
  return { idle: true, reason: 'no work in flight' };
}

/**
 * The full decision for one reconciliation pass.
 *
 * Returns what the caller should do and why, so the daemon is a thin executor
 * and every branch is testable without a filesystem.
 *
 * @param {object} input
 * @param {object|null} input.assignment - fleet_assignments record
 * @param {object|null} input.spec       - the compiled Effective Agent Spec
 * @param {Array} input.envelopes        - current work, for the idle check
 * @param {string} input.agentEmail
 * @param {Record<string,string>} [input.installed] - bundle path → digest of what
 *   is live. Supplied by the daemon; when absent the convergence check falls
 *   back to the registry's own record, which cannot see drift on disk.
 * @param {boolean} [input.emergency]
 * @returns {{ action: 'apply'|'skip'|'wait'|'fail', reason: string, detail?: object }}
 */
export function reconcile(input) {
  const { assignment, spec, envelopes, agentEmail, installed, emergency = false } = input;

  if (!assignment) {
    return { action: 'skip', reason: 'no assignment — this agent is not managed by a fleet release yet' };
  }
  if (!assignment.desired_release) {
    return { action: 'skip', reason: 'assignment names no desired release' };
  }
  if (!spec) {
    return { action: 'fail', reason: `could not compile a spec for release ${assignment.desired_release}` };
  }

  // The digest the registry expects and the digest we computed must agree. A
  // mismatch means this VM would install something other than what was
  // validated, evaluated and approved — the whole point of pinning.
  if (assignment.desired_spec_digest && assignment.desired_spec_digest !== spec.digest) {
    return {
      action: 'fail',
      reason:
        `compiled spec ${spec.digest} does not match the assigned ${assignment.desired_spec_digest}. ` +
        `Refusing to apply content that was not the content approved.`,
      detail: { computed: spec.digest, assigned: assignment.desired_spec_digest },
    };
  }

  // The record says converged and the disk agrees — nothing to do. When the two
  // disagree we re-apply rather than trust the record, because otherwise a
  // platform upgrade that reverted a rendered file leaves the agent
  // permanently out of date: nothing would ever ask again.
  let drift = false;
  if (assignment.actual_spec_digest === spec.digest && assignment.actual_release === assignment.desired_release) {
    if (!installed || bundleMatches(installed, spec)) {
      return { action: 'skip', reason: 'already converged' };
    }
    drift = true;
  }

  // Drift is not an emergency: repairing it still waits for an idle boundary,
  // because swapping content under a running mission is the thing C-32 forbids
  // regardless of why we are swapping.
  const idle = isIdle(envelopes, { emergency, owner: agentEmail });
  if (!idle.idle) return { action: 'wait', reason: idle.reason };

  const reason = drift
    ? 'content on disk has drifted from the assigned spec — re-applying'
    : emergency ? 'emergency apply' : idle.reason;

  return {
    action: 'apply',
    reason,
    detail: { release: assignment.desired_release, digest: spec.digest, ...(drift ? { drift: true } : {}) },
  };
}

/**
 * Map a bundle path to where it lands under the install root.
 *
 * The compiler emits paths in the agent's own vocabulary
 * (`workspace-cortex/SOUL.md`); this is the one place that knows the deployed
 * layout, so a layout change does not reach into the compiler.
 *
 * Cortex is the exception and it is historical: its workspace is `workspace/`,
 * not `workspace-cortex/`, and every manifest and daemon path already assumes so.
 */
export function installPath(bundlePath) {
  if (bundlePath === 'workspace-cortex/SOUL.md') return 'workspace/SOUL.md';
  return bundlePath;
}

/** Every install path a bundle would occupy. */
export function installPaths(files) {
  return Object.keys(files).map(installPath).sort();
}

/**
 * Where an organ's BASE firmware is read from — never where its soul is written.
 *
 * The two are deliberately different files. Composition reads the base and
 * writes the render, so the render can be recomputed from scratch on every
 * apply. When both were `SOUL.md` each apply composed onto its own output and
 * the overlay accumulated one copy per pass, which is the defect this pair
 * exists to make impossible.
 */
export function firmwarePath(organ) {
  const workspace = organ === 'cortex' ? 'workspace' : `workspace-${organ}`;
  return `${workspace}/SOUL.base.md`;
}
