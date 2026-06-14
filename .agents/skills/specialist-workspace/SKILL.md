---
name: specialist-workspace
description: "Creating specialty workspace files for fleet agent types. 8 specialties defined in agent-types.json with workspace files under specialties/<type>/workspace/."
---
# Specialty Workspace Authoring (LIVE)

## Overview
Fleet agents are specialized via workspace files that define their identity, capabilities, and behavior for a given role. Brain sub-agents are live (6 agents: cortex, temporal-research, temporal-memory, prefrontal, motor, cerebellum).

## Available Specialties
Defined in `corekit/config/agent-types.json`:
- `assistant` — Executive Assistant (scheduling, communications, admin)
- `data` — Data Engineer (BigQuery, ETL, pipelines, analytics)
- `devops` — DevOps Engineer (GCP infra, CI/CD, Terraform, monitoring)
- `engineer` — Software Engineer (full-stack, code review, API design)
- `finance` — Finance Analyst (budgets, cost analysis, forecasting)
- `pm` — Project Manager (planning, tracking, stakeholder coordination)
- `qa` — QA Engineer (test planning, automation, quality gates)
- `security` — Security Engineer (IAM audit, compliance, vulnerability assessment)

## Workspace Locations
- **Specialty workspaces**: `specialties/<type>/workspace/` — type-specific SOUL.md, IDENTITY.md, MEMORY.md
- **Fleet base template**: `brain/fleet/_base/` — generic fallback using `{{AGENT_NAME}}`, `{{SPECIALTY}}` template vars
- **Fleet brain sub-agents**: `brain/fleet/_brain/{cortex,prefrontal,motor,cerebellum,temporal-research,temporal-memory}/`

## Creating a New Specialty
1. Create directory: `specialties/<type>/workspace/`
2. Add workspace files: SOUL.md, IDENTITY.md, MEMORY.md
3. Register the specialty in `corekit/config/agent-types.json`
4. Specialty workspace files override `brain/fleet/_base/` defaults at install time
