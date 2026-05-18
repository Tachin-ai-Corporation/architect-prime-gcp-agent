# Brain v3 — Implementation Walkthrough

> Living document tracking what was built, tested, and learned across all phases.
> Last updated: 2026-05-18 (Phase 1 complete)

---

## Phase 1 — Foundation (2026-05-18)

### What Was Built

Complete rip-and-replace of the agent orchestration pipeline from v2 (conversational LLM-loop) to v3 (deterministic, envelope-based Firestore pipeline).

### Pipeline Architecture (v3)

```
User → GChat → Ears (polls GChat API)
                 ↓
              Firestore intake write (primes/{primeId}/intake/{id})
                 ↓
              Brain (polls intake collection every 3s)
                 ↓ classify
              Cortex → JSON: { intent, route, confidence, reasoning }
                 ↓ decide
              Cortex → JSON: { action: "short_circuit", response: "..." }
                 ↓
              Firestore work envelope (primes/{primeId}/work/{id}, status=complete)
                 ↓
              Mouth (polls completed envelopes → classifies → delivers to GChat)
```

### Files Created
| File | Purpose |
|------|---------|
| `corekit/daemon/agent-brain.mjs` | Brain v3 orchestration service (585 lines) |
| `corekit/daemon/start-agent-brain` | Systemd launcher with PRIME_ID/AGENT_ID discovery |
| `corekit/daemon/agent-brain.service` | Systemd unit file (auto-restart) |
| `corekit/config/agent-registry.json` | Agent capability registry (6 agents) |

### Files Modified
| File | Change |
|------|--------|
| `corekit/daemon/agent-ears.mjs` | Replaced gateway POST with Firestore intake write |
| `corekit/daemon/agent-mouth.mjs` | Added Firestore envelope polling alongside JSONL tailing |
| `corekit/daemon/start-agent-ears` | Added PRIME_ID/AGENT_ID discovery fallbacks |
| `corekit/daemon/start-agent-mouth` | Added PRIME_ID/AGENT_ID discovery fallbacks |
| `brain/fleet/_base/SOUL.md` | Full v3 rewrite: structured JSON mode (classify + decide) |
| `infra/manifests/base.txt` | Added Brain v3 files to fleet manifest |
| `corekit/system/upgrade-corekit` | Added agent-brain.service lifecycle management |

### Deployment Fixes Log

These are issues discovered during the first deployment to Stan. They are already fixed but documented here for future reference:

| # | Issue | Root Cause | Fix | Commit |
|---|-------|-----------|-----|--------|
| 1 | Firestore query 400 | Missing composite index on `intake(status, created_at)` | `gcloud firestore indexes composite create` | — |
| 2 | PRIME_ID empty | `chat-config.json` has no `primeId` for fleet agents | Docker env fallback: `docker exec openclaw-gateway printenv PRIME_ID` | v17.4 |
| 3 | AGENT_ID = "agent" | `chat-config.json` has no `agentId` for fleet agents | Hostname derivation: `fleet-stan` → `stan` | v17.4 |
| 4 | Gateway token not found | Token file not in Docker container | Read from `openclaw.json` config + env var fallback | v17.3 |
| 5 | Brain query wrong scope | `runQuery` URL was database root | Changed to `{parent}:runQuery` | v17.5 |
| 6 | Brain log not writable | Node user can't write `/var/log/` in Docker | Moved to `/tmp/agent-brain.log` | v17.7 |

### End-to-End Test Results

**Test:** User sends "who are you?" to Stan via Google Chat (2026-05-18 23:08 UTC)

#### Brain Log Trace
```
23:08:22 ▸ Processing intake: i-1779145701530-jm4hhq from gchat
23:08:22 ▸ Calling Cortex: mode=classify
23:08:32 ▸ Cortex response: role=assistant, content_type=string
           intent=short_circuit, route=cortex, confidence=1.0
           reasoning="The user is asking for the agent's identity..."
23:08:32 ▸ Created envelope: w-1779145712469-b4cdc023 (type=T)
23:08:32 ▸ Calling Cortex: mode=decide
23:08:40 ▸ Cortex response: action=short_circuit
           response="I am Devops Agent Stan, a GCP DevOps specialist..."
23:08:40 ▸ Envelope w-1779145712469-b4cdc023 complete (short_circuit) ✅
```

#### Firestore Verification
- `primes/chucknorris/intake/i-1779145701530-jm4hhq` → status=`claimed` ✅
- `primes/chucknorris/work/w-1779145712469-b4cdc023` → status=`complete`, output="I am Devops Agent Stan..." ✅

#### GChat Delivery
- Response delivered to Google Chat ✅
- Single response, no duplicates ✅
- Response quality equivalent to v2 ✅

### Architecture Decisions

1. **No feature flags** — We went with direct rip-and-replace instead of the originally planned `BRAIN_V3_EARS_MODE`/`BRAIN_V3_MOUTH_MODE` flags. Stan is the crash test dummy; we don't need gradual rollout on him.
2. **Dual delivery (temporary)** — Mouth still runs the v2 JSONL tailer alongside v3 envelope polling. This means responses currently deliver via the v2 path (Brain's Cortex call creates a gateway session → Mouth tails it). The v3 envelope path also completes but Mouth may or may not pick it up depending on timing. This will be resolved in Phase 2.
3. **PRIME_ID discovery** — Fleet agents get PRIME_ID from the Docker container's env (set during fleet-bootstrap), not from `chat-config.json`. This pattern was applied to all three launcher scripts.
4. **Log to /tmp/** — Brain logs go to `/tmp/agent-brain.log` inside the Docker container because the `node` user can't write to `/var/log/`. This is fine since logs also go to stdout (journald via systemd).

### Commits
- `v2026.05.18.17.1` — Brain v3 ears + mouth rewire
- `v2026.05.18.17.2` — Fix start-agent-brain PRIME_ID/AGENT_ID discovery
- `v2026.05.18.17.3` — Fix brain gateway token discovery
- `v2026.05.18.17.4` — Fix PRIME_ID/AGENT_ID in all three daemon launchers
- `v2026.05.18.17.5` — Fix brain firestoreQuery URL for scoped queries
- `v2026.05.18.17.6` — Add debug logging for cortex response format
- `v2026.05.18.17.7` — Move brain log to /tmp/
