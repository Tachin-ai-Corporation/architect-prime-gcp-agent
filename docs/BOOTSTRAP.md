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
| 2 | Install Docker CE via `get.docker.com` | ~60s |
| 3 | Install CoreKit via `install.sh --role prime` | ~15s |
| 4 | Clone OpenClaw repo, checkout stable commit (v2026.4.19) | ~10s |
| 5 | `DOCKER_BUILDKIT=1 docker build -t openclaw:local .` | ~8 min |
| 6 | Start OpenClaw container (`--network host`) | ~5s |
| 7 | Wait for gateway readiness (poll `config.get`) | ~5-120s |
| 8 | Harden container permissions | ~2s |
| 9 | Render bootstrap config template | ~1s |
| 10 | Apply config via RPC (`config.apply` + baseHash retry) | ~15-60s |
| 11 | Post-apply hardening + inject Docker CLI | ~5s |
| 12 | Vertex AI ADC + model discovery + config validation | ~10s |
| 13 | Write `prime-config.json` + identity lockfile | ~1s |
| 14 | Install `agent-ears` + `agent-mouth` + `agent-brain` as systemd services | ~2s |

**Total: ~12-15 minutes from VM creation to `PRIME VM SETUP COMPLETE`**

## VM Specifications

| Setting | Value |
|---------|-------|
| Machine type | e2-medium (2 vCPU, 4GB RAM) |
| Image | Ubuntu 22.04 LTS |
| Disk | 50GB pd-balanced |
| Gateway port | 18789 (loopback only) |
| Docker network | host |
| OpenClaw config | `/opt/openclaw/.openclaw/openclaw.json` |

## Monitoring Boot Progress

```bash
# Watch startup logs via serial port
gcloud compute instances get-serial-port-output prime-<name> \
  --zone=us-central1-a --project=<project>

# Look for these milestones
grep "startup-script:" ... | grep "==>"
# ==> Prime VM Bootstrap: ...
# ==> Installing system packages...
# ==> Installing Docker CE...
# ==> Installing CoreKit...
# ==> Cloning OpenClaw repo...
# ==> Building Docker image openclaw:local ...
# ==> Starting OpenClaw container...
# ==> Waiting for OpenClaw gateway...
# ==> Gateway is ready
# ==> Rendering bootstrap config...
# ==> Applying config via RPC...
# ==> Post-apply hardening...
# ==> Starting agent-ears + agent-mouth + agent-brain...
#   PRIME VM SETUP COMPLETE
```

## SSH into a Running Prime

```bash
gcloud compute ssh prime-<name> --zone=us-central1-a --project=<project>

# Check OpenClaw container
sudo docker ps
sudo docker logs openclaw-gateway --tail 50

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
ls -la /opt/openclaw/.openclaw/bin/
cat /opt/openclaw/.openclaw/corekit/prime-config.json
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
| `corekit/config/openclaw-bootstrap.json5.tmpl` | OpenClaw config template |
| `corekit/daemon/agent-ears.mjs` | Deterministic input processing |
| `corekit/daemon/agent-mouth.mjs` | Output classification + delivery |
| `corekit/daemon/agent-brain.mjs` | Brain v3 orchestration daemon |
| `corekit/daemon/agent-brain.service` | Systemd unit for brain daemon |
| `infra/install.sh` | CoreKit manifest installer |
| `infra/manifests/base.txt` | Repo path → VM path mapping |
