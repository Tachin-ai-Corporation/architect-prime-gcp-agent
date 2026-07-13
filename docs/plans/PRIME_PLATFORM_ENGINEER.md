# Prime as Fleet Platform Engineer — Rungs 3–4 Design

**Status:** Design — 2026-07-13
**Context:** The [FLEET_REMEDIATION_PLAN](FLEET_REMEDIATION_PLAN.md) defined a four-rung capability ladder for Primes. Rungs 1–2 (**Observe**, **Operate**) shipped and are live (v2026.07.12.6.0): `fleet-introspect` reads any agent's work from Firestore; `iap.tunnelResourceAccessor` lets a Prime SSH fleet VMs for shell ops. This document designs rungs 3–4 — **Improve** and **Contribute** — the arc that turns a Prime from a fleet operator into a fleet *platform engineer* that makes the whole product better.

North star (owner): *"Primes capable of monitoring the fleet, making them better, and even committing PRs back to the main generic repo so all projects benefit."*

---

## Rung 3 — IMPROVE: from failures to fixes

**Goal:** a Prime periodically (or on demand) reads recent fleet activity, finds systemic failure patterns, and produces concrete, classified improvement candidates — the automated version of the manual fleet review that produced this plan.

### Inputs (all already live)
- `fleet-work-read --agent <a> --status failed|blocked` across the roster → the raw failure corpus (missions, checkpoint/task trees, error text).
- `fleet-status` (health) and `telemetry` (cost/cache) for operational signals.
- The 9 improvement modules (`docs/guides/IMPROVEMENT_MODULES.md`) as the classification target.

### Flow
1. **Gather** — for each fleet agent, pull the last N missions and filter to non-success terminal states. Walk each to its failing task (`--mission`), capturing the error + accept-criteria.
2. **Cluster** — group failures by signature (same tool, same error class, same skill). A cluster of ≥2 across agents/missions is a *systemic* signal, not a one-off. (This is exactly how the manual review found "docs write-side," "work-log-read arg-length," etc.)
3. **Classify** — route each cluster into an improvement module (daemons / souls / gateway / work-layer / skills / dashboard / context — REPO tiers; context-local / operator — LOCAL tiers) via the existing `p-triage-improvement` logic.
4. **Draft** — for each REPO-tier cluster, produce an improvement candidate: problem statement, evidence (mission IDs + error text), proposed change, affected files, canon citations. LOCAL-tier candidates become operator notes.
5. **Emit** — write candidates as a structured report (and, when confident, hand to Rung 4).

### Packaging
A new `roles:["prime"]` skill **`fleet-improve`** (mirror of `fleet-introspect`) that orchestrates gather→cluster→classify→draft over `fleet-work-read` output, plus a scheduled **Responsibility** (`r-fleet-retro`, weekly) that runs it and files candidates. Cadence is a Responsibility, never an always-on loop (B-27, and the owner's note that idleness is fine — improvement is scheduled, not compulsive).

### Canon
- **C-1** — improving the fleet/product is factory work, the highest expression of it.
- **B-28** — every candidate carries its evidence (mission IDs, error text); no "I think X is slow" without a re-derivable signal.
- **B-29** — candidates are binned: `verified` (reproduced), `inferred` (pattern across ≥2), `assumed` (single occurrence, flagged low-confidence).

---

## Rung 4 — CONTRIBUTE: human-gated upstream PRs

**Goal:** when an improvement belongs in the product, the Prime opens a pull request against the generic repo so every fork benefits — as a **proposal a human reviews and merges**, never a self-merge.

### Prerequisite (infra, owner-provisioned)
A GitHub credential with PR scope on the generic repo, injected at runtime (**C-8 — never in the repo**): a fine-grained PAT or a GitHub App installation token in Secret Manager, surfaced to the Prime like other runtime secrets. Least privilege: `contents:write` + `pull_requests:write` on the one repo; **no merge/admin**. Without this, Rung 4 is inert — Rung 3 candidates simply accumulate as reports.

### Flow
1. **Branch** — from the generic repo's default branch, `work-branch fix/<slug>` (via `git-ops`/`workspace-git`), one branch per candidate.
2. **Apply** — make the change *following full repo discipline*: edit + manifest entry in the same commit (**C-9**), `contracts.json` if cross-cutting (**C-7**), version-prefixed commit (**C-23**), and — where the change is testable — a pure test under `tests/`.
3. **Self-verify** — run `node --check` / the test suite / `validate-contracts` in the Prime's workspace before pushing. A candidate that can't pass its own gates never becomes a PR.
4. **Open PR** — push the branch and open a **draft** PR whose body is the Rung-3 candidate (problem, evidence, canon, files) plus the self-verify results. Title carries the version prefix.
5. **Notify + gate** — post the PR link to the operator (dashboard/GChat) as an `approval_gate`. **The Prime never merges.** A human reviews, requests changes, or merges. On merge, the normal fleet upgrade path (dashboard) rolls it out.

### Guardrails (canon)
- **B-28 / risk model** — a PR to the public template is `destructive_or_public`; it is gated on human approval by construction. This is the single most important invariant of Rung 4.
- **C-24** — objects-before-refs: the PR branch is pushed and verified before the PR ref is opened.
- **Two-streams (repo discipline)** — the Prime edits *product* files (`skills/`, `corekit/`, `brain/`, `infra/`, `docs/`); it must never touch a fork's local `.claude/`/`.agents/` dev tooling, and its PRs are template-clean (placeholders, no operator/project-specific values — the same rule this repo holds).
- **Scope ceiling** — one candidate per PR; a candidate that would touch a canon document (`docs/PRODUCT_CANON.md`, `docs/BRAIN_CANON.md`) is escalated as a *proposal for discussion*, never a direct PR — canon changes are the operator's, not the fleet's.

### Packaging
Rung 4 is a Responsibility/process (`p-upstream-improvement`) invoked on a Rung-3 candidate that is `verified` and REPO-tier. It composes existing skills: `git-ops` (branch/commit/push), a thin `github-pr` capability (open/annotate the PR — the one genuinely new piece), and the approval-gate primitive for the human merge gate.

---

## Build order (when scheduled)

1. **`fleet-improve` skill** (Rung 3) — gather→cluster→classify→draft over `fleet-work-read`. Highest standalone value: it produces the review this initiative did, on a cadence, without a human.
2. **`r-fleet-retro` Responsibility** — schedules Rung 3; files candidates as reports.
3. **GitHub credential provisioning** (owner) — the Rung-4 prerequisite.
4. **`github-pr` capability + `p-upstream-improvement`** (Rung 4) — turn `verified` candidates into human-gated draft PRs.

Rungs 1–2 are the foundation and are live. Rung 3 is buildable now (all inputs exist). Rung 4 waits on the GitHub credential decision (scope, PAT vs App) — an owner call, flagged here, not assumed.

## Open owner decisions
1. **GitHub credential**: fine-grained PAT vs GitHub App, and which repo(s) in scope. (Needed before Rung 4.)
2. **Retro cadence**: weekly `r-fleet-retro`, or on-demand only? (Owner noted fleet idleness is expected — a gentle weekly cadence fits that.)
3. **Merge policy**: confirm human-gated-only (this design's default), or allow auto-merge for a narrow low-risk class (not recommended — a public template PR is `destructive_or_public`).
