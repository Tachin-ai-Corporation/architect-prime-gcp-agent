# Graded Verdict — Success is Judged, Not Gated

**Canon:** [C-38](../PRODUCT_CANON.md) · *Success is judged, not gated.* · [B-37](../BRAIN_CANON.md) · *The verdict is graded, and the verifier owns it.*
**Status:** implemented v2026.09.05.
**Supersedes instinct:** the reflex to fix a false-block by adding another deterministic gate.

## The problem (observed live)

Fleet agent **millie** registered a working `p-weekly-exec-summary` playbook — active in the global
library, with the operator-approved 9-section template and one confirmed source folder. Two other
source folders were named but their Drive IDs resolve at execution time via search. The mission ended
**blocked**, its own success summary written into the blocker field. Nothing was wrong with the work.

Two deterministic layers each mis-judged it, and a capable reader looking at the artifact would have
gotten it right:

1. The **acceptance criteria** were a completeness checklist ("all three folder IDs explicit"), so the
   cerebellum — forced to choose PASS (every clause literally met) or FAIL (something short) — failed a
   functional deliverable.
2. The `blocked_requires_real_blocker` guard tried to *be* the judge by scanning `success:true/false`
   task rows (which churn had polluted with a stray failure), instead of asking the cerebellum whether
   the deliverable met the goal.

The registered, working playbook sat in the store; nothing put it in front of the LLM whose job is to
look and say "done, with a note about the two folders."

## The principle

**Determinism owns the spine and an anti-dishonesty FLOOR. The cerebellum owns the verdict on whether the
intent was met.** (C-38.) Judging "did this achieve what was asked" is a judgment, not a computation;
forcing it into a rigid checklist makes brittle exactly the thing that most needs to adapt. So:

- **Determinism (unchanged):** state transitions, data movement, routing (C-4/C-5), and a floor — a real
  deliverable must exist, a real attempt must have been made, before `complete` may be written (B-28).
- **The cerebellum (widened authority):** a **graded** verdict against the milestone's INTENT, judged from
  the full evidence and the artifact itself — `met` / `met-with-caveat` / `not-met` (B-37).

This is the complement of C-37: the posture widened the intelligence's latitude to *act*; this widens its
authority to *judge*. Same walls, more room to reason inside them.

## Design — graded verdict, expressed structurally

The verdict is the tool name and has never been parsed from prose (`verdict.mjs`). We keep that: the third
grade is a **field on the pass verdict**, not a third control-flow value.

| Grade | Tool call | Downstream flow |
|---|---|---|
| `met` | `report_pass` (no caveat) | complete — byte-identical to before |
| `met-with-caveat` | `report_pass` **+ `caveat`** | complete, and the caveat is surfaced to the operator |
| `not-met` | `report_fail` | fail-closed, re-plan / honest escalation (unchanged) |

Because `met-with-caveat` flows exactly like a PASS, none of the hard-won PASS machinery (adversarial pass,
spine advance, step-ledger, delegated re-derivation) changes. `extractVerdict` still returns `PASS`/`FAIL`;
a new `extractPassCaveat` reads the caveat. A clean pass is unchanged, so the change is safe-by-construction.

## Surface (the edits)

1. **`corekit/brain/tools.mjs`** — `report_pass` gains an optional `caveat` string. Its description and the
   verification skill tell the cerebellum when to use it.
2. **`platform/work/verdict.mjs`** — `extractPassCaveat(output)`: pulls `caveat` from a `report_pass`
   tool-log entry (same `) →` sentinel as `extractReportFailArgs`); `'' ` when clean/absent.
3. **`platform/work/finalization.mjs`** — `renderCaveatSection(caveats)`: pure formatter for the
   operator-facing "Caveats (noted, non-blocking)" block.
4. **`platform/work/checkpoint-executor.mjs`** — on a `PASS`, capture the caveat; push it onto the
   `N.verify` row (`success:true`, `[MILESTONE MET — WITH CAVEAT] …`) and accumulate
   `envelope._milestone_caveats`.
5. **`platform/runtime/actions/synthesize.mjs`** — on the completing PASS, gather accumulated milestone
   caveats + any synthesis-verify caveat and append the caveat section to `envelope.output`.
6. **Cerebellum firmware** (`platform/organ-firmware/{fleet/_brain,prime}/cerebellum/SOUL.md`) — disposition:
   judge INTENT over inventory; a non-defeating gap is a pass WITH a caveat, not a fail. Organ soft-lock
   re-pinned (C-28; `organ-change: intended`).
7. **`skills/verification/SKILL.md`** — the caveat path: when to caveat vs fail, examples, the `caveat`
   field, and the rule that a defeating gap is still `not-met`.

## What we deliberately did NOT do

- **No new deterministic success-gate.** The point of C-38 is to stop that regress. `blocked_requires_real_blocker`
  is left as-is: it already *re-routes to a verified synthesize* (which asks the cerebellum) rather than
  terminating — it is a router to the judge, not the judge. The false block it caught is now prevented
  upstream: the cerebellum can pass-with-caveat, so millie's checkpoint completes and the mission never
  reaches the block path.
- **No contract flag.** The change is additive (a clean pass is unchanged) and the behavioral shift is the
  SOUL/skill disposition, which isn't flag-gatable; the honest rollback for a disposition problem is a
  content revert, not a knob.

## Guardrails that keep the rebalance honest

- The **honesty floor** (`finalize_requires_spine_complete`: the deliverable checkpoint must be met; a
  deliverable must exist) still applies — you cannot report complete with nothing produced.
- The **adversarial pass** still runs over a PASS at consequential+ stakes and can overturn it.
- The disposition is crisp that a **defeating gap** (wrong output, missing core deliverable, unrecoverable
  error, a claim contradicted by evidence, a 404 deploy) is still `not-met` — the existing FAIL table stands.
- Primes carry a **human in the loop** (dashboard-only, C-1).

## Verification ladder

- Unit: `tests/graded-verdict.test.mjs` — `extractPassCaveat` (present / clean / malformed), `extractVerdict`
  still `PASS` when a caveat rides along, `renderCaveatSection`.
- Existing: `tests/cerebellum-verdict.test.mjs`, `tests/finalization.test.mjs`, `test/verification-evidence.test.mjs`
  must stay green (a clean pass is unchanged).
- Live: on a fleet agent, a mission whose deliverable is functional with a non-defeating gap completes with
  a surfaced caveat instead of blocking (the millie class).
