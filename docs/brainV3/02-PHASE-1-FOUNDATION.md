# Phase 1: Foundation

> **Goal:** Prove the Ears → Firestore intake → Brain classify → envelope → Cortex short_circuit → Mouth pipeline works end to end on Stan.

---

## Prerequisites

- Stan is deployed and functional on the current v2 architecture
- Firestore access confirmed from Stan's VM
- OpenClaw gateway accessible at `127.0.0.1:18789` with individual agent routes (`openclaw/cortex`, etc.)

## Research task (before coding)

Validate that the OpenClaw gateway accepts HTTP requests targeting individual agent routes as fresh sessions. Test on Stan:

```bash
curl -X POST http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer $(cat /root/.openclaw/.gateway-token)" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/cortex","messages":[{"role":"user","content":"Respond with only: {\"action\":\"short_circuit\",\"response\":\"hello\"}"}]}'
```

Confirm: (a) the request succeeds, (b) Cortex's response includes parseable JSON, (c) the response may include OpenClaw framing/Action: blocks that we need to parse around.

Also test `session:envelope-test-001` named session targeting to confirm named sessions work via HTTP.

---

## Deliverables

### 1. Firestore schema

Deploy collections and indexes:

**`primes/{primeId}/intake/{intakeId}`**
```
id: string
text: string
source: string (dashboard|gchat|agent)
source_meta: map
status: string (pending|claimed)
created_at: timestamp
```

**`primes/{primeId}/work/{envelopeId}`**
```
id: string
type: string (R|M|C|T)
parent_id: string|null
owner: string
status: string (pending|active|complete|failed|blocked|needs_input|waiting)
intent: string
instruction: string
accept_criteria: string|null
context_summary: string|null
output: string|null
children: array
context_forward: string|null
error: string|null
source_channel: string
source_meta: map
created_at: timestamp
started_at: timestamp|null
completed_at: timestamp|null
updated_at: timestamp
iteration: number
```

**`primes/{primeId}/work/{envelopeId}/history/{seq}`**
```
seq: number
prev_status: string
new_status: string
agent: string
timestamp: timestamp
detail: string
```

**Indexes:**
- `intake: (status, created_at)`
- `work: (owner, status, created_at)`
- `work: (parent_id, status)`
- `work: (type, status, updated_at)`

### 2. Agent registry for Stan

Create `agent-registry.json` populated with Stan's actual agents and tools. The `build-agent-registry` script reads contracts.json and each agent's TOOLS.md to generate this. For Phase 1, only Cortex needs to be complete — other agents are stubs.

```json
{
  "version": "1.0",
  "agent_id": "stan",
  "job": "devops",
  "agents": {
    "cortex": {
      "route": "openclaw/cortex",
      "model": "gemini-3.1-pro-preview",
      "intents": ["classify", "decide", "synthesize", "short_circuit"],
      "tools": [],
      "description": "Guiding intelligence. Classifies intake, decides actions, synthesizes results.",
      "constraints": "Cannot execute tools. Decides only."
    },
    "temporal-memory": {
      "route": "openclaw/temporal-memory",
      "model": "gemini-2.5-flash",
      "intents": ["recall", "write"],
      "tools": ["memory_search", "core-memory-read", "core-memory-write"],
      "description": "Memory recall and storage.",
      "constraints": "Memory only. No external APIs."
    },
    "motor": {
      "route": "openclaw/motor",
      "model": "gemini-2.5-flash",
      "intents": ["execute"],
      "tools": ["drive-ls", "drive-upload", "drive-mkdir", "drive-mv", "drive-cat", "drive-find", "drive-meta", "drive-share", "drive-trash", "gmail-send", "gmail-search", "gmail-read", "gmail-reply", "gmail-drafts", "calendar-create", "calendar-events", "calendar-update", "calendar-delete", "calendar-search", "exec"],
      "description": "Execution agent. Workspace tools + exec.",
      "constraints": "Executes. Does not plan or verify."
    },
    "cerebellum": {
      "route": "openclaw/cerebellum",
      "model": "gemini-2.5-flash",
      "intents": ["verify"],
      "tools": [],
      "description": "Verification. Returns pass/fail against accept_criteria.",
      "constraints": "Read-only verification."
    },
    "temporal-research": {
      "route": "openclaw/temporal-research",
      "model": "gemini-2.5-flash",
      "intents": ["research"],
      "tools": ["vertex-grounding-search"],
      "description": "Web search via Vertex AI grounding.",
      "constraints": "Read-only research."
    },
    "prefrontal": {
      "route": "openclaw/prefrontal",
      "model": "gemini-2.5-flash",
      "intents": ["plan"],
      "tools": [],
      "description": "Deep planning specialist.",
      "constraints": "Plans only. Never executes."
    }
  }
}
```

### 3. `agent-brain.mjs` skeleton

New systemd service. Phase 1 scope: intake poll → classify → short_circuit only.

**Startup:**
- Load agent-registry.json, contracts.json, .identity-lock
- Establish Firestore real-time listener on `intake/` (status=pending)
- Establish Firestore real-time listener on `work/` (owner=self, status=pending)

**Intake processing (Phase 1 — simplified, no memory yet):**
```
on intake record (status=pending):
  claim intake (set status=claimed)
  call Cortex in classify mode:
    - mode: "classify"
    - inbound: { text, source, source_meta }
    - memory: {} (empty in Phase 1)
    - active_envelopes: [] (empty in Phase 1)
    - agent_registry: (loaded registry)
  parse Cortex response
  create envelope based on classification
  process envelope
```

**Envelope processing (Phase 1 — short_circuit only):**
```
on envelope (status=pending):
  set status=active
  call Cortex in decide mode:
    - mode: "decide"
    - envelope: { id, type, instruction }
    - memory: {} (empty in Phase 1)
    - agent_registry: (loaded registry)
    - prior_results: []
    - iteration: 1
  parse Cortex response
  if action == short_circuit:
    set output = response
    set status = complete
  else:
    set status = failed, error = "Phase 1: only short_circuit supported"
  write history entry
```

**Response parser:**
- Extract JSON from LLM response (look for `{` ... `}` block)
- Strip markdown fencing if present
- Validate against expected schema
- Retry once on parse failure with explicit "return JSON only" instruction
- Log raw response on double failure

### 4. Cortex SOUL.md v2 (minimal)

Rewrite Cortex's SOUL.md for the new model. Phase 1 supports `classify` and `short_circuit` only:

Key directives:
- You operate in two modes: `classify` and `decide`
- In classify mode: categorize inbound messages. Return JSON with action="classify".
- In decide mode: for Phase 1, return `short_circuit` for everything — answer directly from your knowledge and SOUL context
- Always return exactly one JSON block
- JSON schema must match the Cortex decision format defined in 00-CORE-CONCEPTS.md

### 5. Ears rewire

Modify `agent-ears.mjs` behind the `BRAIN_V3_EARS_MODE` feature flag:

When `BRAIN_V3_EARS_MODE=intake`:
- Instead of building conversation history and POSTing to gateway
- Write an intake record to Firestore: `{ id, text, source, source_meta, status: "pending", created_at }`
- Done. Fire and forget.

When `BRAIN_V3_EARS_MODE=gateway` (default):
- Current behavior unchanged

### 6. Mouth rewire

Modify `agent-mouth.mjs` behind the `BRAIN_V3_MOUTH_MODE` feature flag:

When `BRAIN_V3_MOUTH_MODE=firestore`:
- Set up Firestore real-time listener on `work/` collection
- Filter: `type IN [M, T]` AND `status IN [complete, needs_input]` AND `source_channel` matches this Mouth's channel
- On match: read `output` field, classify delivery channel, format via LLM, deliver
- Mark envelope as `delivered` (new status or flag)

When `BRAIN_V3_MOUTH_MODE=jsonl` (default):
- Current behavior unchanged

### 7. End-to-end test

On Stan, with feature flags enabled:

1. Human sends "who are you?" via Google Chat
2. Ears writes intake record to Firestore (verify in console)
3. Brain picks up intake, calls Cortex classify
4. Cortex returns `{ action: "classify", classification: "new_task", instruction: "who are you?" }`
5. Brain creates Task envelope in Firestore (verify)
6. Brain calls Cortex decide
7. Cortex returns `{ action: "short_circuit", response: "I'm Stan, a DevOps specialist..." }`
8. Brain marks envelope complete with output (verify)
9. Mouth picks up completed envelope, delivers to Google Chat
10. Human sees response

**Success criteria:** Response quality matches current v2. Full audit trail visible in Firestore. Intake → envelope → history all present.

---

## Files created/modified

| File | Action | Description |
|------|--------|-------------|
| `corekit/daemon/agent-brain.mjs` | CREATE | Brain service skeleton |
| `corekit/daemon/agent-brain.service` | CREATE | systemd unit file |
| `corekit/daemon/start-agent-brain` | CREATE | Service launcher |
| `corekit/config/agent-registry.json` | CREATE | Agent capabilities manifest |
| `corekit/brain/build-agent-registry` | CREATE | Registry generator script |
| `brain/prime/cortex/SOUL.md` | MODIFY | Rewrite for v3 classify/decide model |
| `brain/fleet/_brain/cortex/SOUL.md` | MODIFY | Fleet version of v3 Cortex SOUL |
| `corekit/daemon/agent-ears.mjs` | MODIFY | Add BRAIN_V3_EARS_MODE flag + intake write path |
| `corekit/daemon/agent-mouth.mjs` | MODIFY | Add BRAIN_V3_MOUTH_MODE flag + Firestore read path |
| `infra/manifests/base.txt` | MODIFY | Add agent-brain.mjs, agent-brain.service, agent-registry.json |
