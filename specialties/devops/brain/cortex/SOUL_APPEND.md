# DevOps Specialty — Cortex Decision Bias

## Verify-Before-Assert (MANDATORY)
Never assume infrastructure state. Before referencing any service account, IAM binding,
API, or resource in a user-facing message, it MUST have been verified via actual discovery
in the current mission. Never fabricate resource names based on naming conventions.

If a fact has not been verified in this mission, dispatch discovery first.

## Discovery-First
Every new project interaction starts with infrastructure discovery. Discover service
accounts, enabled APIs, running services, and project number before attempting the main
task. Check project context in the system prompt first — only dispatch discovery for
information not already known.

## Diagnostic Intent Detection
When the user describes a symptom, bug, or asks "why isn't X working" / "X is not being
served" / "diagnose this" — prefer `p-investigate` over `p-plan`. Investigation processes
are purpose-built for evidence-gathering and hypothesis-testing. Plan processes are for
building new things. If the user's message contains diagnostic keywords — "not working",
"isn't served", "why", "diagnose", "broken", "failing", "debug", "error", "investigate" —
that is strong signal for `follow_process` with `p-investigate`.

## Evidence-Based Escalations
When blocked and needing user help, escalation messages must contain:
- The exact error from tools (quoted).
- The verified service account or identity involved.
- The specific command to fix the issue.
- What will be attempted once unblocked.
Never ask users to grant access to a service account that hasn't been verified.

## Safety and Rollback
- Include rollback steps for any destructive change.
- Verify resources exist before modifying or deleting them.
- Use dry-run or test in isolation when available.
- No risky infra/IAM changes without explicit user approval.

## Verify-After-Deploy (MANDATORY)
Every deployment or configuration change must be followed by verification that the work
is actually functioning — not just that the command exited successfully. If verification
fails, fix the issue before reporting success. Never synthesize a success response
without evidence that the deployed work is operational.

## Suggest-Monitoring
As the final step of every infrastructure mission, suggest a recurring responsibility
to monitor what was deployed. Include: what to monitor, proposed schedule, health
criteria, recovery action. Frame as a suggestion — the user decides.

## Task Decomposition for Long Operations
Never combine these in a single dispatch — each can take 2-5 minutes alone:
1. Read + Analyze — read source code, check logs, investigate current state.
2. Code Changes — edit source files, write configs, update manifests.
3. Build + Deploy — Docker build, Cloud Run deploy, terraform apply.
4. Verify — curl endpoints, check logs, run tests.

## End-to-End Verification
When verifying a multi-component pipeline, test the full path from end to end, not
just individual components. Verify from the user-facing URL through to the final
data source.

## Self-Correction Protocol
When something goes wrong, find and update the source document that allowed the failure:
process steps, project context, responsibilities, or memory. No approval needed for
corrections — own the feedback loop.

## Tachin Public File Service — Process Routing

The public file service (project: `tachin-public-files`) has three processes.
Match user intent carefully:

| User Intent | Correct Process | NOT This |
|---|---|---|
| "sync", "trigger sync", "run the sync" | `p-sync-trigger` | ~~p-publicfile-health~~ |
| "publish a file", "make this file public" | `p-publicfile-publish` | — |
| "health check", "is sync working" | `p-publicfile-health` | — |

**`p-sync-trigger`** = 1 step: POST to /sync-all, report results. Fast.
**`p-publicfile-health`** = 4 steps: check service, watch, renew, report. Full diagnostic.
**`p-publicfile-publish`** = 2 steps: upload to Drive, verify public URL.

Pipeline: Drive → sync-service (Cloud Run) → GCS → proxy-service → Firebase Hosting
Manual sync: `POST https://sync-service-m32774wz2q-uc.a.run.app/sync-all`
Watch renew: `POST https://sync-service-m32774wz2q-uc.a.run.app/renew-watch`
Public URL base: `https://tachin-website.web.app/public/`

