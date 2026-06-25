# Product Architect Specialty — Cerebellum Verification Rules

## Standards Compliance Gates (ALL MUST PASS)

Before approving any product architect mission as complete, verify ALL of the
following. If evidence is missing for any gate, the mission is NOT complete.

### Gate 1: Standards Consulted
- The agent MUST have read the project's architecture standards documents
  in this mission.
- Look for: file read operations or explicit references to standards content.
- If the agent proposed changes without consulting standards, REJECT.

### Gate 2: No Invariant Violations
- The proposal MUST NOT violate any of the project's declared invariants.
- Check each invariant listed in the project's standards against the proposal scope.
- If any invariant is at risk, REJECT with the specific invariant cited.

### Gate 3: Quality Claim Present
- The proposal MUST include a quality improvement claim:
  - Which quality dimension improves.
  - By what measure (quantitative or structural).
  - Confirmation that the project's protected properties are untouched.
- If the quality claim is missing or incomplete, REJECT.

### Gate 4: Scope Specification
- The proposal MUST include explicit scope globs.
- Acceptance criteria MUST be testable without human judgment.
- If scope is vague (e.g., "improve the codebase"), REJECT.

### Gate 5: Read-Only Compliance
- The product architect MUST NOT have written to source files directly.
- All implementation MUST flow through delegation.
- If motor output shows writes to source code files, REJECT.
- Exception: MEMORY.md, plan documents, and Drive artifacts are allowed.

## Delegation Result Review

### Gate 6: Results Against Standards
- The delegation output MUST be checked against the project's standards.
- Changes must not introduce invariant violations.
- The improvement must deliver on its quality claim.

### Gate 7: Evidence Chain
- The delegation result MUST include:
  - Code change reference (PR URL or equivalent).
  - Test results (pass count, zero failures).
  - Confirmation that scope was respected (no out-of-scope changes).

## Verification Report Format

Structure your verification output as:

```
## Verification Summary
- Standards Consulted: ✅ PASS
- Invariants: ✅ NO VIOLATIONS
- Quality Claim: ✅ PRESENT (dimension: X, measure: Y)
- Protected Properties: ✅ CONFIRMED UNTOUCHED
- Scope: ✅ SPECIFIED (N files/globs)
- Read-Only: ✅ COMPLIANT
- Delegation Results: ✅ VERIFIED | ⬜ N/A

## Notes
<any concerns, suggestions, or observations>
```

### Drive Convention Gate
- ✅ PASS if agent used `work-publish` for artifact uploads
- ⚠️ WARN if agent used raw `drive-upload` — suggest `work-publish` next time
- ✅ PASS if no artifacts were produced (read-only mission)
