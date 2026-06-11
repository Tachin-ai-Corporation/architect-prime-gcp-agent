# Bootstrap Guide — Architect Prime

How Prime and Fleet VMs deploy and boot.

## How It Works

The dashboard deploy API creates a GCE VM with a tiny **boot stub** as the startup script. The boot stub:

1. Reads `core_ref`, `gh_owner`, `gh_repo` from VM metadata
2. Downloads `infra/bootstrap/prime-bootstrap.sh` from GitHub
3. Runs it

All complexity is in `prime-bootstrap.sh` — a standalone bash script with no JS escaping issues.

## What prime-bootstrap.sh Does

| Step | Description | Duration |
|------|-------------|----------|
| 1 | Install system packages (curl, git, python3, jq) | ~30s |
| 2 | Install Node.js & npm on the GCE VM host | ~60s |
| 3 | Install CoreKit via `install.sh --role prime` | ~15s |
| 4 | Run `npm install` on the host directory `/opt/corekit/corekit/brain` | ~30s |
| 5 | Generate agent configuration `config.json` files | ~2s |
| 6 | Vertex AI model discovery + config validation | ~10s |
| 7 | Write `prime-config.json` + identity lockfile | ~1s |
| 8 | Write, enable and start `agent-brain-gateway` systemd service | ~2s |
| 9 | Install and start `agent-ears` + `agent-mouth` + `agent-brain` + `agent-introspect` services | ~2s |

**Total: ~3-5 minutes from VM creation to `PRIME VM SETUP COMPLETE`**

## VM Specifications

| Setting | Value |
|---------|-------|
| Machine type | e2-medium (2 vCPU, 4GB RAM) |
| Image | Ubuntu 22.04 LTS |
| Disk | 50GB pd-balanced |
| Gateway port | Per `gateway.port` in `contracts.json` (loopback only) |
| CoreKit directory | `/opt/corekit` |

## Monitoring Boot Progress

```bash
# Watch startup logs via serial port
gcloud compute instances get-serial-port-output prime-<name> \
  --zone=us-central1-a --project=<project>

# Look for these milestones
grep "startup-script:" ... | grep "==>"
# ==> Prime VM Bootstrap: ...
# ==> Installing system packages...
# ==> Installing Node.js & npm...
# ==> Installing CoreKit...
# ==> Running npm install...
# ==> Starting agent-brain-gateway...
# ==> Starting agent-ears + agent-mouth + agent-brain + agent-introspect...
#   PRIME VM SETUP COMPLETE
```

## SSH into a Running Prime

```bash
gcloud compute ssh prime-<name> --zone=us-central1-a --project=<project>

# Check agent-brain-gateway service
sudo systemctl status agent-brain-gateway
sudo journalctl -u agent-brain-gateway --no-pager -n 50

# Check agent-ears
sudo systemctl status agent-ears
sudo tail -20 /var/log/agent-ears.log

# Check agent-mouth
sudo systemctl status agent-mouth
sudo tail -20 /var/log/agent-mouth.log

# Check agent-brain (Brain v3 orchestration daemon)
sudo systemctl status agent-brain
sudo journalctl -u agent-brain --no-pager -n 20

# Check CoreKit files
ls -la /opt/corekit/bin/
cat /opt/corekit/corekit/prime-config.json
```

## Iterating on the Bootstrap

To modify the bootstrap:
1. Edit `infra/bootstrap/prime-bootstrap.sh`
2. `git push origin main`
3. Delete the existing VM and redeploy from the dashboard

**No Cloud Run rebuild is needed.** The boot stub downloads the latest `prime-bootstrap.sh` from GitHub at boot time.

## Key Files

| File | Purpose |
|------|---------|
| `infra/bootstrap/prime-bootstrap.sh` | Full VM setup script (standalone bash) |
| `app/src/app/api/primes/[id]/deploy/route.ts` | Deploy API with boot stub |
| `corekit/brain/index.mjs` | Node.js native brain gateway |
| `corekit/daemon/agent-ears.mjs` | Deterministic input processing |
| `corekit/daemon/agent-mouth.mjs` | Output classification + delivery |
| `corekit/daemon/agent-brain.mjs` | Brain v3 orchestration daemon |
| `corekit/daemon/agent-brain.service` | Systemd unit for brain daemon |
| `infra/install.sh` | CoreKit manifest installer |
| `infra/manifests/base.txt` | Repo path → VM path mapping |
