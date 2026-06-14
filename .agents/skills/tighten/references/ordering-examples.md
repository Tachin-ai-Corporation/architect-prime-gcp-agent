# Tighten Reference — Execution-Flow Ordering Examples

Real patterns from the Architect Prime codebase showing correct ordering.

---

## gce-auth.mjs — Minimal file, already well-ordered

This file is a model of what tightened code looks like:

```javascript
// corekit/lib/gce-auth.mjs — GCE metadata OAuth2 token cache
// Extracted from agent-brain.mjs Phase 0A
// Used by all daemons and lib modules that talk to GCP services.

let _cache = { token: null, expiresAt: 0 };          // CONSTANTS & STATE
const REFRESH_MARGIN_MS = 30_000;

/**                                                     // PUBLIC API
 * Get a valid GCE metadata OAuth2 access token.        (only one function —
 * Caches the token and auto-refreshes when near expiry. no helpers needed)
 * @returns {Promise<string>} OAuth2 access token
 */
export async function getGceToken() {
  if (_cache.token && Date.now() < _cache.expiresAt - REFRESH_MARGIN_MS) {
    return _cache.token;
  }
  const resp = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) }
  );
  if (!resp.ok) throw new Error(`GCE metadata token fetch failed: HTTP ${resp.status}`);
  const data = await resp.json();
  _cache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return _cache.token;
}
```

Why it's a model: 14 lines of header+constant, 16 lines of function. Zero
waste. The comment explains WHY ("auto-refreshes when near expiry"), not WHAT.

---

## json-repair.mjs — Callee-before-caller ordering

The execution flow when `parseJsonResponse(raw)` is called:

```
parseJsonResponse
  ├── extractBalancedJson    (called first)
  ├── JSON.parse             (builtin)
  └── repairTruncatedJson    (fallback)
```

Correct order (callee before caller):

```javascript
// 1. MODULE HEADER
// corekit/lib/json-repair.mjs — JSON parsing and repair utilities
// Extracted from agent-brain.mjs Phase 0C
// Pure functions with zero dependencies. Used to parse and repair
// truncated/malformed JSON from LLM responses.

// 2. CONSTANTS
const warn = (...args) => console.warn('[json-repair]', ...args);

// 3. PURE HELPERS (leaf functions — called by core logic)

function extractBalancedJson(str) { /* ... */ }

function repairTruncatedJson(str) { /* ... */ }

// 4. PUBLIC API (composes the helpers above)

/**
 * Parse a raw LLM response string into a JSON object.
 * Handles markdown fences, bracket-balanced extraction, and truncation
 * repair as progressive fallbacks.
 *
 * @param {string} raw - Raw LLM response text
 * @returns {object} Parsed JSON object, or { error: 'parse_failed', raw }
 */
export function parseJsonResponse(raw) { /* ... */ }
```

Reader encounters `extractBalancedJson` and `repairTruncatedJson` before
seeing them called inside `parseJsonResponse`. Comprehension follows naturally.

---

## vertex-text.mjs — Section dividers for larger files

```javascript
// corekit/lib/vertex-text.mjs — Vertex AI text utility layer
// Extracted from agent-brain.mjs Phase 0D
// Provides LLM-powered text summarization, title generation, and schema
// enforcement via direct Vertex AI calls (no gateway, no agent routing).
// Canon C-6: shadow-LLM pattern — utility calls bypass the gateway.

import { getGceToken } from './gce-auth.mjs';
import { parseJsonResponse } from './json-repair.mjs';

// ---- Schema definitions for Cortex output enforcement ----

export const CORTEX_SCHEMAS = { /* ... */ };

// ---- Pure text utilities ----

/**
 * Truncate text using head/tail strategy, preserving context from both ends.
 * Pure function — no LLM call.
 */
export function smartTruncate(text, budget) { /* ... */ }

// ---- Vertex AI call layer ----

async function callVertex(prompt, config) { /* ... */ }

/**
 * Summarize text via Vertex AI utility call.
 * Canon C-6: direct Vertex, not through gateway.
 */
export async function smartSummarize(text, config) { /* ... */ }

export async function generateTitle(text, config) { /* ... */ }
```

---

## Import grouping — correct order

```javascript
// Node.js builtins
import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

// Shared corekit libraries (alphabetical)
import { createClient } from './firestore.mjs';
import { getGceToken } from './gce-auth.mjs';
import { parseJsonResponse } from './json-repair.mjs';
import { smartSummarize } from './vertex-text.mjs';

// Local / config
import { AGENT_CONFIG } from '../config.mjs';
```

---

## Comment patterns — correct and incorrect

### Correct inline comments (why, not what)

```javascript
// Cache for ~58 min — leaves 2 min margin before GCE token expiry
_cache.expiresAt = Date.now() + 3500_000;

// Canon B-20: repair malformed JSON at the boundary, never trust raw output
const parsed = parseJsonResponse(raw);

// DWD requires impersonating a real user; the SA alone has no Workspace identity
const claim = { iss: signerSa, sub: subjectEmail, /* ... */ };
```

### Incorrect (remove these)

```javascript
// Set the cache expiry                          ← restates the code
_cache.expiresAt = Date.now() + 3500_000;

// TODO: fix this later                          ← no ticket, no context
const parsed = parseJsonResponse(raw);

// const oldApproach = doThingTheOldWay();       ← dead commented-out code
```
