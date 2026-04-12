# Legacy Bootstrap Scripts

> **Status:** DEPRECATED — Superseded as of v2.0 (2026-04-01)
> **Retained for:** Historical reference only. Do not execute.

These scripts were the original bootstrap path before the v2.0 architecture:

| Script | Original Purpose | Replaced By |
|--------|-----------------|-------------|
| `bootstrap-interactive.sh` | Interactive guided bootstrap (Cloud Shell) | `deploy/install.sh` (dashboard) + `bootstrap/prime-bootstrap.sh` (VM) |
| `oneshot-cloudshell.sh` | One-line Cloud Shell bootstrap | `deploy/install.sh` |
| `phase1-cloudshell.sh` | GCP project setup (APIs, SAs, VM creation) | `deploy/install.sh` |
| `phase2-vm.sh` | VM self-setup (CoreKit, Docker, agent) | `bootstrap/prime-bootstrap.sh` |
| `env.example` | Environment variable reference | VM metadata attributes |
| `test-chat.sh` | Chat API smoke test | Manual verification via Chat |
| `test-endpoints.sh` | Endpoint smoke test | Manual verification |
| `test-checkpoint.ps1` | PowerShell E2E test harness | Manual verification |
| `vm-diagnostic.sh` | VM diagnostic script | `gcloud compute ssh` + `journalctl` |

## Current Bootstrap Architecture (v2.0)

```
deploy/install.sh                     → Deploys Cloud Run dashboard + Firestore + DWD
  ↓ user clicks "Deploy Prime"
app/src/app/api/primes/[id]/deploy/   → Creates GCE VM with boot stub
  ↓ boot stub curls from GitHub
bootstrap/prime-bootstrap.sh          → Full Prime VM setup (Docker, CoreKit, OpenClaw)

fleet-deploy (on Prime VM)            → Creates fleet VM with boot stub
  ↓ boot stub curls from GitHub
bootstrap/fleet-bootstrap.sh          → Full fleet agent setup (Docker, CoreKit, OpenClaw)
```
