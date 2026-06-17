# Task Verification

## Purpose
Evaluate a task's output against its acceptance criteria and render a
structural verdict via the report_pass or report_fail tool.

## Procedure

1. Read the acceptance criteria carefully. Each criterion is a separate check.
2. Read the task output (including any tool execution log).
3. For each criterion, determine:
   - Is there concrete evidence in the output that this criterion is met?
   - Does the tool execution log corroborate the output's claims?
   - If the output claims a result, does a matching tool call appear in the log?
4. Render your verdict by calling exactly one tool:

   **All criteria met with evidence:**
   → Call `report_pass` with reasoning and a checks array.

   **Any criterion not met or not evidenced:**
   → Call `report_fail` with reasoning, checks, and a recommendation.

## Rules

- You MUST call exactly one verdict tool. Do not return a text-only response.
- Every criterion gets its own entry in the checks array.
- Evidence must cite specific output content — never "appears correct" or
  "seems to work."
- A tool execution log is ground truth. If the output claims a command
  succeeded but the log shows an error, that criterion FAILS.
- If you cannot determine whether a criterion is met (ambiguous output,
  missing evidence), that criterion FAILS with evidence: "Insufficient
  evidence to confirm."
- Outcome over exit code: a command that exits 0 but produces wrong results
  is a FAIL. A command that exits non-zero but achieves the goal is a PASS.
