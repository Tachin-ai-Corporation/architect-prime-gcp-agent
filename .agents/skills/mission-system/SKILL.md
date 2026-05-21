---
name: mission-system
description: "Mission lifecycle management. M-type envelopes in the Brain v3 envelope hierarchy, spawned from responsibilities or ad-hoc inputs."
---
# Mission System (LIVE)

## Overview
Missions are M-type envelopes in the Brain v3 R→M→C→T envelope hierarchy. They represent a discrete unit of work — either spawned from a Responsibility's cron trigger or created ad-hoc from user/system input.

## Envelope Position
```
R (Responsibility) → M (Mission) → C (Checkpoint) → T (Task)
```
- Missions are created inside R-type (Responsibility) envelopes for scheduled work
- Missions can also be created directly for ad-hoc requests (user messages, system events)
- Each mission contains one or more C-type (Checkpoint) envelopes

## Mission Lifecycle
1. **Creation**: Brain daemon creates an M-type envelope (from R-type cron trigger or intake pipeline)
2. **Classification**: Cortex classifies the mission intent and decides the approach
3. **Planning**: For complex missions, Prefrontal creates a checkpoint plan (C-type sub-steps)
4. **Execution**: Checkpoints are processed sequentially — tasks dispatched to Motor
5. **Verification**: Cerebellum evaluates results against acceptance criteria
6. **Synthesis**: Cortex synthesizes final results and marks the mission complete
7. **Delivery**: `agent-mouth` detects the completed envelope and delivers the response

## Key Concepts
- **Ad-hoc missions**: Created from user messages via `agent-ears` → Firestore intake → Brain daemon
- **Scheduled missions**: Created from R-type responsibility cron triggers
- **Simple vs complex**: Simple missions may short-circuit directly; complex ones get checkpoint plans

Reference: `docs/architecture/RESPONSIBILITIES_CHECKPOINTS_MISSIONS.md` (Section 3)
