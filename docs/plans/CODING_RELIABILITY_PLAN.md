# Coding Reliability Plan — make a fleet engineer reliable end-to-end

## Context
The coding skill loop (v2026.08.02.0.1–.0.3) shipped a generic `coding` skill, reshaped the
engineer skill-set (`−git-ops +coding`, git-ops → `skills/git-ops` for Prime), fixed
`work-clone --ref`, and cleaned the tachin-website fixture. It **proved bobby can implement a
design into real code idiomatically** — round 3 landed a correct, token-styled `<details>` FAQ
accordion in the real `index.html` + `styles.css`, committed to `main`.

But reliability is not there. That correct artifact came out of a **messy 5-iteration mission
that ended `cancelled`**: wrong-path detours (`sites/tachin-website/index.html` vs the repo's
root layout), files written to wrong dirs, and a "test locally" step that churned on dev-server
**port conflicts**. Three canary rounds surfaced a stack of causes — and **all of the residual
ones are out of the skill layer**.

**Scope of this plan:** the `coding` skill is accepted as shipped. Every item below is
brain / infra / model / data / verification. Sequenced **lowest-hanging-fruit first, dependency-
aware**, with a **re-measurement gate** before the one large (model-level) investment — because
the cheap fixes may already deliver reliability without it.

## Guiding principles
- **Layer purity (C-28):** each fix lands in its own layer; nothing gets smuggled back into the
  coding skill.
- **Cheap + de-confusing first, model last:** the pollution/path/budget/verify fixes remove the
  *reasons* the motor churned. Re-measure after them; only escalate to a model/flow change if
  reliability is still short.
- **Judge the artifact, prove end-to-end:** the exit bar is a clean `complete`-and-correct
  canary — pull → understand → implement in the real file → test locally (no churn) → commit →
  merge — verified against the committed diff, not the mission's self-report.

## Findings inventory

| ID | Finding (observed) | Layer | Effort | Risk | Blocks reliability? |
|----|--------------------|-------|--------|------|---------------------|
| CR-1 | `git-store` clone reads `--dir` as the branch when `--ref` is absent | brain lib (`corekit/lib/git-store.mjs`) | XS | low | no (sharp edge) |
| CR-2 | Motor per-task budget ~12 tool calls too tight for a full read→edit→verify→commit coding task → task fails → re-plan churn | config (`contracts.brain.max_iterations`) | XS | low-med (fleet-wide) | **yes** |
| CR-3 | `upgrade-corekit` didn't prune a de-manifested specialty skill (git-ops) on upgrade | infra (`install.sh` / `upgrade-corekit`) | M | low | no (deploy hygiene) |
| CR-4 | Mission step-transcripts (`missions/<id>/steps/*`, task-named `.md`) leak into the project repo and get committed by `work-commit --add-all` → repos rot, motor gets confused about the real source | brain (`checkpoint-executor`) + `workspace-git` (`work-commit`) + workspace `.gitignore` | M | low | **yes** |
| CR-5 | Plan/motor targeted a non-existent path (`sites/tachin-website/index.html`); the repo's files are at root | skill (`plan-structuring` + `coding`) | S | low | **yes** |
| CR-6 | "Test locally" churned on dev-server **port conflicts** | skill (`coding`) + thin helper | M | low | **yes** |
| CR-7 | Terminal status doesn't reflect the artifact: `complete`-but-failed (R1), `cancelled`-but-succeeded (R3); cerebellum passed a no-op | brain (`checkpoint-executor` verification + criteria) | M-L | med | **yes** |
| CR-8 | Memory of a prior **failed** mission's "done" claim → bobby *declined to re-implement* (R2) | skill (`memory-recall`) + brain guard | S-M | low | partial (re-runs) |
| CR-9 | Motor (gemini-flash) targets wrong paths / invents filenames / lands the change only after churn — raw code-implementation reliability | config/model (per-task model) or organ/flow | L | med-high | **root** |

## Phased plan (execute top-down; re-measure at the gate)

### Phase A — Quick isolated robustness + the cheap budget lever
Cheap, deterministic, no dependencies. Do these first; each is independently correct.

- **CR-1 · git-store `--dir`/`--ref` parse.** In `git-store.mjs` `clone` CLI, parse `--ref`/`--dir`
  by flag (not positional fallback that reads `args[1]` as the branch). Closes the sharp edge for
  *all* callers (the `work-clone` wrapper was already hardened to always pass `--ref`).
  *Verify:* `node git-store.mjs clone <repo> --dir X` (no `--ref`) clones on `main`; unit or live smoke.
- **CR-2 · Motor step budget.** Add `contracts.brain.max_iterations` (currently absent → falls back
  to 12 in `corekit/brain/config.mjs`); set to ~**25**. A real coding task (read 2 files → edit 2 →
  serve → curl → fix → re-verify via `work-diff` → commit) exceeds 12 and fails mid-way, forcing the
  observed re-plan churn. Register the key in `validate-contracts` (bool/int list) and note the
  fleet-wide effect (all execution agents; only tasks that need >12 cost more).
  *Verify:* `validate-contracts --repo` green; gateway `step X/25` in logs; canary churn drops.
- **CR-3 · upgrade-corekit prune gap.** Diagnose why the STATE.json-keyed reconcile left `git-ops`
  installed after it was de-manifested for the engineer; fix so a de-manifested specialty skill is
  pruned on `upgrade-corekit --apply` (I had to hand-remove it). *Verify:* remove a skill from a job
  manifest, deploy, confirm it's gone from the VM without manual `rm`.

### Phase B — Remove the motor's confusion (clean context)
The biggest reliability enablers that are still bounded, in-repo work. Do before re-measuring the
motor.

- **CR-4 · Stop step-transcript pollution.** Mission step-notes must never reach the project git
  tree. Options (pick the cleanest): (a) `checkpoint-executor` writes step transcripts outside the
  mission's git working dir; and/or (b) `work-commit --add-all` excludes mission-internal paths
  (`missions/`, `MISSION.md`, step slugs) — or a workspace `.gitignore` the daemon seeds does.
  MR-4b intended the steps-subdir + gitignore; it isn't holding (round 3 re-polluted). Root-cause and
  close it. *Verify:* run a mission; the merged diff contains **only** the real source change.
- **CR-5 · Path discovery, not path assumptions.** `plan-structuring`: reinforce that tasks name an
  **outcome**, never a file path — the doer discovers the file in the auto-cloned workspace (don't
  emit `sites/<x>/index.html`). `coding`: "the daemon auto-clones the project repo into your
  workspace; list it and confirm where the file actually is (usually the workspace root), then edit
  THERE — never an assumed monorepo path." *Verify:* canary plan/tasks carry no hardcoded repo path;
  motor edits the workspace-root file first try.

### Phase C — Make local verification and terminal status honest
- **CR-6 · Robust local-serve verify.** A reusable "serve-and-check" pattern so "test locally" can't
  churn: bind a **free/ephemeral port** (or `:0`), serve, `curl` the page, assert the change is
  present, tear down; for a pure static site, offer a no-server parse/validate path. Encode it in the
  `coding` skill's "Verify locally" procedure; add a thin helper tool only if the procedure proves
  fragile. *Verify:* the verify step succeeds with no port-conflict retries across repeated runs.
- **CR-7 · Verification/status reflects the artifact (code missions).** A code checkpoint's milestone
  must be judged against the **committed diff to the named file** (re-derive from git: the target
  file changed as intended), not the motor's prose. Align the terminal status with it — extend
  today's finalization work (`blocked_requires_real_blocker` family): a mission whose committed diff
  lacks the change must not read `complete`; one whose diff *has* it must not die `cancelled`.
  *Verify:* the R1 (no-op) shape fails the milestone; the R3 (real change) shape completes clean.

### Phase D — Memory honesty
- **CR-8 · A recalled "done" is an assumed claim (B-28).** `memory-recall`: a recalled completion of
  prior work must be **re-derived against ground truth** (does the artifact/commit actually exist and
  contain the change?) before it justifies skipping work — never decline to implement on memory
  alone. Add a brain guard if the skill nudge is insufficient. *Verify:* re-inject an identical task;
  bobby verifies the artifact and either confirms-and-stops (if truly present) or re-implements (if
  not) — never a blind skip.

### GATE — Re-measure
Re-run the bobby coding canary (clean repo, project-scoped, a *fresh* section task). If it reaches a
clean `complete`-and-correct end-to-end, **stop — reliability achieved by A–D.** Only if it still
churns/wrong-files, proceed to Phase E.

### Phase E — Foundational (gated): raise raw code-implementation reliability
- **CR-9 · Motor coding capability.** If A–D didn't land it, escalate the motor for coding work:
  (a) a **per-task model override** (a stronger code model than gemini-flash for `coding` tasks —
  contracts `vertex.models` already supports per-role models; extend to per-task-kind), and/or (b) a
  **constrained implement loop** (read-file → targeted edit → `work-diff` gate → repeat) that
  structurally prevents wrong-file/no-op outcomes. This is the architectural lift; the earlier phases
  exist precisely so it may not be needed. *Verify:* multiple back-to-back canaries pass clean —
  *reliably*, not once.

### Close-out
- Fleet-relevant rollout of any brain/config fixes (CR-1/2/3/4/7 are generic — they help every
  agent, not just bobby); re-verify per VM.
- Final proof: 2–3 consecutive clean coding canaries.
- Update `.agents/rules/project-context.md` + memory.

## Layer / canon notes
- CR-1/7 → `corekit/` (brain). CR-2 → `contracts.json` (C-7). CR-3 → `infra/` (install). CR-4 →
  `corekit/` + `workspace-git` skill. CR-5 → `plan-structuring` + `coding` skills. CR-6 → `coding`
  skill (+ optional helper). CR-8 → `memory-recall` skill (+ brain guard). CR-9 → config/model or
  organ (may need an ORGAN_LOCK ceremony if an organ SOUL changes).
- No item requires touching the `coding` skill's *content* beyond CR-5/CR-6 procedure text; the skill
  is otherwise accepted as shipped.
- Every brain/config change stays flag- or version-revertible; commits version-prefixed and
  layer-separated (C-9/C-23).
