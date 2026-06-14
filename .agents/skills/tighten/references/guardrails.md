# Tighten Guardrails — Canon Boundaries

Quick reference for what tighten must never touch. When in doubt, leave it
and flag it for human review.

---

## Structural boundaries (PRODUCT CANON)

| Canon | Rule | Tighten implication |
|-------|------|---------------------|
| C-4 | Everything deterministic is deterministic | Never replace code paths with LLM calls. Never suggest "let the model handle this." |
| C-7 | contracts.json is single source of truth | Never hardcode a value that comes from contracts. Never remove a contracts read. |
| C-8 | No secrets in git/disk/Firestore | Never move token handling inline. Never simplify away ADC/DWD patterns. |
| C-10 | Six modules are the map | Never merge files across app/, infra/, corekit/, brain/, specialties/, skills/. |
| C-12 | Host-native under systemd, no containers | Never add Docker/container references. |
| C-14 | Eight CoW primitives are closed set | Never collapse or rename R/M/C/T/Project/Process/Plan/Artifact structures. |
| C-15 | R→M→C→T is the execution spine | Never flatten the envelope hierarchy. |
| C-16 | One envelope at a time per brain | Never add concurrent envelope processing. |

## Code quality boundaries (BRAIN CANON)

| Canon | Rule | Tighten implication |
|-------|------|---------------------|
| B-7 | Honest, bounded failure | Never remove error propagation, iteration caps, or failure cause attachment. |
| B-16 | Skills are codified procedure | Never inline skill content into daemon code. Never move tool syntax into SOUL files. |
| B-17 | Skill use is enforced | Never remove skill resolution from dispatch paths. |
| B-18 | Thin orchestrator over single-purpose libs | Never inline a corekit/lib/ module back into a daemon. Direction of motion: daemon shrinks, libs grow. |
| B-19 | Pure core, effectful edges | Never interleave I/O into pure functions during minimization. Keep side effects at edges. |
| B-20 | Every model touchpoint through named funnel | Never add inline fetch() to model endpoints. Never remove schema validation on LLM output. |
| B-21 | Configuration is contracts; constants named | Never introduce magic numbers. If minimizing, extract to a named constant, don't inline. |

## The DO NOT TOUCH list

These patterns exist for security or correctness reasons. Minimization gains
are not worth the risk:

- `AbortSignal.timeout()` on network calls — prevents hung requests
- `signal: AbortSignal.timeout(5_000)` on GCE metadata — Canon B-14
- JSON repair fallback chains in `parseJsonResponse` — Canon B-20
- Token cache expiry margins (`REFRESH_MARGIN_MS`) — prevents thundering herd
- DWD JWT claim construction — security-critical, structure is the spec
- Firestore encode/decode symmetry — must be exact inverses
- `try/catch` around LLM response parsing — Canon B-7
- Iteration caps on envelope processing loops — Canon B-14
- Schema validation on cortex classify/decide — Canon C-5

## When to flag for review instead of cutting

Add `// tighten: review — {reason}` when:

- A function appears unused but is exported (may be called by another daemon)
- A constant appears unused but comes from contracts.json (may be validated at bootstrap)
- Error handling looks excessive but the function touches network/LLM
- A pattern looks redundant but may be a deliberate fallback chain
- Code references a skill, process, or responsibility by ID
