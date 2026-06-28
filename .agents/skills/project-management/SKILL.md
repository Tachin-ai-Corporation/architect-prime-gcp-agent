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
{"email": "agent@example.com", "role": "engineer", "name": "Bobby", "type": "agent"}
```
- `email` (required): Agent or human email
- `role` (required, free-form): e.g. engineer, architect, owner, pm
- `name` (optional): Display name
- `type` (optional, default: agent): `agent` or `human`

## Project Document Schema
Key fields: `id`, `name`, `description`, `goal`, `status`, `owner`, `gchat_space_id`, `context`, `canon`, `team`, `standardProcesses`, `created_at`, `updated_at`

- `owner` (string, email): Project owner for escalation. Defaults to creator. Should be a human.
- `gchat_space_id` (string): Primary GChat space ID for project communications (e.g. `AAQAXN-eJIQ`)

Status lifecycle: `active` → `completed` | `paused` | `archived`

## Canon (Authoritative Project Facts)
The `canon` field contains **authoritative facts** about a project that are:
- **Always injected first** in all project context (before description, team, context packet)
- **Prominently labeled** so LLMs treat them as ground truth
- **Authority-protected**: only users in the `canon.authority` list can modify them

```
project-manage canon-set <id> <key> <text...>              # Set/update a canon entry
project-manage canon-list <id>                              # List all canon entries
project-manage canon-remove <id> <key>                      # Remove a canon entry
project-manage canon-authority <id> <email1> [email2...]    # Set authority list
```

### Canon Schema
```json
{
  "canon": {
    "authority": ["owner@example.com", "agent@example.com"],
    "entries": [
      { "key": "architecture", "text": "The main website is at the root, not /public", "updated_by": "owner@example.com" }
    ]
  }
}
```

Use canon for critical project truths that agents must never contradict: architecture decisions, deployment rules, file layout, naming conventions.

## Context Packet
The `context` field is a map of key-value pairs for shared project knowledge. Each key maps to an object with:
- `kind`: `sheet` | `drive_folder` | `doc` | `dataset` | `url` | `template` | `people` | `convention`
- `ref`, `url`, `name`, `summary`

## Cortex Integration
Cortex sees project context in every decide call. Canon entries appear FIRST with a prominent header. Uses team members to identify delegation targets. Dispatch motor to persist discovered knowledge back to the project.

## Examples
```bash
# Set a canon entry (authoritative fact)
project-manage canon-set your-website-project architecture The main website is index.html at the root. NOT in /public.

# Add a team member (simple args)
project-manage team-add proj-self-improvement swe-agent-bobby@example.com engineer Bobby agent

# List team members
project-manage team-list proj-self-improvement

# Update project context (deep-merge)
project-manage update proj-self-improvement '{"context": {"deploy_target": {"kind": "convention", "summary": "Deploy to us-central1"}}}'
```

### ⚠️ Shell Escaping Rules
The JSON argument must be wrapped in **single quotes**. Inside the JSON, use **only double quotes**:
```bash
# ✅ CORRECT — single quotes around JSON, double quotes inside
project-manage update my-project '{"context": {"key": {"kind": "convention", "summary": "value here"}}}'

# ❌ WRONG — special characters like arrows, parentheses break shell parsing
project-manage update my-project '{"context": {"info": "value (with parens) → arrows"}}'
```
**Avoid** these characters in JSON string values: `→`, `()`, `\`, backticks. Use plain ASCII: `to`, `for`, dashes instead.

