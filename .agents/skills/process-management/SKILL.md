---
name: process-management
description: "Deterministic process definitions. Motor tool `process-manage` for CRUD. Processes stored in Firestore `primes/{primeId}/processes/` collection. Cortex invokes via `follow_process` action."
---
# Process Management System

## Overview
Processes are deterministic step sequences stored in Firestore (`primes/{primeId}/processes/` collection). When Cortex decides to follow a process, the brain daemon hands execution to a deterministic executor that walks the steps exactly as defined — no improvisation.

## Tool Reference: `process-manage`

```
process-manage list                    # List all processes (id, name, status, version, created_by)
process-manage get <id>                # Get full process details as JSON
process-manage create '<json>'         # Create new process (requires: id, name, description, steps)
process-manage update '<id>' '<json>'  # Deep-merge update (steps, parameters, contextTemplate)
process-manage deprecate '<id>'        # Set status to 'deprecated'
```

## Process Document Schema
Key fields: `id`, `name`, `description`, `steps` (array), `parameters`, `contextTemplate`, `status`, `version`, `changelog`

Defaults on create: `status='active'`, `version=1`, `created_at=now`, `updated_at=now`, `created_by='system'`, `execution_count=0`, `visibility='team'`, `parameters={}`, `contextTemplate={}`, `changelog=[]`

Update auto-increments `version` and appends to `changelog`.

## Step Schema
Each step object in the `steps` array:
- `title` (required): Step name
- `description` (required): What the step does
- `agent` (default: `"motor"`): Which organ executes
- `type`: `standard` | `delegation` | `spawn_responsibility` | `approval_gate`
- `optional` (default: false): Whether the step can be skipped
- `checkpointBoundary` (default: false): Whether this step ends a checkpoint
- `contextTemplate`: Step-specific context map

## Cortex Integration
Cortex uses the `follow_process` action with a `processId`. The brain daemon takes over and walks each step deterministically. The process defines the exact steps — Cortex chooses *which* process, the executor owns *how* it runs.

## Examples
```bash
# Create a process
process-manage create '{"id": "deploy-cloud-run", "name": "Cloud Run Deploy", "description": "Standard deploy to Cloud Run", "steps": [{"title": "Build image", "description": "Build and push container image", "agent": "motor", "type": "standard"}, {"title": "Deploy service", "description": "Deploy image to Cloud Run", "agent": "motor", "type": "standard", "checkpointBoundary": true}]}'

# List all processes
process-manage list
```
