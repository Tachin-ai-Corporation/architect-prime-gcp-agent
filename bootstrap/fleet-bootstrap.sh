#!/usr/bin/env bash
# ============================================================
# fleet-bootstrap.sh — Fleet Agent VM setup (Docker-based OpenClaw)
#
# Downloaded and executed by fleet-deploy's boot stub.
# All config is read from VM metadata attributes.
#
# Mirrors prime-bootstrap.sh but adapted for fleet agents:
#   - Uses fleet workspace (specialty-specific SOUL/IDENTITY)
#   - Installs inbox-daemon instead of control-daemon
#   - Reads agent identity from VM metadata
#   - Same proven OpenClaw + ADC fix pattern
#
# Status reporting:
#   - fleet-monitor on Prime polls serial console for milestones
#   - Step 18 self-reports completion to Firestore via Prime's API
#
# Design: no RPC calls to configure OpenClaw. Config is written
# directly to the host filesystem (bind-mounted into container)
# and the container is restarted once to pick it up. This avoids
# the config.apply deadlock on resource-constrained VMs.
# ============================================================
set -euo pipefail

export HOME="${HOME:-/root}"
export USER="${USER:-$(whoami)}"

LOG_FILE="/var/log/fleet-agent-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "Log: $LOG_FILE"; exit 1' ERR

info(){ echo -e "\n==> $*\n"; }
warn(){ echo -e "\n[WARN] $*\n"; }

# ---- Shared: wait for gateway HTTP readiness ----
wait_gateway() {
  local label="${1:-Gateway}"
  local max_wait="${2:-180}"
  local waited=0
  while [[ "$waited" -lt "$max_wait" ]]; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      http://localhost:18789/v1/models 2>/dev/null)" || code="000"
    if [[ "$code" == "401" || "$code" == "200" ]]; then
      info "${label} ready (took ~${waited}s)"
      return 0
    fi
    echo "  ${label} not ready (HTTP ${code}, ${waited}s elapsed)..."
    sleep 10
    waited=$((waited + 10))
  done
  warn "${label} did not respond within ${max_wait}s"
  return 1
}

# ---- Read config from VM metadata ----
META="http://metadata.google.internal/computeMetadata/v1"
MH="Metadata-Flavor: Google"
AGENT_ID="$(curl -sf -H "$MH" "$META/instance/attributes/agent_id" || echo 'unknown')"
SPECIALTY="$(curl -sf -H "$MH" "$META/instance/attributes/specialty" || echo 'general')"
CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || echo 'main')"
GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo 'Tachin-ai-Corporation')"
GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo 'architect-prime-gcp-agent')"
GCP_PROJECT_ID="$(curl -sf -H "$MH" "$META/project/project-id")"
AGENT_USER_EMAIL="$(curl -sf -H "$MH" "$META/instance/attributes/agent_user_email" || true)"
AGENT_DISPLAY_NAME="$(curl -sf -H "$MH" "$META/instance/attributes/agent_display_name" || echo "$AGENT_ID")"
AGENT_FIRST_NAME="$(curl -sf -H "$MH" "$META/instance/attributes/agent_first_name" || true)"
AGENT_LAST_NAME="$(curl -sf -H "$MH" "$META/instance/attributes/agent_last_name" || true)"
CHAT_SPACE_ID="$(curl -sf -H "$MH" "$META/instance/attributes/chat_space_id" || true)"
DWD_SIGNER_SA="$(curl -sf -H "$MH" "$META/instance/attributes/dwd_signer_sa" || true)"
PRIME_ID="$(curl -sf -H "$MH" "$META/instance/attributes/prime_id" || true)"
DASHBOARD_URL="$(curl -sf -H "$MH" "$META/instance/attributes/dashboard_url" || true)"

# Derive the @-mention text used by Google Chat (e.g., "Devops-Agent Stan")
# This MUST match the Workspace account's First Name + Last Name exactly
AGENT_MENTION="${AGENT_FIRST_NAME} ${AGENT_LAST_NAME}"
AGENT_MENTION="$(echo "$AGENT_MENTION" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

MY_TOKEN="$(openssl rand -hex 16)"
OC_HOST_ROOT="/opt/openclaw"
OC_HOST_DIR="${OC_HOST_ROOT}/.openclaw"
CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

info "Fleet Agent Bootstrap: $(date -Is)"
echo "Agent       : ${AGENT_ID}"
echo "Specialty   : ${SPECIALTY}"
echo "Email       : ${AGENT_USER_EMAIL}"
echo "Display     : ${AGENT_DISPLAY_NAME}"
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

# ---- 2) Install Docker CE ----
info "Installing Docker CE..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi
systemctl enable docker
systemctl start docker
DOCKER_GID="$(getent group docker | cut -d: -f3)"
[[ -n "${DOCKER_GID}" ]] || { echo "[ERROR] Could not determine docker group GID"; exit 1; }

# ---- 3) Install CoreKit via manifest ----
info "Installing CoreKit..."
mkdir -p "${OC_HOST_DIR}"
curl -sfL "${CORE_BASE}/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
CORE_REF="${CORE_REF}" \
  GH_OWNER="${GH_OWNER}" \
  GH_REPO="${GH_REPO}" \
  OC_HOST_ROOT="${OC_HOST_ROOT}" \
  bash /tmp/install.sh

# ---- 4) Prepare workspace with fleet/specialty templates ----
info "Preparing workspace..."
mkdir -p "${OC_HOST_DIR}/workspace"

# Use specialty workspace if it exists, otherwise fall back to fleet template
WORKSPACE_SRC=""
if [[ -d "${OC_HOST_DIR}/workspace-${SPECIALTY}" ]]; then
  WORKSPACE_SRC="workspace-${SPECIALTY}"
elif [[ -d "${OC_HOST_DIR}/workspace-fleet" ]]; then
  WORKSPACE_SRC="workspace-fleet"
fi

if [[ -n "$WORKSPACE_SRC" ]]; then
  # IMPORTANT: Clear the main workspace first to prevent Prime's
  # identity from leaking into fleet agents.
  info "Clearing Prime workspace files..."
  rm -f "${OC_HOST_DIR}/workspace/"*.md 2>/dev/null || true

  for f in "${OC_HOST_DIR}/${WORKSPACE_SRC}"/*.md; do
    [[ -f "$f" ]] || continue
    BASENAME="$(basename "$f")"
    sed -e "s|{{AGENT_NAME}}|${AGENT_DISPLAY_NAME}|g" \
        -e "s|{{SPECIALTY}}|${SPECIALTY}|g" \
        -e "s|{{PROJECT_ID}}|${GCP_PROJECT_ID}|g" \
        -e "s|{{DEPLOY_TIMESTAMP}}|$(date -Is)|g" \
        "$f" > "${OC_HOST_DIR}/workspace/${BASENAME}"
    echo "  Deployed: ${BASENAME} (from ${WORKSPACE_SRC})"
  done
fi

# ---- 4b) Deploy shared brain sub-agent workspaces ----
BRAIN_SRC="${OC_HOST_DIR}/workspace-_brain"
if [[ -d "$BRAIN_SRC" ]]; then
  info "Deploying brain sub-agent workspaces..."
  for brain_dir in temporal-research temporal-memory prefrontal motor cerebellum; do
    src="${BRAIN_SRC}/${brain_dir}"
    dest="${OC_HOST_DIR}/workspace-${brain_dir}"
    if [[ -d "$src" ]]; then
      mkdir -p "$dest"
      # Clear any existing Prime sub-agent files
      rm -f "${dest}/"*.md 2>/dev/null || true
      for f in "${src}"/*.md; do
        [[ -f "$f" ]] || continue
        sed -e "s|{{AGENT_NAME}}|${AGENT_DISPLAY_NAME}|g" \
            -e "s|{{SPECIALTY}}|${SPECIALTY}|g" \
            -e "s|{{PROJECT_ID}}|${GCP_PROJECT_ID}|g" \
            -e "s|{{DEPLOY_TIMESTAMP}}|$(date -Is)|g" \
            "$f" > "${dest}/$(basename "$f")"
        echo "  Brain: $(basename "$f") → workspace-${brain_dir}/"
      done
    fi
  done
else
  warn "No _brain/ workspaces found — fleet agent will run without sub-agents"
fi

# ---- 5) Assemble TOOLS.md from skills ----
info "Assembling TOOLS.md..."
if [[ -x "${OC_HOST_DIR}/bin/assemble-tools" ]]; then
  OC_HOST_ROOT="${OC_HOST_ROOT}" "${OC_HOST_DIR}/bin/assemble-tools" prime
else
  warn "assemble-tools not found, TOOLS.md will use defaults"
fi

# ---- 6) Write DWD chat config ----
if [[ -n "${AGENT_USER_EMAIL}" ]]; then
  cat > "${OC_HOST_DIR}/corekit/chat-config.json" <<CHATCFG
{
  "spaceId": "${CHAT_SPACE_ID}",
  "agentUserEmail": "${AGENT_USER_EMAIL}",
  "agentDisplayName": "${AGENT_DISPLAY_NAME}",
  "agentFirstName": "${AGENT_FIRST_NAME}",
  "agentLastName": "${AGENT_LAST_NAME}",
  "agentMention": "${AGENT_MENTION}",
  "projectId": "${GCP_PROJECT_ID}",
  "dwdSignerSa": "${DWD_SIGNER_SA}",
  "geminiProject": "${GCP_PROJECT_ID}"
}
CHATCFG
fi

# ---- 7) Save gateway token ----
mkdir -p /root/.openclaw
echo "${MY_TOKEN}" > /root/.openclaw/.gateway-token
chmod 600 /root/.openclaw/.gateway-token

# ---- 8) Install inbox-daemon systemd unit ----
info "Installing inbox-daemon systemd unit..."
cat > /etc/systemd/system/inbox-daemon.service <<UNIT
[Unit]
Description=Fleet Agent Inbox Daemon (DWD Chat Polling)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=OC_HOST_ROOT=${OC_HOST_ROOT}
Environment=AGENT_ID=${AGENT_ID}
Environment=AGENT_USER_EMAIL=${AGENT_USER_EMAIL}
Environment=CHAT_SPACE_ID=${CHAT_SPACE_ID:-}
Environment=DWD_SIGNER_SA=${DWD_SIGNER_SA:-}
Environment=GCP_PROJECT_ID=${GCP_PROJECT_ID}
ExecStart=${OC_HOST_DIR}/bin/inbox-daemon
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable inbox-daemon

# ============================================================
# PHASE 2 — OpenClaw Docker image + config
# ============================================================

# ---- 9) Clone + build OpenClaw Docker image ----
info "Cloning OpenClaw repo..."
cd /root
if [[ ! -d openclaw/.git ]]; then
  git clone https://github.com/openclaw/openclaw.git
fi
cd openclaw
git fetch --all --prune
# Pin to known-good release — v2026.4.15 (Apr 16, 2026)
OC_PIN="041266a6699cac3baef8ef39db41fa26f29f9db3"
STABLE_COMMIT="${OC_PIN}"
git checkout "${STABLE_COMMIT}"
info "Using OpenClaw commit: ${STABLE_COMMIT} (pinned to v2026.4.15)"

cat > .env <<EOF
GATEWAY_BIND=loopback
GATEWAY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=${MY_TOKEN}
OPENCLAW_CONFIG_DIR=/home/node/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace
OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json
GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}
GCLOUD_PROJECT=${GCP_PROJECT_ID}
CLOUDSDK_CORE_PROJECT=${GCP_PROJECT_ID}
GOOGLE_GENAI_USE_VERTEXAI=True
GOOGLE_CLOUD_LOCATION=global
GCE_METADATA_HOST=metadata.google.internal
AGENT_ID=${AGENT_ID}
PRIME_ID=${PRIME_ID}
EOF

info "Building Docker image openclaw:local ..."
DOCKER_BUILDKIT=1 docker build -t openclaw:local .

# ---- 10) Write OpenClaw config directly (no RPC) ----
info "Writing OpenClaw config..."
FLEET_TMPL="${OC_HOST_DIR}/corekit/openclaw-fleet-bootstrap.json5.tmpl"
if [[ ! -f "$FLEET_TMPL" ]]; then
  FLEET_TMPL="${OC_HOST_DIR}/corekit/openclaw-bootstrap.json5.tmpl"
  warn "Fleet config template not found, using prime template"
fi

# Note: SOUL.md is loaded automatically by OpenClaw from the workspace directory.
# No systemPrompt injection needed — the workspace files (step 4) handle identity.

python3 - <<PY
import pathlib, re, json

tmpl_path = pathlib.Path("${FLEET_TMPL}")
out_path = pathlib.Path("${OC_HOST_DIR}/openclaw.json")

tmpl = tmpl_path.read_text(encoding="utf-8")

# Remove json5 comments (// style)
tmpl = re.sub(r'//.*$', '', tmpl, flags=re.MULTILINE)

# Template substitutions
tmpl = tmpl.replace("\${GCP_PROJECT_ID}", "${GCP_PROJECT_ID}")
tmpl = tmpl.replace("\${MY_TOKEN}", "${MY_TOKEN}")
tmpl = tmpl.replace("\${AGENT_ID}", "${AGENT_ID}")
tmpl = tmpl.replace("\${AGENT_DISPLAY_NAME}", "${AGENT_DISPLAY_NAME}")

out_path.write_text(tmpl, encoding="utf-8")
print("  Config written to " + str(out_path))
PY
chown root:root "${OC_HOST_DIR}/openclaw.json"
chmod 644 "${OC_HOST_DIR}/openclaw.json"

# ---- 11) Start OpenClaw container ----
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

# ---- 12) Wait for gateway readiness ----
wait_gateway "Gateway (initial)" 180 || true

# ============================================================
# PHASE 3 — Container hardening + Vertex AI fix
# ============================================================

# ---- 13) Harden container permissions ----
info "Hardening container permissions..."
docker exec -u 0 openclaw-gateway bash -lc '
set -e
mkdir -p /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw
chmod 700 /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw/bin 2>/dev/null || true
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
chown -R node:node /home/node/.openclaw
'

# ---- 14) Post-apply: inject Docker CLI + PATH ----
info "Post-config setup..."
docker cp "$(which docker)" openclaw-gateway:/usr/local/bin/docker || true
docker exec -u 0 openclaw-gateway chmod +x /usr/local/bin/docker || true
docker exec -u 0 openclaw-gateway groupadd -g "${DOCKER_GID}" -o -r docker 2>/dev/null || true
docker exec -u 0 openclaw-gateway chown -R node:node /home/node/.openclaw || true

docker exec -u 0 openclaw-gateway bash -c '
PROFILE="/home/node/.bashrc"
grep -q ".openclaw/bin" "$PROFILE" 2>/dev/null || echo "export PATH=\"/home/node/.openclaw/bin:\$PATH\"" >> "$PROFILE"
cat > /etc/profile.d/openclaw-path.sh << "PATHEOF"
export PATH="/home/node/.openclaw/bin:$PATH"
PATHEOF
chmod +x /etc/profile.d/openclaw-path.sh
CURRENT_PATH=$(grep "^PATH=" /etc/environment 2>/dev/null | cut -d= -f2 || echo "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
echo "PATH=/home/node/.openclaw/bin:${CURRENT_PATH}" > /etc/environment
chown node:node /home/node/.bashrc
' || warn "PATH setup had non-fatal errors"

# ---- 15) Install gcloud CLI + jq in container ----
info "Installing gcloud CLI in container..."
docker exec -u 0 openclaw-gateway bash -c '
set -e
if ! which gcloud >/dev/null 2>&1; then
  curl -sfL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz | tar xz -C /tmp
  /tmp/google-cloud-sdk/install.sh --quiet --path-update=true --usage-reporting=false 2>/dev/null
  ln -sf /tmp/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
  echo "  gcloud installed"
fi
which jq >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq jq >/dev/null 2>&1; }
' || warn "gcloud install had non-fatal errors"

# ---- 16) Vertex AI ADC fix (same as Prime) ----
info "Applying Vertex AI ADC auth fix..."
docker exec -u 0 openclaw-gateway bash -c '
set -e

# Step 1: Empty auth-profiles for ALL agents (cortex, temporal-research, etc.)
for AP in /home/node/.openclaw/agents/*/agent/auth-profiles.json; do
  if [ -f "$AP" ]; then
    echo "{\"version\":1,\"profiles\":{}}" > "$AP"
    chown node:node "$AP"
    chmod 600 "$AP"
    echo "  auth-profiles.json emptied: $AP"
  fi
done
# Ensure cortex agent (default) has auth-profiles even if not yet created
AP="/home/node/.openclaw/agents/cortex/agent/auth-profiles.json"
if [ ! -f "$AP" ]; then
  mkdir -p "$(dirname "$AP")"
  echo "{\"version\":1,\"profiles\":{}}" > "$AP"
  chown -R node:node /home/node/.openclaw/agents
  echo "  auth-profiles.json created: $AP"
fi

# Step 2: Patch model-auth-env — GCE ADC fallback for google-vertex
AUTH_ENV_FILE=$(find /app/dist -name "model-auth-env-*" -type f 2>/dev/null | head -1)
if [ -n "$AUTH_ENV_FILE" ]; then
  if grep -q "if (!envKey) return null;" "$AUTH_ENV_FILE" 2>/dev/null; then
    sed -i '\''s|if (!envKey) return null;|if (!envKey) return { apiKey: "<gce-adc>", source: "gce metadata" };|'\'' "$AUTH_ENV_FILE"
    echo "  Patched model-auth-env: GCE ADC fallback enabled"
  elif grep -q "gce-adc" "$AUTH_ENV_FILE" 2>/dev/null; then
    echo "  model-auth-env already patched"
  fi
fi

# Step 3: Remove stale ADC files
rm -f /home/node/.config/gcloud/application_default_credentials.json 2>/dev/null || true
' || warn "ADC fix had non-fatal errors"

# ---- 17) Restart gateway to pick up ADC patch + smoke test ----
info "Restarting gateway to activate ADC patch..."
docker restart openclaw-gateway
wait_gateway "Gateway (post-ADC)" 120 || true

# Let gateway fully initialize (plugins, channels, LLM backend)
info "Waiting 15s for gateway to settle..."
sleep 15

# Vertex AI smoke test — retry up to 3 times with backoff
info "Running Vertex AI smoke test..."
SMOKE_OK=false
for attempt in 1 2 3; do
  SMOKE_RESP="$(curl -s --max-time 30 -X POST http://localhost:18789/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${MY_TOKEN}" \
    -d '{"model":"openclaw/main","messages":[{"role":"user","content":"respond with just the word pong"}]}' 2>&1)" || SMOKE_RESP="CURL_ERROR"

  if echo "$SMOKE_RESP" | grep -q '"pong"'; then
    info "Vertex AI smoke test PASSED (attempt ${attempt})"
    SMOKE_OK=true
    break
  fi
  warn "Smoke test attempt ${attempt}/3 failed: ${SMOKE_RESP:0:150}"
  [[ $attempt -lt 3 ]] && sleep $((attempt * 15))
done
[[ "$SMOKE_OK" == "true" ]] || warn "Smoke test did not pass after 3 attempts — agent may still work once IAM propagates"

# ============================================================
# PHASE 4 — Start services + finalize
# ============================================================

# ---- 18) Start inbox-daemon ----
info "Starting inbox-daemon..."
if [[ -n "${AGENT_USER_EMAIL}" && -n "${DWD_SIGNER_SA}" ]]; then
  systemctl start inbox-daemon || warn "inbox-daemon start failed (DWD may not be configured)"
else
  warn "inbox-daemon not started — AGENT_USER_EMAIL or DWD_SIGNER_SA not set"
fi

# ---- 19) Report completion to Firestore via Prime's API ----
# Uses Prime's Cloud Run endpoint (no fleet SA Datastore permission needed)
if [[ -n "$DASHBOARD_URL" && -n "$PRIME_ID" ]]; then
  info "Reporting completion to dashboard..."
  STATUS_BODY="{\"agent\":\"${AGENT_ID}\",\"status\":\"online\",\"actionRequired\":{\"type\":\"workspace_user\",\"title\":\"Create Workspace user and add to Chat space\",\"instructions\":[\"Create Workspace user at https://admin.google.com/ac/users — First: ${AGENT_FIRST_NAME:-Agent}, Last: ${AGENT_LAST_NAME:-${AGENT_ID}}, Email: ${AGENT_USER_EMAIL}\",\"Add ${AGENT_USER_EMAIL} to the AI Fleet Command Chat space\",\"The agent will come online automatically once the user exists\"]}}"

  STATUS_RESP="$(curl -s --max-time 15 -X POST \
    "${DASHBOARD_URL}/api/primes/${PRIME_ID}/fleet/update-status" \
    -H "Content-Type: application/json" \
    -d "$STATUS_BODY" 2>&1)" || STATUS_RESP="CURL_ERROR"

  if echo "$STATUS_RESP" | grep -q '"success"'; then
    info "Dashboard status updated: online"
  else
    warn "Dashboard status update failed: ${STATUS_RESP:0:200}"
  fi
else
  warn "Skipping dashboard status update (DASHBOARD_URL=${DASHBOARD_URL:-unset}, PRIME_ID=${PRIME_ID:-unset})"
fi

# ---- Done ----
# fleet-monitor on Prime polls the serial console for this marker:
echo
echo "============================================"
echo "  FLEET AGENT SETUP COMPLETE"
echo "============================================"
echo "  Log file       : ${LOG_FILE}"
echo "  Gateway token  : ${MY_TOKEN}"
echo "  OpenClaw commit: ${STABLE_COMMIT}"
echo "  Agent          : ${AGENT_DISPLAY_NAME} (${SPECIALTY})"
echo "  Project        : ${GCP_PROJECT_ID}"
echo "============================================"
