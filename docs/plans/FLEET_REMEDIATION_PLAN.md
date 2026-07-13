# Fleet Remediation & Prime Platform-Engineer Plan

**Status:** Proposed — 2026-07-12
**Source:** Fleet Operations Review (21 missions across 2 Primes + 5 fleet agents, deployed `v2026.07.12.3.0` / `6c0b050`)
**Owner decisions incorporated:** Prime future-role = fleet platform engineer (introspect → maintain → improve → PR upstream); fleet idleness is expected (no autonomy work); full purge of ghost/legacy artifacts authorized.

---

## 1. What this plan fixes

The review found the cognitive layer sound and the **substrate** broken. Every mission failure traced to tooling, infrastructure, or a just-shipped doctrine with no working path underneath it — never to bad reasoning. Agents failed honestly and precisely (B-7, B-29), which is the behavior we protect while repairing everything under it.

Eight findings, plus infra discovered during planning:

| # | Finding | Sev | Workstream |
|---|---------|-----|-----------|
| F1 | "Primes operate the fleet directly" is unexecutable (Prime→fleet SSH fails) | P0 | WS-1 |
| F2 | Core tools broken: `work-log-read`, docs write-side, git-store empty, `work-publish`, auth stack | P0/P1 | WS-2 |
| F3 | Delegated completions accepted without re-derivation (B-28) | P1 | WS-3 |
| F4 | Prime mission ownership not namespaced; ghost prime `mhive2` | P1 | WS-4 |
| F5 | Classify decision-loss fix written but not deployed | P0 | WS-0 |
| F6 | Half the fleet idle 1–3 weeks | — | **Deferred** (expected per operator) |
| F7 | No existence-check before create → duplicate artifacts (C-18) | P2 | WS-5 |
| F8 | Self-referential delegation (agent tasked about itself) | P2 | WS-5 |

## 2. Guiding principles (canon anchors)

- **C-1 — Prime is a factory, not an orchestrator.** Everything in WS-1 is Prime doing *ops on agents* (monitor, maintain, upgrade, improve) — never inserting Prime as a hop in fleet *work*. This is the line that keeps the expanded Prime role canon-legal.
- **C-4 / C-5 — deterministic first; LLMs think in JSON, daemons move data.** Prime fleet **reads** are structured Firestore/telemetry queries, not shell-scraping. Shell is reserved for ops that genuinely need a host.
- **C-8 — no secrets in repo.** Auth fixes (WS-2E) inject credentials at runtime; keys never land in the template.
- **C-9 — manifest discipline.** Every new skill/tool file ships with its manifest entry in the same commit.
- **C-18 — idempotent everything.** WS-5A.
- **C-24 — git is the artifact substrate; objects before refs.** WS-2C.
- **B-16 / B-17 — skills codify procedure and are enforced where they exist.** New Prime capabilities land as role-scoped skills, not SOUL prose.
- **B-28 — verification is re-derivation, not recognition.** WS-3, and the human-gated merge guard on Prime-authored PRs (WS-1 rung 4).
- **Role scoping (shipped `v2026.07.12.3.0`).** `skill.json roles` + `buildSkillIndex` STATE.json filter. Delegation is `roles:["fleet"]`; the new Prime fleet skills are `roles:["prime"]`. Same mechanism, mirror image.

---

## 3. Marquee design — Prime as Fleet Platform Engineer (F1)

**Owner's north star:** *"Primes capable of monitoring the fleet, making them better, and even committing PRs back to the main generic repo so all projects can benefit."*

That is a capability ladder, built in order. Each rung is gated by the one below it. Rungs 1–2 are in this plan's build scope; rungs 3–4 get their foundation here and a dedicated design pass next.

### Rung 1 — OBSERVE (P0, build now): `fleet-introspect` skill
Read-only, structured, **no host access**. A `roles:["prime"]` skill that lets any Prime read the shared Firestore `work/` collection and telemetry for **any** agent:
- Mission/checkpoint/task envelopes by agent (owner email) — the exact data Candicejr needed and couldn't get.
- Telemetry rollups (`llm_usage`, `mission_total`, `session_*`, `compaction`) from the deployed telemetry.
- Health: daemon liveness via each agent's gateway `/status` and the fleet registry.

This is the immediate unblock. It is deterministic (C-4/C-5), low-blast-radius, and replaces "SSH in just to read a log." The tooling I scp'd during this review (`gather-missions.py`) is the seed.

**Canon note:** reading another agent's mission data is monitoring — squarely factory work (C-1). It does not touch the delegation path (Primes still never delegate).

### Rung 2 — OPERATE (P0/P1, build now): fix Prime→fleet shell access
For test / upgrade / remediation that genuinely needs a shell. **Diagnosis from planning:** the firewall is *not* the blocker — `default-allow-ssh` already allows tcp:22. The failure is **IAM/identity**: Prime runs as the default compute SA and lacks IAP-tunnel + OS-Login rights on the fleet instances.
- Grant the Prime SA `roles/iap.tunnelResourceAccessor` + `roles/compute.osLogin` (or metadata-key propagation) scoped to fleet instances, and `roles/iam.serviceAccountUser` on fleet SAs as needed.
- Codify in `infra/install.sh` / bootstrap so it's reproducible for every fork (C-18).
- **Security hardening (bonus, discovered):** tighten `default-allow-ssh` from `0.0.0.0/0` to the IAP range `35.235.240.0/20`. Least-privilege; flag for owner confirmation since it changes external reachability.
- `fleet-verify` / `fleet-upgrade` already run from Prime — keep them; SSH covers the ad-hoc remainder.

**Canon guardrail (C-1):** shell access is for ops *on* the agent (inspect, test, restart, upgrade), never for Prime to perform the agent's own workspace work.

### Rung 3 — IMPROVE (P1, foundation now / full pass next): fleet-improvement loop
Prime analyzes cross-fleet failure patterns (this very review is the manual prototype), identifies systemic issues, and drafts fixes. Leverages the existing `repo-improvement` / `local-improvement` / `fresh-install-audit` skills. Foundation delivered by Rung 1 (the data) + WS-4A (clean per-prime attribution). Full autonomous loop = its own initiative.

### Rung 4 — CONTRIBUTE (P2, design only here): upstream PRs
Prime authors PRs to the generic repo (`architect-prime-gcp-agent`) via `workspace-git` + a GitHub path, so every fork benefits.
- **Canon guardrail (B-28 + risk model):** a PR to the public template is `destructive_or_public`. Prime PRs are **proposals requiring human review/merge** — never auto-merged. This preserves canon governance and operator-in-the-loop. *(Flagging this as my canon-guided default; say the word if you want a different merge policy.)*

### SOUL update
Prime cortex SOUL's "operate the fleet directly" section is refined: **introspect via the `fleet-introspect` skill (structured reads); use SSH for shell ops (test/upgrade/remediate); propose improvements and upstream PRs under human-gated merge.** No contradiction with the shipped doctrine — a concretization of it.

---

## 4. Workstreams

### WS-0 — Deploy the pending classify fix (F5) · P0 · ~0 build
`v2026.07.12.4.0` (classify decision-loss) is written, tested, committed, **not deployed**. Until it lands, every reply to a Prime's `needs_input` question forks a duplicate mission.
- **Action:** dashboard upgrade all 7 agents to HEAD; verify a `needs_input`→reply resumes (not forks) on candicejr.
- **Gate:** do this first; it's free and stops active thrash.

### WS-1 — Prime Platform-Engineer capability (F1) · P0
As designed in §3.
- **1A `fleet-introspect` skill** — `skills/fleet-introspect/{SKILL.md,skill.json,fleet-work-read,fleet-telemetry-read,fleet-health}`; `skill.json roles:["prime"]`; manifest entry in `role-prime.txt` (C-9). Structured reads only.
- **1B SSH/IAM path** — IAM grants in `infra/install.sh`; optional firewall tighten (owner-gated); diagnostic: `gcloud ... ssh fleet-<x> --tunnel-through-iap` from a Prime VM must succeed.
- **1C SOUL refinement** — `brain/prime/cortex/SOUL.md`.
- **1D scaffolding** — confirm `repo-improvement`/`workspace-git` are prime-installed; design doc for rungs 3–4 (separate initiative).
- **Verify:** drive candicejr through "analyze fleet agent Millie" end-to-end using `fleet-introspect` — the mission that failed 3× must now complete.

### WS-2 — Core tooling repair (F2)
- **2A `work-log-read` — P0.** "Argument list too long": move the inline Python payload off `argv` to `stdin`/heredoc/temp file. Tool is currently 100% unusable (blocked 2 fleet missions). `corekit/brain/work-log-read`.
- **2B Docs write-side — P1.** Add a body/section-replace primitive (delete-from-anchor-to-end / replace-whole-body); make `docs-cat` default to plain text (JSON behind `--json`); SKILL guidance so motor reaches for the v6 `--find`/`--offset` reads it currently ignores. `skills/workspace-docs/`. *(Millie's redline-finalize failure is live on latest — genuinely open, not a deploy gap.)*
- **2C git-store empty — P1.** Investigate first (never seeded? `work-clone` empty-repo path? git-store vs GitHub origin?), then repopulate the `tachin-website` repo objects-before-refs (C-24) or fix `work-clone`; audit every project repo for the same emptiness.
- **2D `work-publish` — P1.** Diagnose the failure that keeps Dot's designs off the live site; fix.
- **2E Auth stack — P1.** Firebase → service-account keys (retire deprecated `FIREBASE_TOKEN`, per Stan's own note); audit DWD/Gmail scopes behind the recurring token-exchange failures. Runtime injection only (C-8).

### WS-3 — Delegated-completion verification (F3) · P1
Enforce cerebellum **re-derivation** on delegated completions against the live artifact, not the delegate's claim (B-28). Confirm `deliverable.mjs` + the cerebellum gate fire on the delegation-result path (Archie accepted Dot's "done" twice for work that never shipped). `corekit/lib/checkpoint-executor.mjs`, delegation result handling in `agent-brain.mjs`.

### WS-4 — Prime identity & legacy cleanup (F4 + ghost purge) · P1
- **4A primeId mandatory — P1.** Stamp `source_meta.primeId` on every envelope write (81% currently null); add a `validate-contracts`/write-path assertion so per-prime attribution and dashboard views hold. `corekit/daemon/agent-brain.mjs`.
- **4B Ghost purge — P1, destructive, owner-authorized.** Full cleanup of ghost/legacy artifacts (`mhive2`, removed `test` agent, orphaned/null-owner test missions like "fire alice"). **Safe procedure:** (1) inventory all target envelopes/registry rows into a manifest; (2) export a backup to GCS/local; (3) present the exact delete list; (4) purge. A one-off `scripts/` cleanup tool, run from a Prime VM. Inventory-before-delete honored even with authorization (irreversible prod mutation).

### WS-5 — Hygiene (F7, F8) · P2
- **5A Existence-check before create (C-18).** Look for the artifact before writing a new one; kills the triplicate-`security.html` pattern. Likely `workspace-drive`/`workspace-docs` create paths + motor guidance.
- **5B Reject self-referential delegation.** Extend the delegation target guard (already validates email shape / registry / space) to flag an agent assigned work *about itself*. `corekit/daemon/actions/delegate.mjs` + `checkpoint-executor.mjs`.

---

## 5. Deferred / no action

- **F6 (fleet idleness)** — Per owner: expected; the builder fleet simply hasn't been engaged and few Responsibilities are configured. No autonomy system, no staleness alerting. (A last-active indicator remains a trivial add if ever wanted.)
- **Firewall `0.0.0.0/0:22`** — flagged in WS-1B as an optional least-privilege hardening; owner-gated because it changes external reachability.

---

## 6. Sequencing & deploy discipline

Standard repo loop per change (C-9, C-23): edit → manifest → `contracts.json` if cross-cutting → tests → `/update-git` (version-prefixed) → dashboard upgrade → prod verify via `prod-fleet-inspect`.

**Phase 1 (P0 — do before assigning the fleet more work):** WS-0 deploy · WS-1A introspect skill · WS-1B SSH/IAM · WS-2A `work-log-read`.
**Phase 2 (P1 — restore quality & accountability):** WS-2B/C/D/E tooling · WS-3 verification · WS-4A primeId · WS-4B ghost purge · WS-1C SOUL.
**Phase 3 (P2 — hygiene + future foundation):** WS-5A/B · WS-1D improve/contribute design pass.

Each phase deploys and is verified in prod before the next begins — new missions must not keep landing on a broken substrate.

## 7. Open canon guardrails (for owner awareness)

1. **Prime-authored upstream PRs are human-gated (never auto-merged).** A PR to the public template is `destructive_or_public` (B-28). My default; flag if you want otherwise.
2. **Prime shell access is ops-only (C-1).** Guardrail that Prime uses SSH to operate *on* agents, not to do their workspace work.
3. **Ghost purge is irreversible** — inventory + backup + explicit delete-list review precede deletion despite standing authorization.
