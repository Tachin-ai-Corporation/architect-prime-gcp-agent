# Skill-Doc Coverage + Pinned Checkpoint Spine

**Status: SHIPPED.** All phases implemented and verified. Recorded here (with the other
`docs/plans/`) so the design history is complete — the plan doc had been omitted when the work
originally landed. Verification at the bottom reflects the current tree.

## Context

A mission (`w-1785088147648-98907cc3`) got further than any run before it — `Cerebellum PASS on
CP1`, all three contracts converted and read — then died in CP2 making **six** invented attempts to
duplicate a Google Doc:

```
drive-copy --src X --dst Y --name "…"     ✗ 15ms      docs-create --title … --from-doc X   ✗ 12ms
drive-copy X --name "…" --folder Y        ✗ 13ms      docs-create --title … --folder Y     ✗ 1664ms
drive-copy X Y                            ✗ 10ms      docs-export-docx --doc X --out …     ✗ 838ms
```

Sub-20ms failures are argument parsing. The real signature is
`drive-copy --file FILE_ID [--title …] [--folder …]`; `--file` was never tried. And
`docs-clone-template --template DOC_ID --title "…" [--folder …]` — *exactly* this job — was never
attempted at all.

**Root cause was ours, and systematic.** A sweep of every skill's `skill.json` against its
`SKILL.md` found **15 installed tools that no SKILL.md mentioned**, including both tools that could
have finished the mission. B-17 says "where a skill exists, skill use is enforced" — but an organ
cannot follow a doc that does not describe the tool. She guessed because guessing was the only
option left.

**Second finding, same run.** After CP2 failed, the re-plan discarded the spine and re-ran **CP1 —
which had passed twenty seconds earlier** — burning to 1,110,031 input tokens before blocking.
Across four observed missions the checkpoint **outcomes** never changed (gather inputs → create and
fill → file); only task lists and criteria wording churned. `dispatch.criteria_pinning_enabled`
already existed in contracts and was validated — **nothing read it.**

**Intended outcome:** every installed tool is documented (and cannot silently become undocumented
again), and a checkpoint failure re-plans that checkpoint instead of the whole mission.

## Layer discipline (C-28 / MODULE_CHARTER)

| Change | Layer | Why there |
|---|---|---|
| Tool flags, per-tool procedures, error-recovery rows | **Skill** (`skills/**`) | Charter: skill holds tool commands, flags, per-tool procedure, error recovery |
| Spine pinning + scoped re-plan mechanics | **Brain** (`corekit/**` + contracts) | C-4/B-1: a deterministic daemon enforces it; not a judgment call |
| The *request shape* for a scoped re-plan | **Skill** (`plan-structuring/SKILL.md`) | How prefrontal is asked to structure a plan — procedure, not character |
| Doc-coverage guard | **Enforcement** (`corekit/system/validate-contracts`) | Beside Check 14 (tri-source skill consistency) |

**Deliberately NOT touched:** organ SOUL/IDENTITY (tool syntax in a SOUL is the charter's named
anti-pattern), process definitions, project context, mission intent.

## Phase S — Skill docs (shipped)

- **S1** — `workspace-drive/SKILL.md` documents `drive-copy --file FILE_ID [--title] [--folder]`.
- **S2** — `workspace-docs/SKILL.md` documents the 11 missing tools, led by
  `docs-clone-template`, with a **"Duplicate a template and fill it"** procedure (clone → read
  placeholders → batch-edit → verify with `docs-cat --fingerprint`); `--replacements` fills during
  the clone.
- **S3** — error-recovery rows for invented flags (sub-20ms = argument parsing, re-read the doc;
  template-with-placeholders → `docs-clone-template`, not `drive-copy`).
- **S4** — `session-summary` reclassified to `corekit/memory/`, `task-log-write` to
  `corekit/brain/` (they are not docs tools); skill.json `_scripts_note` keys carry the rationale.
- **S5** — **Check 14b** in `validate-contracts`: every `skill.json` `scripts[]` entry must appear
  in that skill's `SKILL.md` (ignoring `_`-prefixed libraries). Plus **Check 14c** (phantom
  capability): every installed `SKILL.md` must have its tools. Both fail the build.

## Phase B — Pinned checkpoint spine (shipped)

Implemented as a pure lib `corekit/lib/checkpoint-spine.mjs`
(`buildSpine`/`firstIncompleteIndex`/`applyReplan`/`rebuildFromSpine`/`spineSummary`) driven from
`corekit/daemon/actions/checkpoint_plan.mjs`:

- **B1** — first successful structuring pins `envelope._cp_spine` (outcomes + criteria + status,
  no tasks), sibling of `_cp_progress` so it survives re-plans and resumes.
- **B2** — a re-plan with a pinned spine asks prefrontal for the **failed checkpoint's tasks
  only**, then rebuilds `completed(skipped) + re-tasked + remaining`. Completed checkpoints carry
  `status:'complete'`, which stops a passed CP1 from re-running.
- **B3** — `dispatch.criteria_pinning_enabled` sources criteria from the spine (one
  `criteria_revisions` refinement allowed per checkpoint); `dispatch.spine_pinning_enabled` gates
  B1/B2 (separately revertible). Both default-on.
- **B4** — a full mission re-plan is still possible (cortex `replan_scope:'mission'`, or a
  checkpoint exhausting its revision) and emits `[TELEMETRY] spine_replaced …`;
  `full_replan_refused` fires when a passing spine would otherwise be discarded. `plan_structuring`
  telemetry carries `scope=mission|checkpoint` + `spine_reused`.
- **B5** — `plan-structuring/SKILL.md` documents the single-named-checkpoint request shape
  ("Return exactly one checkpoint").

## Verification (current tree)

- `node --test tests/ test/` — **965 pass / 0 fail** (includes `tests/checkpoint-spine.test.mjs`).
- `validate-contracts --repo` — green, including **Check 14b (skill-doc coverage)** and
  **Check 14c (phantom capability)**.
- `checkpoint-spine.mjs` deployed on the fleet (verified on fleet-stan).

**Note (README):** `README.md` cited a `validate-skills.mjs` that does not exist; the skill-doc
coverage guard lives in `validate-contracts` (Check 14b). Fold that stale reference in if touched.
