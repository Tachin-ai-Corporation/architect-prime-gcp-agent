# Brain v3 — Implementation roadmap

> **Test target:** Fleet agent Stan (DevOps specialist)
> **Approach:** Phased, each phase independently deployable and rollbackable
> **Prerequisite:** Read `00-CORE-CONCEPTS.md` first

---

## Phase overview

| Phase | Name | Goal | Key deliverable |
|-------|------|------|-----------------|
| 1 | Foundation | Firestore schema + Brain skeleton. Prove Ears → Firestore → Brain → Mouth pipeline with short_circuit. | `agent-brain.mjs` handling simple messages |
| 2 | Cortex loop | Single-step dispatch. Cortex decides, Brain dispatches one agent, Cortex synthesizes. | Working dispatch → synthesize cycle |
| 3 | Memory + discovery | Hardwired memory recall/write. Active envelope scan. Follow-up detection. | Memory-enriched Cortex decisions, `attach` classification |
| 4 | Multi-step planning | Cortex returns multi-step plans. Brain executes sequentially. Cerebellum verifies. | Pipeline execution with verification |
| 5 | Planning iteration | Advisory rounds. Cortex iterates (research, then plan). Prefrontal for complex decomposition. | Iterative planning before execution |
| 6 | Delegation + dashboard | Inter-agent envelope delegation. R/C/M/T dashboard tree. Human-in-the-loop. | Fleet coordination via Firestore, operational visibility |
| 7 | Responsibilities + rollout | Cron scheduler in Brain. Self-managed Responsibilities. Prime deployment. Fleet-wide rollout. | Full R/C/M/T lifecycle, deprecated code removed |

---

## Dependency chain

```
Phase 1 (Foundation)
  └─► Phase 2 (Cortex loop)
        └─► Phase 3 (Memory + discovery)
              └─► Phase 4 (Multi-step planning)
                    └─► Phase 5 (Planning iteration)
                          └─► Phase 6 (Delegation + dashboard)
                                └─► Phase 7 (Responsibilities + rollout)
```

Each phase builds on the previous. However, each phase is independently testable on Stan — Stan remains functional (at progressively increasing capability) throughout.

---

## Rollback strategy

Feature flags in environment:
```
BRAIN_V3_ENABLED=true|false         # Master toggle
BRAIN_V3_EARS_MODE=intake|gateway   # Ears: Firestore intake or direct gateway POST
BRAIN_V3_MOUTH_MODE=firestore|jsonl # Mouth: Firestore envelope or JSONL tailing
```

If any phase introduces a regression, toggle flags to revert to the v2 architecture. Brain service runs alongside the existing path — it doesn't replace anything until Phase 7 cleanup.

---

## Per-phase implementation docs

Each phase has its own detailed implementation document:

- `02-PHASE-1-FOUNDATION.md` — Firestore schema, Brain skeleton, Ears/Mouth rewire
- `03-PHASE-2-CORTEX-LOOP.md` — Cortex decision format, dispatch cycle, response parsing
- `04-PHASE-3-MEMORY-DISCOVERY.md` — Memory integration, envelope discovery, classify attach
- `05-PHASE-4-MULTI-STEP.md` — Plan action, sequential execution, Cerebellum verification
- `06-PHASE-5-PLANNING-ITERATION.md` — Advisory rounds, Prefrontal delegation, iterative planning
- `07-PHASE-6-DELEGATION-DASHBOARD.md` — Inter-agent delegation, R/C/M/T dashboard, human-in-the-loop
- `08-PHASE-7-RESPONSIBILITIES-ROLLOUT.md` — Cron scheduler, self-management, Prime deployment, deprecated code removal

---

## What changes per component

| Component | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 |
|-----------|---------|---------|---------|---------|---------|---------|---------|
| **Ears** | Write intake to Firestore | — | — | — | — | — | Remove gateway POST code |
| **Brain** | Skeleton + short_circuit | Cortex loop + dispatch | Memory hardwire + envelope scan | Plan action + sequential exec | Iterative planning | Delegation + waiting | Responsibility scheduler |
| **Mouth** | Read from Firestore | — | — | — | — | needs_input delivery | — |
| **Cortex SOUL** | classify + short_circuit | dispatch + synthesize | Memory-aware decisions | plan action | Advisory decisions | delegate action | Responsibility tools |
| **Firestore** | intake/ + work/ + indexes | — | — | — | — | Dashboard queries | — |
| **Agent registry** | Schema + Stan's agents | — | — | Cerebellum added | Prefrontal added | — | Fleet-wide registries |
| **Dashboard** | — | — | — | — | — | R/C/M/T tree view | Responsibility view |
| **OpenClaw config** | Validate agent routes | Session strategy | — | — | — | — | Cleanup sessions_spawn |
