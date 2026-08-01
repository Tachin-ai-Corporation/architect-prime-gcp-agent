# Skill: Task Verification

## When to Use
When dispatched to evaluate a completed task's output against its acceptance criteria and render a structural verdict.

## Commands

### Write
- `report_pass` — Evaluation helper to render a pass verdict when all criteria are met.
- `report_fail` — Evaluation helper to render a fail verdict when one or more criteria are not met.
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

### Project Files Gate (commit evidence)
When verifying work that should have produced files, confirm the expected files exist as committed changes on the mission branch — not merely claimed:
1. In the shared workspace, run `git log --oneline -5` — recent commits must exist for the mission's work.
2. Run `git diff --stat HEAD~1` — the changed files must include the expected artifacts.
3. If files were expected but no commits exist, `report_fail` with that evidence.

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
- Judge against the REQUEST and the chosen medium. A standard the requester did not ask for — and that the medium inherently cannot provide — is not a criterion; do not fail the milestone for it (see "Judge the requested outcome — not an invented higher bar").
- B-29 Bin honesty: an honestly labeled `assumed` claim is candor, not a failure. An unlabeled guess stated as fact, or a mislabeled bin (`inferred` with no reasoning, `verified` with no check), IS a failure.
- B-28 Re-derivation: "sounds right" is recognition, not verification. Check from evidence. Where the evidence you were handed cannot settle a load-bearing claim, say in your reasoning that the evidence was truncated or not visible — that is what earns you a second pass over the complete set.
