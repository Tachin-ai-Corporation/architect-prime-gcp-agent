// corekit/contracts/contract-planes.mjs — which contract values belong to which plane
//
// C-7 used to read "infra/contracts.json is the single source of truth". That was
// right about there being one authority and wrong about there being one *owner*:
// the file mixes platform mechanism (the gateway's port, the organ topology, the
// commit-message grammar) with deployment policy (which model this fleet runs,
// how many re-delegations it tolerates, which GitHub org it lives in). A
// deployment that wants a different model had to edit the same file that defines
// the machine.
//
// The split is by plane (C-29), not by file convenience:
//
//   infra/platform-defaults.json  — Foundation. Changes only by platform release.
//   infra/fleet-policy.json       — deployment-owned. Tunable per deployment.
//   infra/contracts.json          — GENERATED. The compiled effective snapshot
//                                   every consumer keeps reading, with provenance.
//
// Nothing downstream changed: bootstraps, validate-contracts and the VM still
// read one file at one path. What changed is that the file now records where each
// value came from, and a deployment cannot silently redefine a mechanism.

/**
 * Key paths owned by Foundation.
 *
 * A path here means "the whole subtree", except where a deeper path appears —
 * the deepest match wins, so `vertex.context_windows` can be Foundation while
 * the rest of `vertex` is policy.
 *
 * The test for membership is the C-29 classification test: would two unrelated
 * deployments reasonably want different values? If yes, it is policy. Ports,
 * organ names, protocol grammar and storage layout are the same everywhere the
 * product runs; models, regions, thresholds and repo coordinates are not.
 */
export const PLATFORM_PATHS = [
  // The organ topology itself. B-36: tenant content composes onto organs, it
  // never redefines which organs exist.
  'agents',

  // Provider ABI facts, not choices. A model's context window is a property of
  // the model; a deployment cannot decide it.
  'vertex.context_windows',

  // Gateway wiring. The port and bind address are how the daemons find each
  // other; every deployment runs the same loopback funnel (B-20).
  'gateway.port',
  'gateway.bind',

  // Execution guardrails whose ceilings exist for correctness, not taste — see
  // the budget posture note. A deployment may not raise a Firestore-document
  // bound by editing config.
  'tools',

  // Runtime environment the code requires to function at all.
  'env',

  // C-23: the commit grammar is a platform invariant. The dashboard parses it.
  'versioning',

  // The canonical workspace path catalog — where each organ's files live.
  'workspaces',

  // Artifact substrate mechanics (C-24). The bucket name is tenant-specific and
  // stays in policy; the protocol constants do not.
  'git.prefix',
  'git.artifacts_prefix',
  'git.defaultBranch',
  'git.maxPushRetries',
  'git.gcBundleThreshold',
];

/** Metadata keys the compiler owns; they are never authored by hand. */
export const GENERATED_KEYS = ['_provenance'];

/** True when a dotted path is Foundation-owned. */
export function isPlatformPath(path) {
  for (const p of PLATFORM_PATHS) {
    if (path === p || path.startsWith(`${p}.`)) return true;
  }
  return false;
}

/**
 * True when a path is a *prefix* of some platform path — i.e. a container whose
 * subtree is partly Foundation. Used so the splitter walks into `vertex` and
 * `git` instead of assigning them wholesale.
 */
function isPlatformAncestor(path) {
  return PLATFORM_PATHS.some((p) => p.startsWith(`${path}.`));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Split a compiled contracts object into its two authored sources.
 *
 * `_comment` keys travel with the subtree they document, so the explanation of a
 * setting stays beside the setting.
 *
 * @param {object} compiled
 * @returns {{ platform: object, policy: object }}
 */
export function splitContracts(compiled) {
  const platform = {};
  const policy = {};

  const walk = (node, prefix, platformOut, policyOut) => {
    for (const [key, value] of Object.entries(node)) {
      if (GENERATED_KEYS.includes(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;

      if (isPlatformPath(path)) {
        platformOut[key] = value;
        continue;
      }
      if (isPlainObject(value) && isPlatformAncestor(path)) {
        // Mixed subtree: descend and place each leaf on its own side.
        const p = {};
        const f = {};
        walk(value, path, p, f);
        if (Object.keys(p).length) platformOut[key] = p;
        if (Object.keys(f).length) policyOut[key] = f;
        continue;
      }
      policyOut[key] = value;
    }
  };

  walk(compiled, '', platform, policy);
  return { platform, policy };
}

/**
 * Deep merge with Foundation winning.
 *
 * Policy may not override a platform path — that is the whole boundary. A policy
 * file that tries is reported rather than silently ignored, because a value
 * someone wrote and the system discarded is a lie waiting to be debugged.
 */
export function compileContracts(platform, policy, opts = {}) {
  const conflicts = [];

  /**
   * Overlay the Foundation subtree onto the policy subtree.
   *
   * Foundation always wins on a Foundation path — that is the boundary, and a
   * boundary that yields to whoever wrote last is not one. A policy value found
   * at such a path is recorded as a conflict and discarded, so the compile fails
   * loudly instead of quietly running the deployment's number.
   */
  const overlay = (base, over, prefix) => {
    const out = { ...base };
    for (const [key, value] of Object.entries(over || {})) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = overlay(out[key], value, path);
        continue;
      }
      if (isPlatformPath(path) && Object.prototype.hasOwnProperty.call(base, key)) {
        conflicts.push(path);
      }
      out[key] = value;
    }
    return out;
  };

  const effective = overlay(policy, platform, '');

  const provenance = {
    _comment:
      'GENERATED by corekit/system/compile-contracts. Do not edit. ' +
      'Foundation values come from infra/platform-defaults.json (changed only by a platform release); ' +
      'deployment values come from infra/fleet-policy.json. See PRODUCT_CANON C-7 and C-29.',
    compiled_from: {
      platform_defaults: opts.platformDigest || null,
      fleet_policy: opts.policyDigest || null,
    },
    platform_paths: [...PLATFORM_PATHS],
  };

  return { effective: { _provenance: provenance, ...effective }, conflicts };
}

/**
 * Every leaf path in an object, dotted. Used to prove a split is lossless.
 */
export function leafPaths(node, prefix = '', out = []) {
  for (const [key, value] of Object.entries(node || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) leafPaths(value, path, out);
    else out.push(path);
  }
  return out;
}
