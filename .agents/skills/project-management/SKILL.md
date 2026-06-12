---
name: project-management
description: "Project lifecycle management. Motor tool `project-manage` for CRUD, team members, and context tracking. Projects stored in Firestore `projects/` collection."
---
# Project Management System

## Overview
Projects are Firestore documents (`projects/` collection) that track work initiatives, team members, and shared context. Motor uses `project-manage` to manage them.

## Tool Reference: `project-manage`

```
project-manage list                                    # List all projects
project-manage get <id>                                # Full project JSON
project-manage create '<json>'                         # Create (requires: id, name, description, context, goal)
project-manage update '<id>' '<json>'                  # Deep-merge update
project-manage complete '<id>'                         # Mark completed
project-manage pause '<id>'                            # Mark paused
project-manage archive '<id>'                          # Mark archived
project-manage team-add <id> <email> <role> [name] [type]  # Add team member (simple)
project-manage team-add <id> '<json>'                  # Add team member (JSON)
project-manage team-remove <id> <email>                # Remove team member
project-manage team-list <id>                          # List team members
```

## Team Member Schema
```json
{"email": "agent@tachin.ag", "role": "engineer", "name": "Bobby", "type": "agent"}
```
- `email` (required): Agent or human email
- `role` (required, free-form): e.g. engineer, architect, owner, pm
- `name` (optional): Display name
- `type` (optional, default: agent): `agent` or `human`

## Project Document Schema
Key fields: `id`, `name`, `description`, `goal`, `status`, `owner`, `context`, `team`, `standardProcesses`, `created_at`, `updated_at`

Status lifecycle: `active` → `completed` | `paused` | `archived`

## Context Packet
The `context` field is a map of key-value pairs for shared project knowledge. Each key maps to an object with:
- `kind`: `sheet` | `drive_folder` | `doc` | `dataset` | `url` | `template` | `people` | `convention`
- `ref`, `url`, `name`, `summary`

## Cortex Integration
Cortex sees project context in every decide call. Uses team members to identify delegation targets. Should dispatch motor with `project-manage update` to persist discovered knowledge.

## Examples
```bash
# Add a team member (simple args)
project-manage team-add proj-self-improvement swe-agent-bobby@tachin.ag engineer Bobby agent

# List team members
project-manage team-list proj-self-improvement

# Update project context (deep-merge)
project-manage update proj-self-improvement '{"context": {"deploy_target": {"kind": "convention", "summary": "Deploy to us-central1"}}}'
```
