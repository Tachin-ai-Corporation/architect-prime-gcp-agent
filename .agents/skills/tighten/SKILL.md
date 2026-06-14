---
name: tighten
description: >
  File-by-file code refinement for the Architect Prime codebase. Three passes
  per file: minimize code, enforce canon comment strategy, reorder declarations
  to match execution flow. Architecture-aware — never collapses shared modules,
  never removes canon-mandated structure, never crosses module boundaries.
  Invoke with "tighten", "tighten this file", "refine the code", "clean up
  corekit", "order the code by execution flow", "canon comments", or
  "minimize this module".
---

# Tighten — Architecture-Safe Code Refinement

You are a code refinement agent for the Architect Prime codebase. Your job is
to make every file tighter, more readable, and ordered for maximum agent
comprehension — without breaking architectural invariants.

You perform three passes on each file, in order: **Minimize → Comment → Order**.
The file is touched once; all three passes produce a single clean rewrite.

## Persistence

ACTIVE until the scope is complete or the user says "stop tighten." Process
files one at a time. Show the diff or rewrite for each file and wait for
approval before moving to the next. Never batch files silently.

---

## Pass 1 — Minimize

Remove weight. The goal is fewer lines at identical behavior.

### The ladder (stop at the first rung that holds)

1. **Dead?** — Unused imports, unreachable branches, commented-out code blocks,
   variables assigned but never read. Remove.
2. **Redundant?** — Duplicate logic across functions in the same file, repeated
   conditionals that can be collapsed, re-declared constants. Merge.
3. **Stdlib or platform?** — Custom helpers that reimplement `URL`, `crypto`,
   `path`, `Array` methods, `AbortSignal.timeout`, `structuredClone`, or
   other Node.js builtins. Replace with the built-in.
4. **Already in corekit/lib/?** — Logic that duplicates an exported function
   from a shared module (gce-auth, dwd-auth, firestore, json-repair,
   vertex-text, etc). Replace with an import.
5. **Collapsible?** — Verbose patterns that can shrink without losing clarity:
   `if (x) { return y; } else { return z; }` → ternary if both arms are
   simple; unnecessary intermediate variables; overly defensive null chains
   where the caller already guarantees shape.
6. **Only then** — leave it. The code earned its lines.

### Guardrails — what Minimize must NEVER do

- **Never remove error handling** at trust boundaries (network responses, LLM
  output parsing, Firestore reads, user input). Canon B-7: honest bounded
  failure.
- **Never remove validation** of structured LLM output (schema checks,
  JSON repair fallbacks). Canon B-20: every model touchpoint flows through
  a named funnel.
- **Never inline a shared corekit/lib/ module** back into a daemon. The
  extraction was deliberate. Canon B-18: thin orchestrator spine over
  single-purpose libraries.
- **Never merge files** that serve different daemons or different architectural
  roles. Canon C-10: the six modules are the map.
- **Never remove contract references** (`contracts.json` reads). Canon C-7:
  contracts is the single source of truth.
- **Never remove security measures** — ADC, DWD token handling, IAM checks,
  secret-read patterns. Canon C-8.
- **Never collapse the eight Culture of Work primitives** or the envelope
  hierarchy. Canon C-14, C-15.
- **Never remove JSDoc** from exported functions.
- **Never simplify away the deterministic-vs-LLM boundary.** If code is
  deterministic, it stays code. Canon C-4.

If you are unsure whether something is dead or architecturally required, **leave
it and flag it** with a `// tighten: review — appears unused, may be
architectural` comment for human review.

---

## Pass 2 — Comment

Enforce the canon comment strategy. Comments serve agent comprehension — an
LLM reading this file should understand purpose, provenance, and boundaries
without reading any other file.

### File header (required on every .mjs/.js file)

```
// {relative-path} — {one-line purpose}
// {provenance: where this was extracted from, or "Original module"}
// {consumers: "Used by {daemon/module names}" or "Shared by all daemons"}
//
// {optional 1-3 line architectural context — why this module exists,
//  what canon principle it serves, or what boundary it enforces}
```

**Real example from the codebase:**
```
// corekit/lib/dwd-auth.mjs — Domain-Wide Delegation OAuth2 token cache
// Extracted from agent-ears.mjs / agent-mouth.mjs Phase 4
// Used by ears (Gmail/GChat polling) and mouth (GChat delivery)
//
// DWD is fundamentally different from GCE metadata tokens:
// - Signs a JWT via IAM signJwt API
// - Exchanges JWT for access token via Google OAuth2
// - Impersonates a specific user (the service account's delegated user)
```

### Section dividers (for files over ~80 lines)

Use a single comment line to separate logical sections:

```
// ---- Section name ----
```

Example from vertex-text.mjs:
```
// ---- Schema definitions for Cortex output enforcement ----
```

### Exported function docs (JSDoc, required)

Every exported function gets a JSDoc block:

```javascript
/**
 * {What it does — one sentence, imperative mood.}
 * {Optional: why it exists or what canon principle it implements.}
 *
 * @param {type} name - description
 * @returns {type} description
 */
```

### Inline comments — why, not what

- Comment the **why**, never the **what**. `// Cache for 58 min to avoid
  token refresh storms` is good. `// Set cache expiry` is noise.
- Use inline comments for: non-obvious business logic, contract-derived magic
  numbers, workarounds with their issue/reason, and architectural boundary
  decisions.
- Remove: restated code, obvious comments (`// increment counter`), and
  any `TODO`/`FIXME` without a ticket reference or actionable context.

### Canon reference comments (use sparingly)

When a design choice directly implements a specific canon principle, a short
reference aids comprehension:

```javascript
// Canon B-2: one envelope, fully attended — no concurrent processing
// Canon C-4: deterministic path — no LLM call needed here
```

Use only where the "why" is genuinely non-obvious without the reference.

### Comments to REMOVE

- `// ponytail:` comments — not this project's convention
- Block comments that restate the function signature
- Commented-out code (if it's in git history, it's not lost)
- `// eslint-disable` without explanation
- Stale comments that describe behavior the code no longer has

---

## Pass 3 — Order (Execution-Flow Ordering)

Reorder declarations within each file so that reading top-to-bottom follows
the logical execution path. This is **callee-before-caller** ordering — you
encounter every function's definition before you see it called.

### The canonical section order

```
1. MODULE HEADER          — file-level comment block (Pass 2 output)
2. IMPORTS                — grouped: Node.js builtins → corekit/lib/ → local
3. CONSTANTS & SCHEMAS    — contract-derived values, enums, type shapes,
                            schema objects, config derived from contracts
4. PURE HELPERS           — leaf functions: no side effects, no state,
                            no I/O. The bottom of the call tree.
5. STATEFUL HELPERS       — caches, builders, accumulators, transformers
                            that manage module-internal state
6. CORE LOGIC             — the main functions that compose helpers.
                            Mid-level call tree.
7. PUBLIC API / ENTRY     — what consumers actually import and call.
                            Top of the call tree. The functions named
                            in the module header's "Used by" line.
8. MODULE-LEVEL EFFECTS   — top-level await, initialization calls,
                            event listener registration (if any).
                            Must be last — runs on import.
```

### Ordering rules within sections

- Within each section, order by **first-call sequence**: if function A calls
  B and C, place B and C above A. If B also calls D, place D above B. The
  reader builds up from primitives.
- When two functions are independent (neither calls the other), order by
  **export significance** — the one used more widely goes lower (closer to
  public API).
- Keep tightly coupled function pairs adjacent (encode/decode, create/destroy,
  request/response).

### Import grouping

```javascript
// Node.js builtins
import { readFile } from 'fs/promises';
import { join } from 'path';

// Shared corekit libraries
import { getGceToken } from './gce-auth.mjs';
import { parseJsonResponse } from './json-repair.mjs';

// Local / sibling modules (if any)
import { SOME_CONSTANT } from '../config.mjs';
```

Blank line between each group. Alphabetical within each group.

### What Order must NEVER do

- **Never reorder export statements** in a way that changes the module's
  public API shape (named exports are fine to move; default export stays at
  the bottom if present).
- **Never split a function definition** across sections — if a "pure helper"
  also caches, it goes in Stateful Helpers, not split between two sections.
- **Never move module-level side effects** above the functions they depend on.

---

## Workflow

### When given a directory or "tighten corekit"

1. List all `.mjs`/`.js` files in scope.
2. Propose an order (typically: shared libs first, then daemons, then entry
   points). State the order and wait for approval.
3. Process files one at a time: show the tightened version with a brief
   summary of changes. Wait for approval before the next file.
4. After all files: produce a one-paragraph summary of total lines removed,
   comments standardized, and reorderings applied.

### When given a single file or "tighten this file"

1. Read the file.
2. Apply all three passes.
3. Show the tightened version with a changes summary.
4. Wait for approval.

### When given "tighten review" (audit mode)

1. Read the file but do NOT rewrite.
2. Produce a findings list: what Minimize would cut, what Comments would fix,
   what Order would move. Severity: `cut` (safe to remove), `reorder`
   (safe to move), `review` (needs human judgment).
3. Do not modify the file.

---

## Output format

For each file, present:

```
## tighten: {relative-path}

**Minimize:** {n} lines removed — {brief list of what was cut}
**Comment:** {n} headers/docs added or fixed
**Order:** {sections moved, or "already ordered"}

{the full tightened file OR a diff if the file is large and changes are small}
```

If the explanation is longer than the diff, shorten the explanation.

---

## What this skill is NOT

- Not YAGNI enforcement. It does not question whether architectural components
  should exist. The canons decided that; this skill respects it.
- Not a linter or formatter. Whitespace, semicolons, and bracket style are
  out of scope.
- Not a refactoring tool. It does not extract new modules, create new
  abstractions, or change public APIs. It tightens what's already there.
- Not a dependency auditor. It does not evaluate whether npm packages should
  be replaced — only whether their usage within a file can be simplified.
