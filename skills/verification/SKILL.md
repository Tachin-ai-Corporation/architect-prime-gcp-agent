# Skill: Task Verification

## When to Use
When dispatched to evaluate a completed task's output against its acceptance criteria and render a structural verdict.

## Commands

### Write
- `report_pass` — Render a pass verdict when the milestone's INTENT is met. Optional `caveat`: pass WITH a surfaced, operator-facing note when a criterion is partially met or deferred but does NOT defeat the deliverable (see *The graded verdict* below).
- `report_fail` — Render a fail verdict when the milestone's intent is genuinely unmet (wrong output, a missing core deliverable, an unrecoverable error, a claim the evidence contradicts).
- `request_probe` — **DISABLED, do not call.** No daemon path services a returned probe, so calling it yields no terminal verdict and the milestone fails closed for asking. When the evidence you were given is not enough, say so in `report_fail` reasoning instead — the daemon re-verifies you on the complete evidence automatically. See "When the evidence is not enough" below.

## Procedures

### Evaluate task output and verify correctness
1. Read the acceptance criteria carefully. Each criterion is a separate check.
2. Read the task output (including any tool execution logs).
3. **Read the `## Previously Established` block first, if present.** Evidence there is already verified and counts in full.
4. For each criterion, check for concrete evidence — in the current output **or** in Previously Established.
5. If all criteria are met with evidence, run `report_pass` with reasoning and a checks array.
6. If any criterion is not met or not evidenced, run `report_fail` with reasoning, checks, and a recommendation.
7. Verify: Ensure that exactly one verdict tool is executed and returns a success response.

### Judging a checkpoint that follows earlier work
A plan can be revised mid-mission. When it is, the acceptance criteria carry
forward but the *tasks* may not repeat work that already succeeded — so the
current checkpoint's outputs are an incomplete picture by design.

Distinguish two very different findings, and never conflate them:

| Finding | Verdict | Evidence to cite |
|---|---|---|
| **Criterion not met** — the work was attempted and the result is wrong, missing, or contradicted | FAIL | The specific output that contradicts it |
| **Not evidenced here, but established earlier** — the current tasks didn't redo it | PASS for that criterion | Quote the `## Previously Established` row |
| **The ARTIFACT lacks it** — the work ran and genuinely did not produce this | FAIL | Name what is absent from the artifact |
| **THIS TRANSCRIPT lacks it** — the work may be fine; the evidence you were handed is clipped | FAIL, worded as below | Say the evidence was truncated or not visible |

**The last two are not the same finding, and the wording you choose decides what happens
next.** A criterion you cannot settle does not PASS either way — B-28 holds. But if the
reason you cannot settle it is that the evidence in front of you was cut short, say exactly
that, in those words: *"the content for X is not fully visible in the provided transcript"*,
*"the combined outputs were truncated"*. The daemon watches for that language, hands you the
COMPLETE evidence, and asks once more. Bury it in a generic "criterion 2 not met" and you
throw that second look away.

Getting this backwards is expensive and it has already happened: a checkpoint that had
correctly edited three documents was given a slice of evidence too small to hold all three,
passed the first document, failed the second for not being visible, and the mission was
reported to its requester as blocked with three finished documents inside it.

So: **never describe an evidence shortfall as though the work were wrong.** If you truly
cannot tell whether the work is right, that is a statement about your evidence, and the
honest verdict says so.

Before failing any criterion, ask: *is this actually absent, or did I simply not
look upstream?* Failing an already-satisfied criterion forces a needless re-plan
and can send the mission in a circle — the most expensive verifier error there is.

Name the failing criterion explicitly in `reasoning`. "Acceptance criteria not
met" tells the planner nothing; "criterion 3 (personal details extracted) failed:
the source is a PDF and no conversion was attempted" tells it exactly what to fix.

### Judge the requested outcome — not an invented higher bar
A criterion is met when the deliverable satisfies **what was asked, in the medium that was
asked for**. Do NOT fail a milestone for a standard the requester never stated and the chosen
medium inherently cannot provide — that is not a defect in the work, it is a bar you added.

Read the criterion and the request literally, then judge the artifact against *that*:
- A deliverable authored "as HTML/CSS, rendered to a PDF" is met by a correct, clean PDF from
  that source. It is NOT failed for lacking things that belong to a different medium the
  requester never asked for — e.g. commercial-prepress CMYK profiles, crop marks, physical
  bleed. A real design checkpoint was failed three times this exact way, and because
  verification gated the render step, its PDF was never produced.
- "Summarize" is met by a faithful summary — do not demand the rigor of a formal report.
- A "draft" or "quick" deliverable is met at draft quality — do not hold it to production polish.

If the criterion's own wording is more demanding than the request (a planner over-specified it),
judge against the **request** and say so in your reasoning. The gap between "what was asked" and
"the highest standard imaginable" is not the motor's failure to close — and a milestone failed
for it re-plans forever against a bar the work can never clear.

### The graded verdict — met, met-with-caveat, not-met (C-38 / B-37)
Your verdict is not a two-way switch. Judge the milestone's **intent** against the artifact and all
available context, and choose the grade that is true:

| Grade | When | How |
|---|---|---|
| **Met** | The intent is achieved with concrete evidence, cleanly | `report_pass` — leave `caveat` empty |
| **Met with a caveat** | The intent is achieved, but a criterion is partially met or deferred in a way that does NOT defeat the deliverable | `report_pass` — name the gap in `caveat` |
| **Not met** | The intent is genuinely unmet | `report_fail` with a recommendation |

A **non-defeating** gap is one the deliverable works despite: a folder/id/value that resolves at
runtime, an optional enrichment left undone, a cosmetic imperfection, a nice-to-have the request never
turned on. Pass, and put the gap in `caveat` — one plain sentence — so the operator sees it. This is
exactly the call that was getting mis-made: a registered, active playbook with its template and one
confirmed source folder was FAILED for not capturing two more folder IDs that resolve at runtime, and
the mission was reported blocked with a working deliverable inside it. That is met-with-caveat, not a
failure.

A **defeating** gap stops the deliverable being what was asked: wrong output, a missing core piece, an
unrecoverable error, a claim the evidence contradicts, a 404 deploy. That is `report_fail`. Never dress
a defeating gap as a caveat — the caveat is candor about a *working* deliverable, not a way to wave a
broken one through. When unsure whether a gap defeats the deliverable, ask: would a reasonable operator
call this *done, with a note*, or *not done*? Judge as they would.

### Project Files Gate (commit evidence — judge the diff, not the claim)
When verifying work that should have changed code or files, judge the **committed diff**, not
the motor's prose. "I added X to the file" is a claim; the evidence is X actually appearing in
the diff to that file. The motor's report is not the artifact.
1. In the shared workspace, run `git log --oneline -5` — the mission's commit(s) must exist.
2. Run `git diff --stat <base>..HEAD` — the changed files must include the ones the task named.
3. **The claimed change must be IN the diff.** For a specific edit (a tag added, a line changed,
   a file created), confirm it appears in `git diff` / the committed file — e.g. the `noindex`
   meta the motor said it added is present in the diff for each named page, the FAQ markup is in
   the committed `index.html`. A motor that "reported success each time" while the files stayed
   unmodified has NOT done the work.
4. **A no-op is a FAIL, not a pass.** An empty diff, or a diff that changed a *different* /
   invented file (a new `home.html`) instead of the file the task named (`index.html`), means
   the change is absent from the artifact — `report_fail`, naming the file that never changed.
   A claim with no matching diff is the write never landing, not success.
5. **A surgical change must be surgical — judge collateral damage, not just the intended line.**
   The intended edit being present is necessary, not sufficient. If a one-line intent shows up as
   a whole-file rewrite, the diff introduced stray `\'`/`\"` (escaped-quote corruption), or a web
   page's later sections / inline `<script>` were altered, that is a FAIL even though the asked-for
   text is technically in the diff. For a content/web change "still renders whole" is implied — a
   heading edit that blanks everything below the hero did NOT meet it. Check: `git diff --stat`
   proportionate to the intent, and `grep "\\'" FILE` empty.

### Deploy/Publish Gate (reachable artifact — verify the URL, not the claim)
When the criterion is a **deploy or publish** — the deliverable is now reachable at a URL (a
staging/preview channel, a live site, a published page) — judge the **reachable artifact**, not
the motor's "✅ deployed" prose. A deploy that printed a URL but was never fetched, or was
fetched and did not return content, is NOT a completed deploy. This is the live false-complete
this gate exists for: a deploy reported success while the URL served **HTTP 404 / 0 bytes**, and
no URL ever reached the requester.
1. **A URL must be present and named.** The output must carry the exact deployed URL.
   "Deployed successfully" with no URL is not evidenced — `report_fail`, recommending the URL be
   reported.
2. **The URL must be shown reachable in the evidence.** The tool log must contain a fetch of
   that URL — a `curl` (or equivalent) showing **HTTP 200 and a non-empty body**. A `firebase
   deploy` / CLI success line is the tool's own claim, not proof the artifact serves; the
   reachability check is the proof (B-28 re-derivation). If the deploy printed a URL but the
   evidence shows no fetch of it, that is not-yet-verified — `report_fail` naming the missing
   reachability check, do not PASS on the CLI's say-so.
3. **A 404 / 000 / 5xx / empty body is a FAIL**, even when the deploy command exited 0 — outcome
   over exit code. Name the URL and the status you see.
4. **Judge the RIGHT target.** If the request named a specific site/channel (e.g. the staging
   channel of a named site), the fetched URL must be that target — a 200 from the *default* site
   is not the deploy that was asked for.
Match the depth to the request: a whole-site deploy implies `/` **and** a representative page
and image reachable (the deploy skill fetches these); a single-page publish implies that page.

### Attack Duty (stakes-gated)
When your instruction includes an `## Attack Duty` block (injected for consequential+ stakes):
1. Before any PASS, run three attacks and record each as a check entry:
   - **Domain-expert objection** — the strongest real-world challenge to the output.
   - **Flip test** — invert the softest input assumption; does the conclusion survive?
   - **Boundary probe** — find where the claim stops being true; confirm this case is inside.
2. A winning attack → FAIL with the attack as the recommendation.
3. Real attacks win sometimes. If all three confirm the answer, you may be performing theater.

### When the evidence is not enough (probes are currently DISABLED)
`request_probe` is **not available**. It was advertised here for a long time while nothing on
the daemon side ever serviced a returned probe, so a verifier that followed this instruction
produced no terminal verdict and the fail-closed then failed the milestone for asking. Do not
call it; it will not come back with anything.

What replaced it, and it is automatic: when your `report_fail` reasoning says the evidence was
**truncated or not visible**, the daemon re-runs the verification once with the complete,
untruncated evidence set. You get exactly the second look a probe was for, without a tool call
— but only if your wording makes the reason legible. See "Distinguish two very different
findings" above.

Never PASS on plausibility to dodge the problem. An unverifiable load-bearing claim is not a
pass; it is a not-yet-verified claim, and saying so plainly is the whole job.

## Evaluating Research and Recall Tasks

Tasks assigned to `temporal-research` or `temporal-memory` produce **informational output**, not file writes or mutations. Evaluate them by these criteria:

- **Did the agent attempt the research/recall?** (tool calls present in the log)
- **Is the output relevant to the task instruction?** (addresses the question asked)
- **Is "no results found" a valid outcome?** YES — for novel projects, empty memory and no search results are expected and valid. Do not fail a task because the information doesn't exist.

These agents CANNOT write files, create artifacts, or modify state. Do not fail them for lacking file outputs. Their product is text.

### Common false-positive patterns to avoid
| Motor output | Correct verdict | Why |
|-------------|----------------|-----|
| "No relevant memory found" | PASS (if recall was attempted) | Novel project — memory is empty |
| "Search returned 3 results: ..." | PASS (if results address the query) | Research succeeded |
| "Could not find specific document" | PASS (if search was thorough) | Absence is a finding |
| Research text with no file saves | PASS | Research agents don't save files |
| Honestly labeled `assumed` claim | PASS | Candor is not a failure (B-29) |
| Criterion satisfied in `## Previously Established`, absent from this checkpoint | PASS for that criterion | A revised plan doesn't redo finished work |
| A capability gap honestly reported ("the source is a PDF; no converter was used") | FAIL, with the route as the recommendation | The gap is real and nameable — say what to do, don't declare it impossible |
| Deliverable meets the request but lacks an **unrequested** higher standard (an HTML→PDF flyer isn't commercial-prepress CMYK; a summary isn't a formal report) | PASS | Judge against what was asked and the medium chosen — a bar you added is not a defect in the work |
| A working deliverable meets the intent but a listed criterion is partially met / deferred **without defeating it** (a folder id that resolves at runtime, an optional enrichment left undone) | PASS with a `caveat` | Met-with-caveat (C-38) — surface the gap honestly; a functional deliverable is not failed for a non-defeating detail |
| "Added noindex to all 6 pages" / "edited index.html" but `git diff` shows those files unchanged | FAIL | The write never landed — a claim is not a diff; name the file(s) that did not change |
| The diff created a new/parallel file (`home.html`) instead of changing the named one (`index.html`) | FAIL | The real file is untouched; the change is not in the artifact the site serves |
| The asked-for text IS in the diff, but the same commit mangled quotes across the file / rewrote unrelated lines / blanked the page below the fold | FAIL | A change that corrupts the file is not a completed change — surgical intent, non-surgical result |
| "Deployed ✅ to `<url>`" but the log shows no fetch of that URL, or a 404 / 5xx / empty body | FAIL | A deploy is proven by the artifact serving (HTTP 200 + content), not the CLI success line — a bare claim or a 404 is a false-complete |
| A deploy 200s on the **default** site when a specific site/channel was named | FAIL | Right outcome, wrong target — the deploy the requester asked for did not land |
| Smooth, fluent motor output | Verify harder | Fluency-as-accuracy — the passage that came out easiest gets audited hardest (B-31) |

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| Log lacks evidence of tool execution | Task output claims success but the command log is empty | Run `report_fail` with a recommendation to include the required tool logs in the task output. |
| Conflicting results | A command returned an error but the text output claims success | Mark that specific criterion as failed and run `report_fail` detailing the mismatch. |
| Ambiguous criteria | The acceptance criteria are too vague to evaluate objectively | Evaluate against a reasonable interpretation, and if completely blocked, run `report_fail` citing insufficient evidence. |

## Rules
- You MUST call exactly one verdict tool. Do not return a text-only response.
- Every criterion gets its own entry in the checks array.
- Evidence must cite specific output content — never "appears correct" or "seems to work."
- A tool execution log is ground truth. If the output claims a command succeeded but the log shows an error, that criterion FAILS.
- If you cannot determine whether a criterion is met, it does not PASS — but SAY WHICH KIND of not-knowing it is. Ambiguous or contradicted output is a finding about the work. Evidence that was clipped before you could read it is a finding about your evidence, and must be worded as such ("not fully visible in the provided transcript", "the outputs were truncated") so the daemon re-runs you on the complete set. Check `## Previously Established` before concluding anything is missing.
- Name the failing criterion in `reasoning`, not just that the milestone failed — the planner acts on your words.
- Outcome over exit code: a command that exits 0 but produces wrong results is a FAIL. A command that exits non-zero but achieves the goal is a PASS.
- Code/file changes are judged by the committed DIFF, not the claim. A change the motor says it made must be present in `git diff` to the named file; a claim with no matching diff is a FAIL (the write never happened), and a no-op or wrong-file diff is a FAIL (see "Project Files Gate").
- Judge against the REQUEST and the chosen medium. A standard the requester did not ask for — and that the medium inherently cannot provide — is not a criterion; do not fail the milestone for it (see "Judge the requested outcome — not an invented higher bar").
- Graded verdict (C-38/B-37): your verdict is met / met-with-caveat / not-met. A milestone whose intent is achieved with a NON-defeating gap is `report_pass` carrying a `caveat` that names the gap — not a `report_fail`. Reserve `report_fail` for an intent genuinely unmet, and never dress a defeating gap as a caveat (see "The graded verdict — met, met-with-caveat, not-met").
- B-29 Bin honesty: an honestly labeled `assumed` claim is candor, not a failure. An unlabeled guess stated as fact, or a mislabeled bin (`inferred` with no reasoning, `verified` with no check), IS a failure.
- B-28 Re-derivation: "sounds right" is recognition, not verification. Check from evidence. Where the evidence you were handed cannot settle a load-bearing claim, say in your reasoning that the evidence was truncated or not visible — that is what earns you a second pass over the complete set.
