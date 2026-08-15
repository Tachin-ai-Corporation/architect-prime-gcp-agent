/**
 * Which commit's content should the dashboard show?
 *
 * The catalog views fetch from GitHub `main`, which answers "what would a fresh
 * install get today". That is a different question from "what is this
 * deployment running", and the two look identical right up until they diverge —
 * which is the moment you most need them not to.
 *
 * A prime records `coreRef`, but it is initialised to the literal string
 * `"main"` and only becomes a commit once a deploy resolves one. So the ref is
 * one of two genuinely different things, and collapsing them is how a moving
 * target gets displayed as a version. This keeps them apart and makes the
 * caller say which it got.
 */

export type RefKind = "pinned" | "floating";

export interface ResolvedRef {
  /** The git ref to fetch content at. */
  ref: string;
  kind: RefKind;
  /** Operator-facing note; null when the ref is a real pinned commit. */
  caveat: string | null;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Resolve the ref to read a deployment's content at.
 *
 * A 40-hex commit is pinned: what the VM installed, and what its behaviour is
 * explained by. Anything else — a branch name, a missing value — is floating,
 * and is returned with a caveat rather than presented as a version.
 */
export function resolveDeployedRef(coreRef: string | null | undefined): ResolvedRef {
  if (coreRef && SHA.test(coreRef)) {
    return { ref: coreRef, kind: "pinned", caveat: null };
  }
  if (coreRef && coreRef !== "main") {
    return {
      ref: coreRef,
      kind: "floating",
      caveat: `Showing branch '${coreRef}', which moves. This may not be what the deployment is running.`,
    };
  }
  return {
    ref: "main",
    kind: "floating",
    caveat:
      "No deployed commit is recorded for this prime, so this shows repository main — " +
      "what a fresh install would get today, not necessarily what is running.",
  };
}

/** Raw-content URL for a path at a resolved ref. */
export function contentUrlAt(rawBase: string, resolved: ResolvedRef, path: string): string {
  return `${rawBase}/${resolved.ref}/${path.replace(/^\//, "")}`;
}
