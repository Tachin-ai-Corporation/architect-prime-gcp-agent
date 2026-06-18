# Skill: Codebase Audit

## When to Use
When auditing a codebase — including analyzing code structure, checking standards compliance, reviewing architecture, and identifying quality improvements.

## Commands

No custom corekit scripts are governed directly by this skill.

## Procedures

### Perform a codebase audit cycle
1. **Read Standards:** Locate and read the project's architecture standards and invariant documents from the project context.
2. **Gather Context:** Query recent task logs or Core Memory entries to review prior audit history.
3. **Discover Module Structure:** Run a directory search or structure check to locate key files and identify major subsystems.
4. **Inspect Focus Area:** Select a subsystem to audit. Inspect key files, checking for code smells, invariants compliance, complexity, and duplicate patterns.
5. **Cross-Reference:** Check cross-cutting concerns such as configuration locations, manifests, test coverage, and documentation files.
6. **Rank Findings:** Score findings against the quality rubric and select the single highest-value finding for the improvement proposal.
7. Verify: Check that the final report cites specific files and line numbers, and has a clear z-score or improvement measure.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| Missing architecture standards file | Context path is incorrect or file is deleted | Run a repository search for "invariant" or "standard" files, or default to standard core codebase guidelines if none exist. |
| Search queries match huge generated/compiled files | Glob patterns are too broad | Filter your searches by explicitly excluding build/distribution directories (e.g., `!**/dist/*`, `!**/node_modules/*`). |
| Ambiguous context or focus area | No clear record of previous audit rotation | Check the last 10 task logs using `task-log-read` to identify which modules were recently edited or audited. |

---

## Rubric Format
For each finding, score against the project's quality rubric:

```
Finding: <description>
Dimension: <which quality dimension improves>
Measure: <quantitative or structural improvement>
Protected Properties: <confirm all untouched>
Risk: <low | medium | high>
Scope: <file globs>
```

## Safety Rules
- **READ-ONLY**: This skill is strictly observational. Do not modify any files.
- **Single improvement per cycle**: Propose exactly one improvement, the highest-value one.
- **Evidence-based**: Every finding must cite specific files and line numbers.
- **Standards-compliant**: Every proposal must pass the project's standards filters before being submitted.
