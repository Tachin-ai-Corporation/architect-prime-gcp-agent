#!/usr/bin/env bash
# ============================================================
# prime-bootstrap.sh — Prime VM setup (Docker-based OpenClaw)
#
# Downloaded and executed by the deploy API's boot stub.
# All config is read from VM metadata attributes.
#
# Proven pattern from phase2-vm.sh:
#   1. Install system packages + Docker CE
#   2. Install CoreKit via manifest (install.sh)
#   3. Clone OpenClaw repo, build Docker image
#   4. Run OpenClaw container (--network host)
#   5. Wait for gateway readiness
#   6. Render + apply bootstrap config via RPC (retry/baseHash)
#   7. Container hardening + Docker CLI injection
#   8. Install agent-ears + agent-mouth systemd services
# ============================================================
set -euo pipefail

export HOME="${HOME:-/root}"
export USER="${USER:-$(whoami)}"

LOG_FILE="/var/log/prime-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "Log: $LOG_FILE"; exit 1' ERR

info(){ echo -e "\n==> $*\n"; }
warn(){ echo -e "\n[WARN] $*\n"; }

# ---- Read config from VM metadata ----
META="http://metadata.google.internal/computeMetadata/v1"
MH="Metadata-Flavor: Google"
PRIME_ID="$(curl -sf -H "$MH" "$META/instance/attributes/prime_id" || echo 'unknown')"
AGENT_ID="$(curl -sf -H "$MH" "$META/instance/attributes/agent_id" || echo 'prime')"
CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || echo 'main')"
GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo 'Tachin-ai-Corporation')"
GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo 'architect-prime-gcp-agent')"
GCP_PROJECT_ID="$(curl -sf -H "$MH" "$META/project/project-id")"

MY_TOKEN="$(openssl rand -hex 16)"
OC_HOST_ROOT="/opt/openclaw"
OC_HOST_DIR="${OC_HOST_ROOT}/.openclaw"
CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

info "Prime VM Bootstrap: $(date -Is)"
echo "Prime ID    : ${PRIME_ID}"
echo "Agent       : ${AGENT_ID}"
echo "CoreRef     : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "Project     : ${GCP_PROJECT_ID}"

# ============================================================
# PHASE 1 — System setup
# ============================================================

# ---- 1) Install system packages ----
info "Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git python3 ca-certificates gnupg jq openssl

# ---- 2) Install Docker CE (with BuildKit + buildx) ----
info "Installing Docker CE..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi
systemctl enable docker
systemctl start docker
DOCKER_GID="$(getent group docker | cut -d: -f3)"
[[ -n "${DOCKER_GID}" ]] || { echo "[ERROR] Could not determine docker group GID"; exit 1; }

# ---- 3) Install CoreKit via manifest (base + prime) ----
info "Installing CoreKit..."
mkdir -p "${OC_HOST_DIR}"
curl -sfL "${CORE_BASE}/infra/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
CORE_REF="${CORE_REF}" \
  GH_OWNER="${GH_OWNER}" \
  GH_REPO="${GH_REPO}" \
  OC_HOST_ROOT="${OC_HOST_ROOT}" \
  bash /tmp/install.sh --role prime

# ---- 3b) Read contracts.json for cross-cutting values ----
# ADR: contracts.json is the SINGLE SOURCE OF TRUTH for all values that appear
# in multiple files (model names, agent IDs, endpoints, OpenClaw pin, ports).
# Changing a value here propagates to .env, OC_PIN, smoke tests, etc.
# If contracts.json is missing, fallback defaults match the last known-good.
CONTRACTS="${OC_HOST_DIR}/corekit/contracts.json"
if [[ -f "$CONTRACTS" ]]; then
  C_LOCATION="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['vertex']['location'])")"
  C_OC_PIN="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['openclaw']['pin'])")"
  C_GATEWAY_PORT="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['gateway']['port'])")"
  C_GATEWAY_ROUTE="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['agents']['gatewayRoute'])")"
  info "Contracts loaded: location=${C_LOCATION} port=${C_GATEWAY_PORT} route=${C_GATEWAY_ROUTE}"
else
  warn "contracts.json not found — using defaults"
  C_LOCATION="global"
  C_OC_PIN="041266a6699cac3baef8ef39db41fa26f29f9db3"
  C_GATEWAY_PORT="18789"
  C_GATEWAY_ROUTE="openclaw/cortex"
fi

# ---- 4) Save gateway token for ears/mouth ----
# render-config (step 9) will update this with the final token;
# write it now so the old config path works if render-config fails.
mkdir -p /root/.openclaw
echo "${MY_TOKEN}" > /root/.openclaw/.gateway-token
chmod 600 /root/.openclaw/.gateway-token

# ============================================================
# PHASE 2 — OpenClaw Docker image + config
# ============================================================

# ---- 5) Clone + build OpenClaw Docker image ----
info "Cloning OpenClaw repo..."
cd /root
if [[ ! -d openclaw/.git ]]; then
  git clone https://github.com/openclaw/openclaw.git
fi
cd openclaw
git fetch --all --prune
# Pin to known-good release — read from contracts.json
STABLE_COMMIT="${C_OC_PIN}"
git checkout "${STABLE_COMMIT}"
info "Using OpenClaw commit: ${STABLE_COMMIT:0:12} (from contracts.json)"

# ADR: .env values MUST match contracts.json. Hardcoding port/location here
# caused stan's crash-loop when the Gemini 3.1 migration changed location
# to 'global' but fleet-bootstrap still had 'us-central1'. Read from contracts.
cat > .env <<EOF
GATEWAY_BIND=loopback
GATEWAY_PORT=${C_GATEWAY_PORT}
OPENCLAW_GATEWAY_TOKEN=${MY_TOKEN}
OPENCLAW_CONFIG_DIR=/home/node/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace
OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json
GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}
GCLOUD_PROJECT=${GCP_PROJECT_ID}
CLOUDSDK_CORE_PROJECT=${GCP_PROJECT_ID}
GOOGLE_GENAI_USE_VERTEXAI=True
GOOGLE_CLOUD_LOCATION=${C_LOCATION}
GCE_METADATA_HOST=metadata.google.internal
EOF

info "Building Docker image openclaw:local ..."
DOCKER_BUILDKIT=1 docker build -t openclaw:local .

# ---- 6) Run OpenClaw container ----
docker rm -f openclaw-gateway > /dev/null 2>&1 || true

info "Starting OpenClaw container..."
docker run -d \
  --name openclaw-gateway \
  --network host \
  --restart always \
  --env-file .env \
  -v "${OC_HOST_DIR}:/home/node/.openclaw" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "${DOCKER_GID}" \
  openclaw:local

# ---- 7) Wait for gateway readiness ----
# ADR: HTTP 401 from the gateway means "auth required but I'm alive" —
# this IS a healthy response. The gateway requires a Bearer token.
info "Waiting for OpenClaw gateway..."
READY=false
MAX_WAIT=180
WAITED=0
INTERVAL=5
while [[ "$WAITED" -lt "$MAX_WAIT" ]]; do
  HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    http://localhost:${C_GATEWAY_PORT}/v1/models 2>/dev/null)" || HTTP_CODE="000"
  if [[ "$HTTP_CODE" == "401" || "$HTTP_CODE" == "200" ]]; then
    READY=true
    break
  fi
  echo "  Gateway not ready yet (HTTP ${HTTP_CODE}, ${WAITED}s elapsed)..."
  sleep "$INTERVAL"
  WAITED=$((WAITED + INTERVAL))
done
[[ "$READY" == "true" ]] || { echo "[ERROR] Gateway did not become ready within ${MAX_WAIT}s"; exit 1; }
info "Gateway is ready (took ~${WAITED}s)."

# ---- 8) Harden container perms (pre-config) ----
# ADR: These permissions are INSIDE the Docker container (/home/node/.openclaw).
# They are independent from the HOST permissions at ${OC_HOST_DIR}.
# The container volume mount overlays host files into the container's filesystem.
# 700 here restricts access within the container to the 'node' user only.
info "Hardening container permissions..."
docker exec -u 0 openclaw-gateway bash -lc '
set -e
mkdir -p /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw
chmod 700 /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw/bin 2>/dev/null || true
chmod 700 /home/node/.openclaw/bin/oc 2>/dev/null || true
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
chown -R node:node /home/node/.openclaw
'

# ---- 9) Render config template via render-config ----
# render-config handles JSON5→JSON conversion, token sync from container
# env var, and writes the token file. Falls back to inline render if
# render-config isn't available yet (shouldn't happen — CoreKit installs first).
info "Rendering bootstrap config..."
RENDER="${OC_HOST_DIR}/bin/render-config"
if [[ -x "$RENDER" ]]; then
  GCP_PROJECT_ID="${GCP_PROJECT_ID}" OC_HOST_ROOT="${OC_HOST_ROOT}" "$RENDER"
else
  warn "render-config not found, using inline fallback..."
  python3 - <<PY
import pathlib
oc = pathlib.Path("${OC_HOST_DIR}")
tmpl_path = oc / "corekit" / "openclaw-bootstrap.json5.tmpl"
out_path = pathlib.Path("/tmp/openclaw-bootstrap.json5")
tmpl = tmpl_path.read_text(encoding="utf-8")
tmpl = tmpl.replace("\${GCP_PROJECT_ID}", "${GCP_PROJECT_ID}")
tmpl = tmpl.replace("\${MY_TOKEN}", "${MY_TOKEN}")
out_path.write_text(tmpl, encoding="utf-8")
print("Wrote", out_path)
PY
fi

# ---- 10) Apply config via RPC (with retry + fresh baseHash) ----
info "Applying config via RPC..."
APPLY_OK=false
for attempt in 1 2 3 4 5; do
  CONFIG_GET_RAW="$(docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.get --json --params '{}' 2>&1)" || true
  BASE_HASH="$(python3 -c '
import json,sys,re
raw=sys.stdin.read()
m=re.search(r"\{.*\}", raw, re.S)
raw_json=m.group(0) if m else raw
try:
  j=json.loads(raw_json)
except Exception:
  sys.exit(0)
print(j.get("hash") or (j.get("payload") or {}).get("hash") or ((j.get("result") or {}).get("payload") or {}).get("hash") or "")
' <<<"$CONFIG_GET_RAW")"

  if [[ -z "$BASE_HASH" ]]; then
    warn "config.get attempt ${attempt}: could not read baseHash. Retrying in 15s..."
    sleep 15
    continue
  fi
  echo "baseHash (attempt ${attempt}): ${BASE_HASH}"

  PARAMS="$(python3 - <<PYAPPLY
import json
raw=open("/tmp/openclaw-bootstrap.json5","r",encoding="utf-8").read()
print(json.dumps({"raw": raw, "baseHash": "${BASE_HASH}", "note": "bootstrap"}))
PYAPPLY
)"

  if docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.apply --json --params "${PARAMS}" 2>&1; then
    APPLY_OK=true
    break
  fi
  warn "config.apply attempt ${attempt} failed (gateway may be restarting). Retrying in 15s..."
  sleep 15
done

# config.apply triggers a gateway restart, which often kills the client connection
# before the success response arrives. Check if config was actually written.
if [[ "$APPLY_OK" != "true" ]]; then
  info "All config.apply attempts returned errors. Checking if config was actually written..."
  sleep 10
  if docker exec openclaw-gateway test -f /home/node/.openclaw/openclaw.json 2>/dev/null; then
    info "openclaw.json exists — config.apply likely succeeded despite connection errors."
    APPLY_OK=true
  else
    echo "[ERROR] config.apply failed after 5 attempts and openclaw.json not found"
    exit 1
  fi
fi

# ---- 11) Post-apply harden + inject host Docker CLI ----
info "Post-apply hardening..."
docker exec -u 0 openclaw-gateway bash -lc '
set -e
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
chmod 700 /home/node/.openclaw/bin/oc 2>/dev/null || true
chown -R node:node /home/node/.openclaw
' || true

docker cp "$(which docker)" openclaw-gateway:/usr/local/bin/docker || true
docker exec -u 0 openclaw-gateway chmod +x /usr/local/bin/docker || true
docker exec -u 0 openclaw-gateway groupadd -g "${DOCKER_GID}" -o -r docker 2>/dev/null || true
docker exec -u 0 openclaw-gateway chown -R node:node /home/node/.openclaw || true

# ---- 11b) Install gcloud CLI + jq + PATH for fleet tools in container ----
# fleet-deploy needs gcloud (SA, IAM, VM), jq, and CoreKit bin on PATH
info "Installing gcloud CLI and fleet dependencies in container..."
docker exec -u 0 openclaw-gateway bash -c '
set -e

# Install gcloud CLI (slim)
if ! which gcloud >/dev/null 2>&1; then
  curl -sfL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz | tar xz -C /tmp
  /tmp/google-cloud-sdk/install.sh --quiet --path-update=true --usage-reporting=false 2>/dev/null
  ln -sf /tmp/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
  ln -sf /tmp/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil 2>/dev/null || true
  echo "  gcloud installed: $(gcloud --version 2>/dev/null | head -1)"
else
  echo "  gcloud already installed"
fi

# Install jq if missing
which jq >/dev/null 2>&1 || {
  apt-get update -qq && apt-get install -y -qq jq >/dev/null 2>&1
  echo "  jq installed"
}

# Add CoreKit bin to PATH for all shells (exec tool, bash, etc.)
PROFILE="/home/node/.bashrc"
if ! grep -q ".openclaw/bin" "$PROFILE" 2>/dev/null; then
  echo "export PATH=\"/home/node/.openclaw/bin:\$PATH\"" >> "$PROFILE"
fi
cat > /etc/profile.d/openclaw-path.sh << "PATHEOF"
export PATH="/home/node/.openclaw/bin:$PATH"
PATHEOF
chmod +x /etc/profile.d/openclaw-path.sh

# Update /etc/environment for non-login exec
CURRENT_PATH=$(grep "^PATH=" /etc/environment 2>/dev/null | cut -d= -f2 || echo "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
echo "PATH=/home/node/.openclaw/bin:${CURRENT_PATH}" > /etc/environment

chown node:node /home/node/.bashrc
echo "  PATH configured: /home/node/.openclaw/bin added"
' || warn "gcloud/PATH setup had non-fatal errors (continuing)"

# ---- 12) Vertex AI ADC fix — GCE metadata-based authentication ----
# On GCE, the google-vertex provider in pi-ai can use ADC auto-discovery
# via GoogleGenAI({vertexai:true}), which uses google-auth-library to
# detect the GCE metadata server and obtain real OAuth2 tokens.
#
# However, OpenClaw's model-auth-env layer calls getEnvApiKey("google-vertex")
# which returns null when no ADC file exists — blocking the provider call entirely.
#
# The fix:
#   1. Patch model-auth-env to return a placeholder sentinel "<gce-adc>"
#      when getEnvApiKey returns null. The google-vertex provider's
#      isPlaceholderApiKey(/^<[^>]+>$/) catches this and falls through
#      to createClient(model, project, location) → GoogleGenAI({vertexai:true})
#      → GCE metadata server → real OAuth2 tokens.
#   2. Empty auth-profiles.json to prevent literal "adc" being sent as API key.
info "Applying Vertex AI ADC auth fix..."
docker exec -u 0 openclaw-gateway bash -c '
set -e

# Step 1: Empty auth-profiles.json — prevents literal "adc" being sent as API key
# v2026.4.15+ creates per-agent auth-profiles in agents/{id}/agent/
for AP in /home/node/.openclaw/agents/*/agent/auth-profiles.json; do
  if [ -f "$AP" ]; then
    echo "{\"version\":1,\"profiles\":{}}" > "$AP"
    chown node:node "$AP"
    chmod 600 "$AP"
    echo "  auth-profiles.json emptied: $AP"
  fi
done
# Also handle legacy main agent path
AP="/home/node/.openclaw/agents/main/agent/auth-profiles.json"
if [ ! -f "$AP" ]; then
  mkdir -p "$(dirname "$AP")"
  echo "{\"version\":1,\"profiles\":{}}" > "$AP"
  chown -R node:node /home/node/.openclaw/agents
  echo "  auth-profiles.json created: $AP"
fi

# Step 2: Patch model-auth-env — GCE ADC fallback for google-vertex
# When getEnvApiKey returns null (no ADC file), return a placeholder sentinel
# that the google-vertex provider recognizes and strips, falling through to ADC.
AUTH_ENV_FILE=$(find /app/dist -name "model-auth-env-*" -type f 2>/dev/null | head -1)
if [ -n "$AUTH_ENV_FILE" ]; then
  if grep -q "if (!envKey) return null;" "$AUTH_ENV_FILE" 2>/dev/null; then
    sed -i '\''s|if (!envKey) return null;|if (!envKey) return { apiKey: "<gce-adc>", source: "gce metadata" };|'\'' "$AUTH_ENV_FILE"
    echo "  Patched model-auth-env: GCE ADC fallback enabled"
  elif grep -q "gce-adc" "$AUTH_ENV_FILE" 2>/dev/null; then
    echo "  model-auth-env already patched"
  else
    echo "  [WARN] Could not find expected pattern in model-auth-env"
  fi
else
  echo "  [WARN] model-auth-env file not found in /app/dist"
fi

# ============================================================
# PHASE 3 — Container hardening + Vertex AI fix
# ============================================================

# Step 3: Remove any stale ADC files that might interfere with GCE metadata discovery
rm -f /home/node/.config/gcloud/application_default_credentials.json 2>/dev/null || true

# Step 4: Verify metadata server is reachable from container
TOKEN_CHECK=$(curl -sf --max-time 3 -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email" 2>/dev/null || echo "UNREACHABLE")
echo "  GCE metadata check: $TOKEN_CHECK"
' || warn "ADC fix had non-fatal errors (continuing)"

# Restart gateway to pick up the model-auth-env patch
info "Restarting gateway to apply ADC patch..."
docker restart openclaw-gateway
sleep 10
if docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.get --json --params '{}' > /dev/null 2>&1; then
  info "Gateway restarted successfully after ADC patch."
else
  warn "Gateway may not be ready yet after ADC patch restart. Continuing..."
fi

# ---- 12b) Model discovery — find best available Gemini model ----
# Probes Vertex AI to find the best model the project has access to.
# Updates config template with the best model, re-renders, and restarts.
DISCOVER="${OC_HOST_DIR}/bin/discover-models"
if [[ -x "$DISCOVER" ]]; then
  info "Discovering best available model..."
  GCP_PROJECT_ID="${GCP_PROJECT_ID}" OC_HOST_ROOT="${OC_HOST_ROOT}" "$DISCOVER" --apply || \
    warn "Model discovery failed (non-fatal — keeping current model config)"
else
  warn "discover-models not found — skipping model discovery"
fi

# ---- 12c) Validate config against contracts ----
VALIDATE="${OC_HOST_DIR}/bin/validate-contracts"
if [[ -x "$VALIDATE" ]]; then
  info "Running contract validation..."
  if OC_HOST_ROOT="${OC_HOST_ROOT}" "$VALIDATE" --runtime 2>&1; then
    info "Contract validation PASSED"
  else
    warn "Contract validation found issues (non-fatal during bootstrap)"
  fi
fi

# ---- 12d) Warm-up probe (pre-warm ADC tokens) ----
# ADR: After the ADC patch + model discovery + contract validation, fire a
# lightweight request through the full cortex route to pre-warm ADC tokens.
# This ensures the first real user message from agent-ears doesn't eat
# 10-20s of token initialization.
info "Running warm-up probe..."
curl -s --max-time 30 -X POST "http://localhost:${C_GATEWAY_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MY_TOKEN}" \
  -d '{"model":"'"${C_GATEWAY_ROUTE}"'","messages":[{"role":"user","content":"System warm-up. Respond: ready."}]}' \
  > /dev/null 2>&1 || warn "Warm-up probe failed (non-fatal)"

# ============================================================
# PHASE 4 — Start services + finalize
# ============================================================

# ---- 13) Write prime-config.json ----
cat > "${OC_HOST_DIR}/corekit/prime-config.json" <<PCFG
{
  "primeId": "${PRIME_ID}",
  "projectId": "${GCP_PROJECT_ID}",
  "role": "prime"
}
PCFG

# ---- 13b) Final permissions sweep ----
# ADR: File Ownership Model
# install.sh chowns everything to 1000:1000 (ubuntu). But prime-bootstrap
# runs as root, and root's umask is 077. Any mkdir/cp/sed AFTER install.sh
# creates files/dirs with 700 permissions (root-only). Services that traverse
# these dirs will fail with "Permission denied". The permissions sweep MUST
# be the LAST thing before services start.
info "Final permissions sweep..."
find "${OC_HOST_ROOT}/.openclaw" -type d -exec chmod 755 {} \; 2>/dev/null || true
find "${OC_HOST_ROOT}/.openclaw/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true

# ---- 14) Install agent-ears + agent-mouth as systemd services ----
info "Installing agent-ears + agent-mouth systemd services..."

# Copy service files from corekit (installed by manifest)
EARS_SVC_SRC="${OC_HOST_DIR}/corekit/agent-ears.service"
MOUTH_SVC_SRC="${OC_HOST_DIR}/corekit/agent-mouth.service"
if [[ -f "$EARS_SVC_SRC" ]]; then
  cp "$EARS_SVC_SRC" /etc/systemd/system/agent-ears.service
fi
if [[ -f "$MOUTH_SVC_SRC" ]]; then
  cp "$MOUTH_SVC_SRC" /etc/systemd/system/agent-mouth.service
fi

systemctl daemon-reload
systemctl enable agent-ears agent-mouth 2>/dev/null || true
systemctl start agent-ears agent-mouth

# ---- 14) Install command-runner as systemd service ----
info "Installing command-runner systemd service..."
cat > /etc/systemd/system/command-runner.service <<CRUNIT
[Unit]
Description=Architect Prime Command Runner (Deterministic Operations)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=OC_HOST_ROOT=${OC_HOST_ROOT}
Environment=GCP_PROJECT_ID=${GCP_PROJECT_ID}
Environment=PRIME_ID=${PRIME_ID}
Environment=POLL_INTERVAL=5
ExecStart=${OC_HOST_DIR}/bin/command-runner
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
CRUNIT

systemctl daemon-reload
systemctl enable command-runner
systemctl start command-runner

# ---- 15) Install fleet-health-check timer ----
info "Installing fleet-health-check systemd timer..."
cp "${OC_HOST_DIR}/corekit/fleet-health-check.service" /etc/systemd/system/fleet-health-check.service
cp "${OC_HOST_DIR}/corekit/fleet-health-check.timer" /etc/systemd/system/fleet-health-check.timer
chmod +x "${OC_HOST_DIR}/bin/fleet-health-check"
chmod +x "${OC_HOST_DIR}/bin/update-deep-truths"
systemctl daemon-reload
systemctl enable fleet-health-check.timer
systemctl start fleet-health-check.timer

# ---- Done ----
echo
echo "============================================"
echo "  PRIME VM SETUP COMPLETE (v4.0.1)"
echo "============================================"
echo "  Log file       : ${LOG_FILE}"
echo "  Gateway token  : ${MY_TOKEN}"
echo "  OpenClaw commit: ${STABLE_COMMIT:0:12}"
echo "  CoreKit        : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "  Project        : ${GCP_PROJECT_ID}"
echo "  Prime ID       : ${PRIME_ID}"
echo "  I/O Services   : agent-ears + agent-mouth"
echo "  Dispatch       : prefrontal-first gate (Brain v2.1)"
echo "  Health check   : fleet-health-check.timer (every 15m)"
echo "============================================"

