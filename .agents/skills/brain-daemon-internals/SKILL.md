---
name: brain-daemon-internals
description: "Internal architecture of agent-brain.mjs — the Brain v3 orchestration daemon. Use when debugging brain behavior, modifying the processing pipeline, or understanding how missions flow through classify→decide→execute→synthesize."
---
# Brain Daemon Internals

## File Location
`corekit/daemon/agent-brain.mjs` (~4400 lines)

## Processing Pipeline

```
GChat message → agent-ears → intake (Firestore) → agent-brain → work envelopes → agent-mouth → GChat reply
```

### 1. Intake Polling (`pollIntake`)
- Polls `primes/{PRIME_ID}/intake` collection every 3s for `status: pending`
- Filters by `source_meta.agentId` matching this agent
- Retry logic: 3 retries before permanent failure

### 2. Classification (`processIntake` → `callCortex('classify')`)
- Cortex classifies intake as: `new_mission`, `attach`, `continue`, `cancel`
- `info_only` and `new_task` were removed in v2026.06.06.4.0
- Classification guidance provided via `classification_guidance` object in prompt

### 3. Mission Creation (`processIntakeAsNewTask`)
- Creates M-type envelope in `work` collection
- Generates title via `generateTitle()` (Flash w/ thinking disabled)
- Injects ack as first C→T pair via `createCT()`
- Calls `processEnvelope()` to start the decide loop

### 4. Decide Loop (`processEnvelope`)
- Iterates up to `MAX_ITERATIONS` (default 10)
- Each iteration calls `callCortex('decide')` for next action
- Actions: `delegate`, `follow_process`, `needs_input`, `complete`, `escalate`
- Builds accumulated context from prior results each iteration

### 5. Synthesis & Delivery
- On completion, `synthesizeEnvelope()` generates user-facing output
- Only M-type envelopes get `delivery_status: 'pending'`
- C and T envelopes are always `delivery_status: 'internal'`
- agent-mouth polls for `delivery_status: 'pending'` envelopes

## Key Functions

| Function | Line | Purpose |
|----------|------|---------|
| `summarizeViaVertex()` | ~111 | Direct Vertex AI call for summarization (bypasses gateway) |
| `generateTitle()` | ~323 | LLM title generation with definition-based prompting |
| `createCT()` | ~339 | Creates C→T pair under parent envelope (M→C→T enforcement) |
| `getAuthToken()` | ~1445 | GCE metadata token for Firestore REST |
| `firestoreWrite()` | ~1509 | Write doc to Firestore via REST PATCH |
| `firestoreRead()` | ~1529 | Read doc from Firestore via REST GET |
| `firestoreQuery()` | ~1541 | Structured query (⚠️ always adds `orderBy: created_at`) |
| `callCortex()` | ~1596 | Send prompt to Cortex via gateway |
| `processIntake()` | ~2500 | Main intake processing (classify → route) |
| `processEnvelope()` | ~2860 | Main envelope processing (decide loop) |
| `pollIntake()` | ~3680 | Intake polling loop |
| `checkWaitingEnvelopes()` | ~3737 | Check if delegated work completed |
| `archiveEnvelopes()` | varies | Move completed/old envelopes to archive |

## Important Constants

| Constant | Source | Purpose |
|----------|--------|---------|
| `AGENT_ID` | `process.env.AGENT_ID` | Short agent name (e.g. `stan`) |
| `AGENT_EMAIL` | `process.env.AGENT_USER_EMAIL` | Full email (often empty!) |
| `PRIME_ID` | `process.env.PRIME_ID` | Prime identifier (e.g. `chucknorris`) |
| `BRAIN_MODEL` | `contracts.dispatch.model` | Model for summarization (default: `gemini-2.5-flash`) |
| `CORTEX_ROUTE` | `contracts.agents.gatewayRoute` | Gateway route for Cortex calls |
| `FIRESTORE_BASE` | computed | `https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents` |

## Common Pitfalls

### 1. Gemini 2.5 Flash Thinking Model
- Response has multiple `parts`: `parts[0]` = thought (may be empty/tiny), `parts[1+]` = actual text
- `summarizeViaVertex()` extracts the **last non-thought** text part
- For trivial tasks (titles), use `disableThinking: true` via `thinkingConfig: { thinkingBudget: 0 }`
- `maxTokens` must account for thinking budget — 30 tokens is NOT enough

### 2. Owner Field Mismatch
- Envelopes store `owner` as full email: `devops-agent-stan@example.com`
- `AGENT_EMAIL` env var is often empty; `AGENT_ID` is just `stan`
- When filtering by owner, use `includes(AGENT_ID)` not strict equality

### 3. Firestore Index Requirements
- `firestoreQuery()` always adds `orderBy: created_at, direction: ASCENDING`
- Any composite filter + orderBy requires a Firestore composite index
- For simple one-off queries, use raw REST `GET` on the collection URL instead
- Work collection can have 1000+ docs — always paginate with `pageSize` + `nextPageToken`

### 4. Startup Recovery
- Brain has a startup recovery sweep that finds orphaned active/pending M envelopes
- Uses raw REST list (paginated) to avoid index requirements
- Resets to `pending`, recalls memory, and re-processes via `processEnvelope()`
- Located right after `archiveEnvelopes()` in the startup sequence

### 5. Processing Mutex
- `let processing = false;` global prevents concurrent intake processing
- `pollIntake()` returns immediately if `processing === true`
- Long-running `processEnvelope()` blocks new intakes until complete

## Startup Sequence
1. Load responsibilities config
2. Load projects from Firestore
3. Gateway health check
4. **Archival sweep** — archive old completed/failed envelopes
5. **Recovery sweep** — find and re-process orphaned active/pending M envelopes
6. Start intake polling (every 3s)
7. Start responsibility scheduler (cron-based)
8. Watch responsibility config files for hot-reload
9. Initial poll
