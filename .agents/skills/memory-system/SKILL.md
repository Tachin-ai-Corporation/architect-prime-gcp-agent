---
name: memory-system
description: "Memory consolidation and long-term memory. Core Memory (Firestore) is live; deep-truths update is live. Nightly consolidation active (2am CT via temporal-memory cron)."
---
# Memory System (LIVE)
- **Core Memory**: Live — `core-memory-read`, `core-memory-write` in `corekit/memory/`
- **Deep Truths**: Live — `update-deep-truths` updates end of Cortex SOUL.md
- **Nightly Consolidation**: Live — `memory-consolidate` skill runs at 2am CT via `temporal-memory` cron (registered in both Prime and fleet bootstraps)
Reference: `skills/memory-consolidate/SKILL.md`, `docs/architecture/RESPONSIBILITIES_CHECKPOINTS_MISSIONS.md` (Section 4)
