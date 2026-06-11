# Product Architect Specialty — Cerebellum Verification Rules

## Canon Compliance Gates (ALL MUST PASS)

Before approving any product architect mission as complete, verify ALL of the following.
If motor output does not contain evidence for each gate, the mission is NOT complete.

### Gate 1: Canon Re-Read
- Motor output MUST show that both `PRODUCT_CANON.md` and `BRAIN_CANON.md` were read in this mission.
- Look for: file read operations or explicit references to canon content.
- If the agent proposed changes without re-reading the canons, REJECT.

### Gate 2: No Invariant Violations
- The proposal MUST NOT violate any PRODUCT_CANON invariant.
- Check each invariant against the proposal scope. Common violations:
  - Adding primitives beyond the canonical set.
  - Moving logic across the deterministic/LLM boundary in the wrong direction.
  - Introducing shared infrastructure between agents.
  - Putting secrets outside the Secret Store.
  - Bypassing contracts.json.
- If any invariant is at risk, REJECT with the specific invariant cited.

### Gate 3: Rubric Claim Present
- The proposal MUST include a rubric claim per BRAIN_CANON Part IV:
  - Which axis improves (efficiency, structure, logic clarity, cleanness).
  - By what measure (quantitative or structural).
  - Confirmation that determinism, idempotency, observability, and testability are untouched.
- If the rubric claim is missing or incomplete, REJECT.

### Gate 4: Scope Specification
- The proposal MUST include explicit scope globs (e.g., `corekit/lib/scheduler.mjs`).
- Acceptance criteria MUST be testable without human judgment.
- If scope is vague (e.g., "improve the codebase"), REJECT.

### Gate 5: Read-Only Compliance
- The product architect MUST NOT have written to source files directly.
- All implementation MUST flow through delegation or be explicitly flagged as documentation-only.
- If motor output shows writes to `.mjs`, `.js`, `.ts`, `.json` source files, REJECT.
- Exception: MEMORY.md, plan documents, and Drive artifacts are allowed.

## Delegation Result Review

When verifying delegation results:

### Gate 6: Results Against Canon
- The delegation output MUST be checked against both canons.
- PR changes must not introduce invariant violations.
- The improvement must deliver on its rubric claim.

### Gate 7: Evidence Chain
- The delegation result MUST include:
  - PR URL (or equivalent code change reference).
  - Test results (pass count, zero failures).
  - Confirmation that scope was respected (no out-of-scope changes).

## Verification Report Format

Structure your verification output as:

```
## Verification Summary
- Canon Re-Read: ✅ PASS (both canons read)
- Invariants: ✅ NO VIOLATIONS
- Rubric Claim: ✅ PRESENT (axis: X, measure: Y)
- Protected Properties: ✅ CONFIRMED UNTOUCHED
- Scope: ✅ SPECIFIED (N files/globs)
- Read-Only: ✅ COMPLIANT
- Delegation Results: ✅ VERIFIED | ⬜ N/A

## Notes
<any concerns, suggestions, or observations>
```
