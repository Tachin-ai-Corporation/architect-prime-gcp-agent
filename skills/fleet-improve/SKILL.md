# Skill: Fleet Improve

## Availability (built into this skill)

> [!IMPORTANT]
> **Prime-only.** Scoped to Prime agents (`skill.json` `roles: ["prime"]`). This is Prime's IMPROVE capability — the automated version of a fleet retro: find systemic failure patterns across the fleet and turn them into concrete platform improvements.

## When to Use
On a schedule (the `Fleet Retro` responsibility) or on demand, to answer "what keeps going wrong across the fleet, and what should we fix in the product?" Pairs with `fleet-introspect` (single-agent read) — this skill is the fleet-wide, cross-mission pattern pass.

## The loop: gather → cluster → classify → draft → land

### 1. Gather + cluster (deterministic)
Run `fleet-retro` (no LLM — pure Firestore read + clustering):
```bash
fleet-retro --last 15 --min-cluster 2
```
It scans every fleet agent's recent non-success missions, walks each to its failing task, and clusters failures by normalized error signature. Output JSON:
- `clusters[]` — SYSTEMIC failures (≥ `min-cluster` missions share a signature): `{signature, count, agents, specialties, sample_error, missions[]}`. These are the improvement candidates.
- `singletons[]` — one-off failures (context, not yet systemic).

A cluster spanning multiple agents/specialties is a **platform** problem (a tool, a daemon, a skill) — exactly the kind this initiative's manual review found (`work-log-read` arg-length, docs write-side, etc.).

### 2. Classify each cluster into an improvement module
Read the `architect-prime` project context for the 9-module definitions. Map each cluster to the owning module: governance→daemons, instruction quality→souls, tool/skill defects→skills, gateway/caching→gateway, work-envelope→work-layer, dashboard→dashboard, project/agent context→context. Tier each: **REPO** (generic, benefits every fork) or **LOCAL** (this deployment only).

### 3. Draft a candidate (B-28/B-29)
For each systemic cluster, write a candidate carrying its evidence:
- **Problem** — one sentence, the failure signature.
- **Evidence** — the `missions[]` ids + `sample_error` (re-derivable, not asserted).
- **Proposed change** — specific files/behavior.
- **Module + tier**, and an epistemic bin: `verified` (reproduced it yourself with `fleet-work-read --mission`), `inferred` (pattern across ≥2), `assumed` (weak signal).

Confirm before proposing: pull one of the cluster's missions with `fleet-work-read --mission <id>` and re-derive the failure. A candidate you could not reproduce is `assumed` and should not become a PR.

### 4. Land
- **REPO + verified** → hand to the upstream-PR path: `follow_process p-upstream-improvement` (Rung 4) — it clones the generic repo, applies the change under full repo discipline, self-verifies, and opens a **human-gated draft PR**. You never merge.
- **LOCAL** → the `local-improvement` skill (Firestore/overlay, no PR).
- **Not yet systemic / assumed** → record as a note; wait for it to recur.

## Cadence
The `Fleet Retro` responsibility runs this weekly and files candidates. Improvement is scheduled, not compulsive (B-27) — an idle fleet is fine; a retro with zero systemic clusters is a valid, healthy outcome. Report that plainly rather than inventing work.

## Related skills
- **fleet-introspect** (`fleet-work-read`) — single-agent read + `--mission` drill (use to reproduce a cluster).
- **repo-improvement** / **local-improvement** — the REPO/LOCAL landing procedures.
- **p-upstream-improvement** — the process that turns a verified REPO candidate into a human-gated PR.

## Safety
- Read-only until the landing step. `fleet-retro` mutates nothing.
- REPO changes are template-clean (contamination scan) and land ONLY as human-reviewed PRs — never self-merged (a PR to the public template is destructive_or_public, B-28).
