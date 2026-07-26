# Mission Robustness: Tool I/O Discipline, Binary Ingestion, Verification Evidence

**Status:** Phases 1–4 shipped (`v2026.07.26.1.0` … `v2026.07.26.4.0`). Canary deploy + live verification pending.

## Context

The most complex mission the fleet had run — three deliverables generated from one
template, sourced from three Drive folders plus signed contracts — ended in
`needs_input` after 11m29s, 12 LLM calls, and **1.23M input tokens**.

The judgment layers behaved correctly. There was no defeatism (the anti-foreclosure
SOUL work held: cortex named a real gap and asked rather than declaring the task
impossible), the verifier's empty-verdict retry fired, the acknowledgement landed in
47s, and the question to the operator was specific and honest.

What failed was **plumbing**, and every failure generalises to any mission that
touches a non-text file or gets re-planned:

| Observed | Root cause |
|---|---|
| One organ call at `input=877172` — 72% of the mission | `runCommand` returned up to 1MB of stdout; `readFile` returned whole files uncapped. ~930KB of PDFs sat on disk. Contracts budgeted organ hand-offs but **not tool results**. |
| "cannot extract text from PDF" → blocked | No PDF→text capability existed. `drive-download` fetched bytes; nothing converted them. |
| 300s dispatch abort, then success in 26s on retry | No record of the in-flight tool, so the abort was undiagnosable and the retry started blind. |
| Verify FAILed "Drive folder IDs are identified" one round after finding them | The verifier saw only the *current* checkpoint's outputs while judging criteria a re-plan had carried forward. |
| Every contract downloaded twice under two names | `drive-download` had no existence check (C-18 unapplied). |
| Mission tree seeded with ~20 unrelated files | Step notes were written to the tree root, committed to the project repo, then re-cloned into every later mission. |
| `plan_structuring source=cortex_inline` when prefrontal did the work | Source inferred from `decision.checkpoints`, which is truthy even when extraction rejected it. |

## What shipped

**Phase 1 — tool-result discipline** (`v2026.07.26.1.0`)
A tool result IS context (B-4). New `contracts.tools` block (C-7) drives a shared
`capResult()` applied to every result-returning tool in
[corekit/brain/tools.mjs](../../corekit/brain/tools.mjs) — head+tail window, and
truncation is **always announced**, because a silent cut reads as "I saw
everything" and yields confident wrong answers. `sniffBinary()` makes `readFile`
refuse non-text and name the route that works. Per-call breadcrumbs plus distinct
TIMEOUT/OVERFLOW diagnostics. A timeout-specific retry nudge in
[checkpoint-executor.mjs](../../corekit/lib/checkpoint-executor.mjs) reframes a
timeout as UNKNOWN rather than failed, so the retry re-checks state instead of
duplicating work. 14 new unit tests.

**Phase 2 — binary ingestion** (`v2026.07.26.2.0`)
New `skills/workspace-drive/drive-to-doc` converts a PDF or image into a readable
Google Doc via Drive's documented convert-on-upload path (target mimeType +
`ocrLanguage`); accepts a Drive id or a local path, idempotent by derived name,
single-purpose (returns a `docId`; `docs-cat` reads it). `drive-download` gained
md5-based idempotency and a per-mimetype `readWith` hint. SKILL.md gained a
"Read a PDF or image" procedure — and the file-by-name procedure no longer ends at
`drive-download` for PDFs, which is the instruction that walked agents into the
dead end.

**Phase 3 — verification sees prior evidence** (`v2026.07.26.3.0`)
The milestone verify request now carries `## Previously Established`, built from
earlier checkpoints in this run plus anything banked across a re-plan, bounded by
`dispatch.ctx_verify_prior`. The earlier work banked *checkpoints*; this banks
their **findings**, which is what B-28 re-derivation actually needs.
`skills/verification/SKILL.md` separates the three cases that were conflated:
criterion contradicted (FAIL), established upstream (PASS), evidenced nowhere
(FAIL) — and requires naming the failing criterion, since the planner acts on
those words.

**Phase 4 — context economy, hygiene, telemetry truth** (`v2026.07.26.4.0`)
The plan-structuring dispatch escaped token accounting entirely (under-reporting
`mission_total`); it now shares one accounting wrapper. Stable content moved above
volatile content in that prompt — the capability map sat below the goal and so
could never join a cacheable prefix. `planSource` is assigned in the branch that
produced the plan. Step texts are separated when accumulating turn output (raw
`+=` glued prose onto the next heading, producing transcripts that read as
corrupt — which the verifier then has to judge). Step notes moved to
`missions/<id>/steps/`. Mission trees get a seeded `.gitignore` so downloaded
source material — often third-party personal data — stops entering the permanent
git store. `enforceSchema` logs the schema it enforced instead of
`action=undefined`.

## Verification

**Repo (done)**
- `validate-contracts --repo`: all checks pass. The organ soft-lock check reports
  `ERROR` in a Windows dev shell because its `python3` heredoc hits the Windows
  Store stub; run directly it returns **OK across 56 organ files, no drift**. No
  organ file was touched, so no `ORGAN_LOCK.json` re-pin and no `organ-change`
  trailer.
- Every manifest source path resolves; `test/manifest-integrity` and
  `test/contracts` pass with the new tool and contract keys.
- Suites: **774/777**. The 3 failures are pre-existing and unrelated — stale
  fixtures in `work-recall` (×2) and the delegation marker — tracked separately.

**Live (pending)**
1. `drive-to-doc` on a PDF already on the canary VM → Doc created, `docs-cat`
   returns real text, re-run reports `cached`.
2. Re-run the mission: **no single call over ~100k input** (was 877k),
   `mission_total` well under 1.23M, and any timeout names its in-flight tool.
3. `plan_structuring source=prefrontal` on a re-plan.
4. A re-planned checkpoint no longer fails criteria satisfied in an earlier round
   (`## Previously Established` present in the request).
5. Mission tree: no inherited step notes, no PDFs staged for commit.
6. Then fleet-wide, then one consolidated dev-context update.

## Out of scope (flagged)

- The Gmail API is disabled in the DWD signer project, so the inbound-mail path is
  dead fleet-wide. Separate work.
- Answering the three questions the blocked mission asked, so it can finish.
