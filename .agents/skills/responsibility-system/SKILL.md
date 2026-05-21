---
name: responsibility-system
description: "Responsibility assignment and tracking. JSON config files with cron expressions, managed by Brain daemon cron scheduler. Motor tool `responsibility-manage` for CRUD."
---
# Responsibility System (LIVE)

## Overview
Responsibilities are recurring automated tasks defined as JSON config files with cron expressions. The Brain daemon's cron scheduler processes these files and creates R→M (Responsibility→Mission) envelopes to trigger execution.

## Envelope Hierarchy
Responsibilities sit at the top of the R→M→C→T envelope hierarchy:
- **R (Responsibility)** — Cron-scheduled recurring task definition
- **M (Mission)** — A single execution instance spawned by the responsibility
- **C (Checkpoint)** — Sub-steps within a mission
- **T (Task)** — Atomic work units within a checkpoint

## Key Components
- **Config files**: `responsibilities.json` — defines responsibility entries with cron expressions
- **Brain daemon cron scheduler**: Evaluates cron expressions and creates R-type envelopes at trigger time
- **Motor tool `responsibility-manage`**: CRUD operations for responsibility configs (create, read, update, delete)

## How It Works
1. Responsibility configs define `name`, `description`, `cron` expression, and `steps`
2. Brain daemon evaluates cron schedules continuously
3. When a cron fires, Brain creates an R-type envelope containing an M-type mission envelope
4. Cortex processes the mission through the standard decide loop
5. Work flows through the C→T hierarchy as Prefrontal plans and Motor executes

Reference: `docs/architecture/RESPONSIBILITIES_CHECKPOINTS_MISSIONS.md` (Section 1)
