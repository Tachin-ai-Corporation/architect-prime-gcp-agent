---
name: checkpoint-system
description: "Checkpoint management within Brain v3 envelope hierarchy. C-type envelopes nested inside M-type mission envelopes, planned by Prefrontal."
---
# Checkpoint System (LIVE)

## Overview
Checkpoints are C-type envelopes in the Brain v3 R→M→C→T envelope hierarchy. They represent discrete sub-steps within a Mission, planned by the Prefrontal agent and tracked by the Brain daemon state machine.

## Envelope Position
```
R (Responsibility) → M (Mission) → C (Checkpoint) → T (Task)
```
- Checkpoints live inside M-type (Mission) envelopes
- Each checkpoint contains one or more T-type (Task) envelopes
- Checkpoints are processed sequentially by the Brain daemon

## How Checkpoints Work
1. **Planning**: Prefrontal decomposes a mission into a checkpoint plan (ordered list of C-type sub-steps)
2. **Creation**: Brain daemon creates C-type envelopes inside the parent M-type envelope
3. **Execution**: Each checkpoint is processed in order — Cortex dispatches tasks to Motor for execution
4. **Verification**: Cerebellum verifies checkpoint completion with PASS/FAIL verdicts
5. **Progression**: Brain daemon advances to the next checkpoint on PASS, or handles retry/escalation on FAIL

## Key Concepts
- **Checkpoint plan**: Prefrontal's structured output defining the ordered list of checkpoints
- **Sequential processing**: Checkpoints execute in order — a checkpoint must complete before the next begins
- **Task decomposition**: Each checkpoint can contain multiple atomic tasks (T-type envelopes)

Reference: `docs/CULTURE_OF_WORK.md` (Section 2)
