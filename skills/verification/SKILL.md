# Skill: Task Verification

## When to Use
When dispatched to evaluate a completed task's output against its acceptance criteria and render a structural verdict.

## Commands

### Write
- `report_pass` — Evaluation helper to render a pass verdict when all criteria are met.
- `report_fail` — Evaluation helper to render a fail verdict when one or more criteria are not met.
- `request_probe` — Request independent re-derivation of load-bearing claims. Use when a claim cannot be verified from the provided evidence and the mission’s stakes qualify for probes. The daemon executes each probe in a fresh motor session with no access to the original transcript, then returns you the results for a final verdict. One probe round maximum.

## Procedures

### Evaluate task output and verify correctness
1. Read the acceptance criteria carefully. Each criterion is a separate check.
2. Read the task output (including any tool execution logs).
3. For each criterion, check if there is concrete evidence in the output that the criterion is met.
4. If all criteria are met with evidence, run `report_pass` with reasoning and a checks array.
5. If any criterion is not met or not evidenced, run `report_fail` with reasoning, checks, and a recommendation.
6. Verify: Ensure that exactly one verdict tool is executed and returns a success response.

### Attack Duty (stakes-gated)
When your instruction includes an `## Attack Duty` block (injected for consequential+ stakes):
1. Before any PASS, run three attacks and record each as a check entry:
   - **Domain-expert objection** — the strongest real-world challenge to the output.
   - **Flip test** — invert the softest input assumption; does the conclusion survive?
   - **Boundary probe** — find where the claim stops being true; confirm this case is inside.
2. A winning attack → FAIL with the attack as the recommendation.
3. Real attacks win sometimes. If all three confirm the answer, you may be performing theater.

### Requesting Probes (B-28)
When your instruction includes a `## Probe Eligibility` block:
1. For any **load-bearing** claim that cannot be settled from the provided evidence, use `request_probe`.
2. Each probe specifies the exact claim and a re-derivation method that does NOT share the original’s route.
3. Max probes per round: as stated in the eligibility block (typically 2–3).
4. Never PASS on plausibility to avoid the probe. Never burn probes on trivia while the kill-shot rides through.
5. After the daemon returns probe results, you render one final terminal verdict. No further probes.

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
- If you cannot determine whether a criterion is met (ambiguous output, missing evidence), that criterion FAILS with evidence: "Insufficient evidence to confirm."
- Outcome over exit code: a command that exits 0 but produces wrong results is a FAIL. A command that exits non-zero but achieves the goal is a PASS.
- B-29 Bin honesty: an honestly labeled `assumed` claim is candor, not a failure. An unlabeled guess stated as fact, or a mislabeled bin (`inferred` with no reasoning, `verified` with no check), IS a failure.
- B-28 Re-derivation: "sounds right" is recognition, not verification. Check from evidence. Where evidence cannot settle a load-bearing claim and probes are eligible, use `request_probe`.
