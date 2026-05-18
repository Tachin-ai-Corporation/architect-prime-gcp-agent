# Brain v3 — Core concepts and decisions

> This document defines the foundational concepts, naming, and architectural decisions for the Brain v3 architecture. It is the canonical reference. All phase documents derive from this.

---

## The problem

The current agent architecture runs planning and execution inside OpenClaw's LLM conversation loop via `sessions_spawn`/`sessions_yield`. OpenClaw's subagent plugin injects a hardcoded `Action:` block when a child agent returns, instructing the parent to "convert the result into your assistant voice and send that user-facing update now." This hijacks the orchestration flow — Cortex obeys the injected instruction instead of executing the dispatch plan.

This is architectural, not a prompt engineering problem. The fix is to move orchestration out of the LLM conversation loop entirely.

---

## Design principles

1. **LLMs think. Deterministic systems orchestrate.** Agent call sequencing, state transitions, retries, and context passing happen in deterministic code.
2. **One envelope format, all scales.** Human messages, cron triggers, multi-step missions, and single tool calls all use the same structure.
3. **Firestore is the shared work repository.** Envelopes are durable documents. Agents pass IDs, not payloads. The dashboard reads the same collection agents write to.
4. **Memory is hardwired.** Every envelope gets a recall before processing and a write after completion.
5. **Agents are cognitive workers, not orchestrators.** OpenClaw provides the LLM execution environment. Brain handles everything between turns.

---

## Naming

| Name | What it is | Pattern |
|------|-----------|---------|
| **Ears** | Input service. Polls channels, writes intake records to Firestore. | systemd, zero LLM |
| **Brain** | Orchestration service. Processes envelopes through the Cortex loop. | systemd, calls LLMs via HTTP |
| **Mouth** | Output service. Reads completed envelopes, classifies and delivers. | systemd, one LLM call |
| **Cortex** | Brain's primary LLM. Classifies intake, decides next actions, synthesizes results. | OpenClaw agent (gateway HTTP) |
| **Prefrontal** | Deep planning specialist. Called by Cortex for complex decomposition. | OpenClaw agent |
| **Motor** | Execution agent. Runs tools, APIs, file ops. | OpenClaw agent |
| **Cerebellum** | Verification agent. Reads accept_criteria, returns pass/fail. | OpenClaw agent |
| **Temporal-memory** | Memory agent. Recall and write. Hardwired into Brain loop. | OpenClaw agent |
| **Temporal-research** | Web search agent. Vertex AI grounding. | OpenClaw agent |

---

## R/C/M/T hierarchy

All work is expressed as four nesting levels:

### Responsibility (R)
Standing, recurring obligation. No end state. Fires on schedule and spawns Missions.
- Source: cron schedule in `responsibilities.json`
- Examples: "Monitor fleet health every 6 hours," "Consolidate memory nightly"

### Mission (M)
Goal with a defined end state. Has an owner, acceptance criteria, terminates.
- Sources: human message, Responsibility trigger, inter-agent delegation
- Examples: "Upload budget doc to Finance folder," "Deploy fleet agent Stan"

### Checkpoint (C)
Verifiable milestone within a Mission. Represents a provable state transition.
- Has: testable acceptance criteria
- Examples: "VM is provisioned and SSH-able," "Subfolder created and verified"

### Task (T)
Atomic unit. One agent, one LLM turn, one envelope in, one envelope out.
- Hits the gateway exactly once
- Examples: "Call drive-ls on folder X," "Verify document at path Y"

---

## Envelope structure

Every handoff uses the same envelope, stored in Firestore at `primes/{primeId}/work/{envelopeId}`.

### Fields
- `id` — unique (`w-{timestamp}-{random}`)
- `type` — R / M / C / T
- `parent_id` — containing envelope (null for top-level)
- `owner` — agent ID or email
- `status` — pending / active / complete / failed / blocked / needs_input / waiting
- `intent` — plan / execute / verify / research / recall / synthesize / delegate
- `instruction` — what needs to happen
- `accept_criteria` — how to verify success
- `context_summary` — short context (under 4KB inline)
- `output` — work product (under 4KB inline)
- `children` — ordered list of child envelope IDs
- `context_forward` — state for next sibling or parent
- `error` — if failed/blocked, why
- `source_channel` — dashboard / gchat / cron / agent
- `source_meta` — channel metadata
- Timestamps: `created_at`, `started_at`, `completed_at`, `updated_at`
- `iteration` — current Cortex loop iteration

Large data (over 4KB) goes to `work/{id}/context/{chunk}` subcollection.

Status transition history at `work/{id}/history/{seq}`.

---

## Intake model

Ears does NOT create envelopes. It writes lightweight **intake records** to `primes/{primeId}/intake/{intakeId}`:
- `id`, `text`, `source`, `source_meta`, `status` (pending/claimed), `created_at`

Brain picks up intake, does memory recall + active envelope scan, calls Cortex in `classify` mode. Cortex decides:
- `new_mission` — brand new work
- `new_task` — quick one-shot, no Mission wrapper
- `attach` — follow-up to existing envelope (returns envelope ID)
- `new_responsibility` — standing obligation

Brain creates or attaches accordingly, then enters the Cortex loop.

---

## Agent registry and per-job tools

### Base tools (every agent)
All agents regardless of job get a base set of capabilities installed via `manifests/base.txt`:
- `agent-ask` (Vertex AI grounding search)
- Core system tools (exec, file read/write)
- Memory tools (memory_search, core-memory-read, core-memory-write)

### Per-job tools
Each agent job (DevOps, Engineer, QA, PM, etc.) gets additional tools installed via `manifests/job-{specialty}.txt`. The agent registry reflects the actual installed tools per agent:

| Job | Additional Motor tools |
|-----|----------------------|
| **All jobs** | agent-ask, exec, memory tools |
| **DevOps** | workspace-drive (9), workspace-gmail (5), workspace-calendar (5), fleet tools |
| **Engineer** | workspace-drive (9), workspace-docs (6), workspace-sheets (3) |
| **QA** | workspace-drive (9), workspace-docs (6) |
| **PM** | workspace-drive (9), workspace-gmail (5), workspace-calendar (5), workspace-docs (6), workspace-sheets (3) |
| **Finance** | workspace-drive (9), workspace-sheets (3), workspace-gmail (5) |
| **Data** | workspace-drive (9), workspace-sheets (3) |
| **Security** | workspace-drive (9), workspace-gmail (5) |
| **Assistant** | workspace-drive (9), workspace-gmail (5), workspace-calendar (5), workspace-docs (6) |

The agent registry JSON is **generated at bootstrap** by `build-agent-registry`, which reads:
- `contracts.json` for agent IDs, models, routes
- Each agent's workspace `TOOLS.md` for installed tools
- The installed manifest fragments to determine which skills are present

This means Cortex always knows exactly what this specific agent's Motor can do. A DevOps agent's Cortex won't try to dispatch Sheets operations if workspace-sheets isn't installed.

---

## Brain inner loop

### Three input paths
1. **Intake** — Ears wrote a raw message → Brain recalls + scans → Cortex classifies → envelope created → Cortex loop
2. **Envelope** — already exists (delegation, responsibility trigger) → Cortex loop directly
3. **Responsibility** — Brain's scheduler fires → R + M envelopes created → Cortex loop

### The Cortex loop
```
1. Memory recall (hardwired, always)
2. Consult Cortex (envelope + memory + registry + prior_results)
3. Parse structured decision
4. Execute decision:
   - dispatch → call agent via HTTP → feed result back → goto 2
   - plan → create child envelopes → execute sequentially → goto 2
   - synthesize → write output → mark complete → exit
   - short_circuit → write response → mark complete → exit
   - needs_input → mark blocked → notify human → exit
   - delegate → create Mission for other agent → mark waiting → exit
5. Memory write (hardwired, on completion)
```

### One envelope at a time
Brain processes one envelope at a time, sequentially. For concurrency, hire more fleet agents. Each agent is cheap compared to a human and humans can't do more than one thing at a time either. Incoming requests during processing queue in Firestore as pending intake records. Cortex can use Mouth to send status updates ("working on X, will get to your request next").

### No hard timeouts
Brain polls OpenClaw's `/status` endpoint to check if the gateway is still processing rather than using hard timeouts. If more user requests arrive during processing, they queue as intake records. Cortex can also send interim status updates via Mouth to keep humans informed.

---

## OpenClaw session strategy

### Research findings
OpenClaw supports four session types:
- **main** — the default session, accumulates all history
- **isolated** — fresh per call, no history carryover
- **named** (`session:custom-id`) — persists across calls, survives gateway restarts
- **current** — binds to whatever session was active at creation

OpenClaw auto-compacts sessions when they approach the model's context window — summarizing older messages while keeping recent ones intact. Token usage is queryable via `/status`.

### Decision: hybrid session strategy
- **Default: named session per envelope** — Brain creates a named session `session:envelope-{envelopeId}` for each active envelope. All Cortex consultations and agent dispatches for that envelope use the same named session. This gives Cortex continuity within one piece of work without cross-contaminating between envelopes.
- **Isolated sessions for stateless agents** — Cerebellum and temporal-memory calls use isolated sessions (fresh each time) since they don't benefit from accumulated context.
- **Session monitoring** — Brain checks `/status` for session token usage. If a named session approaches 70% capacity, Brain triggers a context checkpoint write before the next dispatch.
- **Session cleanup** — When an envelope completes, Brain can close its named session. OpenClaw's idle expiry handles the rest.

---

## Memory architecture

### Memory tiers

**Tier 1 — Working memory (per-envelope)**
- Lives in the envelope's `context_summary` and `context_forward` fields
- Accumulated `prior_results` from the Cortex loop
- Scope: current envelope only
- Lifetime: until envelope completes
- Write frequency: every Cortex loop iteration (automatic, part of state management)

**Tier 2 — Session memory (OpenClaw managed)**
- Lives in the OpenClaw named session transcript
- Includes all Cortex consultations and agent responses within one envelope
- Scope: current envelope's session
- Lifetime: until session closes or compacts
- Write frequency: automatic (OpenClaw manages)

**Tier 3 — Working notes (daily files)**
- Lives in workspace `memory/YYYY-MM-DD.md`
- Written by temporal-memory on envelope completion
- Scope: per-agent, per-day
- Lifetime: until nightly consolidation
- Write frequency: on envelope completion (hardwired in Brain loop)

**Tier 4 — Core memory (durable, Firestore)**
- Lives in `primes/{primeId}/memory/core/`
- Promoted from working notes by nightly consolidation
- Scope: per-agent, permanent
- Lifetime: permanent (pruned by relevance over time)
- Write frequency: nightly consolidation responsibility

**Tier 5 — Deep truths (immutable principles)**
- Lives in workspace `SOUL.md` under the Deep Truths section
- Promoted from core memory when patterns are consistent and significant
- Scope: per-agent, fundamental identity
- Lifetime: permanent, rarely changes
- Write frequency: when consolidation identifies durable patterns

### Integration into Brain loop

**On intake (before classify):**
- Tier 4 recall: temporal-memory searches core memory for relevant context
- Tier 3 recall: temporal-memory reads today's working notes

**During Cortex loop:**
- Tier 1: Brain passes accumulated prior_results to every Cortex consultation
- Tier 2: OpenClaw's named session carries conversation context automatically

**On completion:**
- Tier 3 write: Brain calls temporal-memory to write a structured summary to today's working notes
- Tier 1 cleanup: prior_results and context_forward are preserved in the completed envelope (Firestore) for future reference

**Nightly (Responsibility trigger):**
- Consolidation reads Tier 3 → promotes significant entries to Tier 4
- Consolidation scans Tier 4 → promotes consistent patterns to Tier 5

---

## Responsibility management

### Scheduler
Built into Brain, runs on the E2 VM (not inside OpenClaw). Loads `responsibilities.json` at startup. Background timer fires every 60 seconds, checks schedules, creates R + M envelopes when due. Minimum spacing between responsibilities: configurable, default 15 minutes.

### Agent self-management
Agents can create and remove their own Responsibilities via Cortex tools:
- `responsibility-create` — Cortex decides a new standing obligation is needed, writes to `responsibilities.json` and registers the schedule
- `responsibility-remove` — Cortex decides a Responsibility is no longer needed
- `responsibility-list` — Cortex reviews current Responsibilities

These are Cortex decision actions — Brain executes them deterministically. The tools modify `responsibilities.json` and Brain's in-memory schedule. Changes are durable (written to disk) and survive restarts.

### Gating
- Responsibilities cannot be scheduled within the configurable minimum spacing (default 15 min) of each other
- Responsibility triggers enter Brain through normal intake (queued if Brain is busy)
- Brain processes one envelope at a time — Responsibility missions wait in queue like any other work
- Cortex can skip or defer a Responsibility if current work is higher priority (returns `short_circuit` with a deferral note)

---

## Inter-agent delegation

When Cortex returns `action: delegate`, Brain creates a Mission envelope in Firestore with `owner` set to the target agent. Agent-to-agent requests always carry the parent envelope ID — no ambiguity about whether it's new work or a follow-up.

The target agent's Brain picks up the envelope from Firestore and processes it through its own Cortex loop. When done, it marks the envelope complete. The originating Brain detects the child completion and resumes its own envelope.

Google Chat is used for courtesy notifications only ("New mission assigned: ..."). All coordination happens through Firestore.

---

## Decisions log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session strategy | Named per-envelope, isolated for stateless agents | Cortex needs continuity within work; avoid cross-contamination |
| Concurrency | One envelope at a time per Brain | Simplicity. Hire more agents for concurrency. |
| Timeouts | No hard timeouts. Brain polls /status for liveness. | Hard timeouts kill slow-but-working tasks. Polling gives visibility. |
| Classify ambiguity | Cortex asks the human to clarify | Agent-to-agent always carries envelope ID; ambiguity is a human-input problem |
| Intake lifecycle | Process → reconcile into memory nightly → archive | Envelopes persist for memory reference; archived after consolidation |
| Responsibility scheduling | Built into Brain, not OpenClaw | Scheduling is deterministic work. Minimum 15min spacing. |
| Responsibility self-management | Via Cortex tools | Agents must be able to define their own standing obligations |
| Memory write granularity | On Mission completion + nightly consolidation | Per-Task writes are noise; Mission summaries are meaningful |
| Firestore vs polling | Real-time listeners for Brain | Lower latency, fewer reads, more efficient than polling |
| Per-job tools | Registry generated from installed manifests | Cortex always knows exactly what this agent's Motor can do |
| Context size | Under 4KB inline, over 4KB to subcollection | Keep envelope documents lean for listener performance |
| Firestore costs | Negligible | Not a concern at current scale |
