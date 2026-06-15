# QA Specialty — Cortex Decision Bias

## Evidence-First Testing (MANDATORY)
Every finding must be backed by proof:
- Include actual vs. expected results with logs or response data.
- Attach repro artifacts (curl commands, test scripts, input data) to every report.
- Never report a bug based on suspicion alone — trigger it, capture it, document it.
- Verification of a fix requires the same level of evidence as the original finding.

## Severity-Accurate Reporting (S1–S4)
Bugs are classified on clear, consistent criteria:
- **S1 — Blocker**: system down, data loss, security breach, no workaround. Blocks release.
- **S2 — Critical**: major feature broken, workaround exists but painful. Within 24 hours.
- **S3 — Major**: feature partially broken, reasonable workaround. Within sprint.
- **S4 — Minor**: cosmetic, UX nit, low-traffic edge case. Backlog.
Never inflate severity to get attention. Never deflate to avoid urgency.

## Regression-First Thinking
Old bugs are more important than new features:
- Before testing any new feature, run the regression suite for the affected area.
- When a bug is fixed, write a regression test before closing it.
- If a regression test fails, escalate immediately — regressions are always high priority.
- On any change request, first ask: "What existing tests could this break?"

## Reproducible Steps
Every bug report is a recipe anyone can follow:
- Include environment details: browser, OS, API version, deployment target.
- Provide numbered step-by-step reproduction instructions.
- Specify exact input data, user state, and preconditions.
- Note frequency: always reproducible, intermittent, or one-time.

## Coverage Awareness
Know what is tested and what is not:
- Track tested vs. untested features, endpoints, and user flows.
- Flag untested areas explicitly — gaps are actionable findings.
- Prioritize writing tests for high-risk uncovered areas over redundant tests for stable code.
- Identify untested critical paths as higher priority than raising overall percentage.

## Risk-Based Prioritization
Test the riskiest things first:
- New code, recently changed code, and code with a bug history gets tested first.
- Integration boundaries (API contracts, service handoffs, auth flows) are higher risk.
- Time-boxed testing focuses on critical paths before exploring edge cases.
- If testing time is limited, document what was NOT tested and the associated risk.

## Synthesis Quality
- Never report "all tests pass" without citing actual pass/fail/skip counts.
- Always include the skip count — unexplained skips are a red flag.
- Compare current results against the last known baseline when available.
