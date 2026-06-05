#!/usr/bin/env bash
# ============================================================
# fleet-bootstrap.sh — Fleet Agent VM setup (Brain Module + Docker)
#
# Downloaded and executed by fleet-deploy's boot stub.
# All config is read from VM metadata attributes.
#
# Mirrors prime-bootstrap.sh but adapted for fleet agents:
#   - Uses fleet workspace (specialty-specific SOUL/IDENTITY)
#   - Installs agent-ears + agent-mouth services (deterministic I/O)
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
#
# CRITICAL INVARIANTS — do NOT violate these:
#   1. contracts.json is the ONLY source for cross-cutting values
#      (location, port, model, agent ID, OC pin). Never hardcode.
#   2. install.sh MUST use --role fleet --job <specialty>.
#      Omitting flags installs everything (wastes disk, wrong STATE.json).
#   3. Final permissions sweep (step 17b) MUST run AFTER all mkdir/copy
#      and BEFORE any service start. Root's umask is 077.
#   4. Container /home/node/.openclaw permissions (700) are independent
#      from host ${OC_HOST_DIR} permissions (755). Don't confuse them.
#   5. HTTP 401 from gateway = HEALTHY (auth required but responding).
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

# ---- 3) Install CoreKit via manifest (base + fleet + job) ----
info "Installing CoreKit..."
mkdir -p "${OC_HOST_DIR}"
curl -sfL "${CORE_BASE}/infra/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
INSTALL_ARGS="--role fleet"
if [[ -n "${SPECIALTY}" ]]; then
  INSTALL_ARGS+=" --job ${SPECIALTY}"
fi
CORE_REF="${CORE_REF}" \
  GH_OWNER="${GH_OWNER}" \
  GH_REPO="${GH_REPO}" \
  OC_HOST_ROOT="${OC_HOST_ROOT}" \
  bash /tmp/install.sh ${INSTALL_ARGS}

# ---- 3b) Read contracts.json for cross-cutting values ----
# ADR: contracts.json is the SINGLE SOURCE OF TRUTH for all values that appear
# in multiple files (model names, agent IDs, endpoints, OpenClaw pin, ports).
# The Gemini 3.1 migration broke stan because 5 values were hardcoded in 7 files
# and 4 were missed. contracts.json prevents this class of bug entirely.
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
        -e "s|{{AGENT_USER_EMAIL}}|${AGENT_USER_EMAIL}|g" \
        -e "s|{{DEPLOY_TIMESTAMP}}|$(date -Is)|g" \
        "$f" > "${OC_HOST_DIR}/workspace/${BASENAME}"
    echo "  Deployed: ${BASENAME} (from ${WORKSPACE_SRC})"
  done
fi

# ---- 4b) Deploy shared brain sub-agent workspaces ----
BRAIN_SRC="${OC_HOST_DIR}/workspace-_brain"
if [[ -d "$BRAIN_SRC" ]]; then
  info "Deploying brain sub-agent workspaces..."
  for brain_dir in cortex temporal-research temporal-memory prefrontal motor cerebellum; do
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
            -e "s|{{AGENT_USER_EMAIL}}|${AGENT_USER_EMAIL}|g" \
            -e "s|{{DEPLOY_TIMESTAMP}}|$(date -Is)|g" \
            "$f" > "${dest}/$(basename "$f")"
        echo "  Brain: $(basename "$f") → workspace-${brain_dir}/"
      done
    fi
  done
else
  warn "No _brain/ workspaces found — fleet agent will run without sub-agents"
fi
# ---- 4c) Compose SOUL.md from specialty identity + shared protocol ----
SOUL_PROTOCOL="${OC_HOST_DIR}/workspace-fleet/SOUL_PROTOCOL.md"
SOUL_DEPLOYED="${OC_HOST_DIR}/workspace/SOUL.md"
if [[ -f "$SOUL_DEPLOYED" && -f "$SOUL_PROTOCOL" ]]; then
  info "Composing SOUL.md (specialty identity + shared protocol)..."
  # Append shared protocol block to the specialty identity fragment
  cat "$SOUL_PROTOCOL" >> "$SOUL_DEPLOYED"
  echo "  Appended SOUL_PROTOCOL.md to SOUL.md"
else
  if [[ ! -f "$SOUL_DEPLOYED" ]]; then
    warn "No SOUL.md found in workspace — composition skipped"
  fi
  if [[ ! -f "$SOUL_PROTOCOL" ]]; then
    warn "SOUL_PROTOCOL.md not found — composition skipped"
  fi
fi

# ---- 5) Assemble TOOLS.md from skills ----
info "Assembling TOOLS.md..."
if [[ -x "${OC_HOST_DIR}/bin/assemble-tools" ]]; then
  OC_HOST_ROOT="${OC_HOST_ROOT}" "${OC_HOST_DIR}/bin/assemble-tools" "${SPECIALTY}"
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

# ---- 6b) Write identity lockfile ----
# This file is the single source of truth for the agent's Workspace identity.
# dwd-token reads it and refuses to impersonate any other email.
if [[ -n "${AGENT_USER_EMAIL}" ]]; then
  echo "${AGENT_USER_EMAIL}" > "${OC_HOST_DIR}/.identity-lock"
  chmod 444 "${OC_HOST_DIR}/.identity-lock"
  info "Identity lock: ${AGENT_USER_EMAIL}"
fi

# ---- 7) Save gateway token ----
mkdir -p /root/.openclaw
echo "${MY_TOKEN}" > /root/.openclaw/.gateway-token
chmod 600 /root/.openclaw/.gateway-token

# ---- 8) Install agent-ears, agent-mouth, and agent-brain systemd units ----
info "Installing agent-ears, agent-mouth, and agent-brain systemd units..."

# Copy service files from corekit (installed by manifest)
EARS_SVC_SRC="${OC_HOST_DIR}/corekit/agent-ears.service"
MOUTH_SVC_SRC="${OC_HOST_DIR}/corekit/agent-mouth.service"
BRAIN_SVC_SRC="${OC_HOST_DIR}/corekit/agent-brain.service"
if [[ -f "$EARS_SVC_SRC" ]]; then
  cp "$EARS_SVC_SRC" /etc/systemd/system/agent-ears.service
fi
if [[ -f "$MOUTH_SVC_SRC" ]]; then
  cp "$MOUTH_SVC_SRC" /etc/systemd/system/agent-mouth.service
fi
if [[ -f "$BRAIN_SVC_SRC" ]]; then
  cp "$BRAIN_SVC_SRC" /etc/systemd/system/agent-brain.service
fi
PROXY_SVC_SRC="${OC_HOST_DIR}/corekit/vertex-claude-proxy.service"
if [[ -f "$PROXY_SVC_SRC" ]]; then
  cp "$PROXY_SVC_SRC" /etc/systemd/system/vertex-claude-proxy.service
fi
systemctl daemon-reload
systemctl enable agent-ears agent-mouth agent-brain vertex-claude-proxy 2>/dev/null || true

# ============================================================
# PHASE 2 — Brain Module (replaces OpenClaw gateway)
# ============================================================

# ---- 9) Clone + build OpenClaw Docker image (still needed for Node.js runtime) ----
info "Cloning OpenClaw repo (Node.js runtime container)..."
cd /root
if [[ ! -d openclaw/.git ]]; then
  git clone https://github.com/openclaw/openclaw.git
fi
cd openclaw
git fetch --all --prune
STABLE_COMMIT="${C_OC_PIN}"
git checkout "${STABLE_COMMIT}"
info "Using OpenClaw commit: ${STABLE_COMMIT:0:12} (container base)"

cat > .env <<EOF
GATEWAY_BIND=loopback
GATEWAY_PORT=${C_GATEWAY_PORT}
OPENCLAW_GATEWAY_TOKEN=${MY_TOKEN}
OPENCLAW_CONFIG_DIR=/home/node/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace
GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}
GCLOUD_PROJECT=${GCP_PROJECT_ID}
CLOUDSDK_CORE_PROJECT=${GCP_PROJECT_ID}
GOOGLE_GENAI_USE_VERTEXAI=True
GOOGLE_CLOUD_LOCATION=${C_LOCATION}
GCE_METADATA_HOST=metadata.google.internal
AGENT_ID=${AGENT_ID}
PRIME_ID=${PRIME_ID}
EOF

info "Building Docker image openclaw:local ..."
DOCKER_BUILDKIT=1 docker build -t openclaw:local .

# ---- 10) Start container (OpenClaw gateway runs initially for backward compat) ----
docker rm -f openclaw-gateway > /dev/null 2>&1 || true

info "Starting container..."
docker run -d \
  --name openclaw-gateway \
  --network host \
  --restart always \
  --env-file .env \
  -v "${OC_HOST_DIR}:/home/node/.openclaw" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "${DOCKER_GID}" \
  openclaw:local

# ---- 11) Wait for container readiness ----
wait_gateway "Gateway (initial)" 180 || true

# ============================================================
# PHASE 3 — Container hardening + Brain module install
# ============================================================

# ---- 12) Harden container permissions ----
info "Hardening container permissions..."
docker exec -u 0 openclaw-gateway bash -lc '
set -e
mkdir -p /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw
chmod 700 /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw/bin 2>/dev/null || true
chown -R node:node /home/node/.openclaw
'

# ---- 13) Post-apply: inject Docker CLI + PATH ----
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

# ---- 14) Install gcloud CLI + jq in container ----
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

# ---- 15) Install Brain module inside container ----
info "Installing Brain module..."
BRAIN_DIR="/home/node/.openclaw/brain"
docker exec -u 0 openclaw-gateway bash -c "
mkdir -p ${BRAIN_DIR}
"
# Copy brain module files from corekit
for f in package.json index.mjs router.mjs loop.mjs tools.mjs config.mjs context.mjs health.mjs; do
  SRC="${OC_HOST_DIR}/corekit/brain/${f}"
  if [[ -f "$SRC" ]]; then
    docker cp "$SRC" "openclaw-gateway:${BRAIN_DIR}/${f}"
    echo "  Copied: ${f}"
  else
    warn "Brain module file not found: ${f}"
  fi
done
docker exec -u 0 openclaw-gateway chown -R node:node "${BRAIN_DIR}"

# npm install brain dependencies
info "Installing brain npm dependencies..."
docker exec -w "${BRAIN_DIR}" openclaw-gateway npm install 2>&1 | tail -5

# ---- 16) Vertex AI ADC fix (same as Prime — still needed for OpenClaw compat) ----
info "Applying Vertex AI ADC auth fix..."

# Step 1: Empty auth-profiles for ALL agents
docker exec -u 0 openclaw-gateway bash -c '
for AP in /home/node/.openclaw/agents/*/agent/auth-profiles.json; do
  if [ -f "$AP" ]; then
    echo "{\"version\":1,\"profiles\":{}}" > "$AP"
    chown node:node "$AP"
    chmod 600 "$AP"
    echo "  auth-profiles.json emptied: $AP"
  fi
done
AP="/home/node/.openclaw/agents/cortex/agent/auth-profiles.json"
if [ ! -f "$AP" ]; then
  mkdir -p "$(dirname "$AP")"
  echo "{\"version\":1,\"profiles\":{}}" > "$AP"
  chown -R node:node /home/node/.openclaw/agents
  echo "  auth-profiles.json created: $AP"
fi
' || warn "auth-profiles step had non-fatal errors"

# Step 2: Patch model-auth-env (still needed for OpenClaw's own inference)
AUTH_ENV_FILE=$(docker exec openclaw-gateway find /app/dist -name "model-auth-env-*" -type f 2>/dev/null | head -1)
if [ -n "$AUTH_ENV_FILE" ]; then
  docker exec -i openclaw-gateway tee /tmp/patch-adc.py <<'PYEOF' >/dev/null
import sys
fpath = sys.argv[1]
with open(fpath) as f: code = f.read()
if "<gce-adc>" in code and "if (!envKey) return null;" not in code:
    print("  model-auth-env already patched"); sys.exit(0)
patched = False
if "if (!envKey) return null;" in code:
    code = code.replace("if (!envKey) return null;",
        'if (!envKey) return { apiKey: "<gce-adc>", source: "gce metadata" };', 1)
    patched = True; print("  Patched model-auth-env (ADC fallback)")
else:
    print("  WARN: model-auth-env sentinel not found"); sys.exit(0)
if patched:
    with open(fpath, "w") as f: f.write(code)
PYEOF
  docker exec -u 0 openclaw-gateway python3 /tmp/patch-adc.py "$AUTH_ENV_FILE" || warn "ADC patch script error"
  docker exec -u 0 openclaw-gateway rm -f /tmp/patch-adc.py
fi

# Step 3: Remove stale ADC files
docker exec -u 0 openclaw-gateway rm -f /home/node/.config/gcloud/application_default_credentials.json 2>/dev/null || true

# ---- 17) Restart gateway + Brain smoke test ----
info "Restarting gateway to activate ADC patch..."
docker restart openclaw-gateway
wait_gateway "Gateway (post-ADC)" 120 || true

# Let gateway fully initialize
info "Waiting 15s for gateway to settle..."
sleep 15

# Brain module smoke test
info "Running Brain module smoke test..."
BRAIN_SMOKE_OK=false
BRAIN_SMOKE_RESP="$(docker exec \
  -e GOOGLE_CLOUD_PROJECT="${GCP_PROJECT_ID}" \
  -e GOOGLE_CLOUD_LOCATION="${C_LOCATION}" \
  -e BRAIN_PORT="19999" \
  -w "${BRAIN_DIR}" \
  openclaw-gateway timeout 30 node -e "
import { createVertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';
const v = createVertex({project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION});
const r = await generateText({model: v('gemini-2.5-flash'), prompt: 'Reply: BRAIN_OK', maxTokens: 5});
console.log(r.text.includes('BRAIN_OK') ? 'BRAIN_SMOKE_PASS' : 'BRAIN_SMOKE_FAIL: ' + r.text);
" 2>&1)" || BRAIN_SMOKE_RESP="SMOKE_ERROR"

if echo "$BRAIN_SMOKE_RESP" | grep -q 'BRAIN_SMOKE_PASS'; then
  info "Brain module smoke test PASSED"
  BRAIN_SMOKE_OK=true
else
  warn "Brain smoke test failed: ${BRAIN_SMOKE_RESP:0:200}"
fi

# Vertex AI smoke test (OpenClaw gateway — backward compat)
info "Running Vertex AI gateway smoke test..."
SMOKE_OK=false
for attempt in 1 2 3; do
  SMOKE_RESP="$(curl -s --max-time 60 -X POST http://localhost:${C_GATEWAY_PORT}/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${MY_TOKEN}" \
    -d '{"model":"'"${C_GATEWAY_ROUTE}"'","messages":[{"role":"user","content":"respond with just the word pong"}]}' 2>&1)" || SMOKE_RESP="CURL_ERROR"

  if echo "$SMOKE_RESP" | grep -q '"pong"'; then
    info "Vertex AI smoke test PASSED (attempt ${attempt})"
    SMOKE_OK=true
    break
  fi
  warn "Smoke test attempt ${attempt}/3 failed: ${SMOKE_RESP:0:150}"
  [[ $attempt -lt 3 ]] && sleep $((attempt * 15))
done
[[ "$SMOKE_OK" == "true" ]] || warn "Smoke test did not pass after 3 attempts — agent may still work once IAM propagates"

# ---- 17c) Warm-up probe ----
info "Running warm-up probe..."
curl -s --max-time 30 -X POST "http://localhost:${C_GATEWAY_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MY_TOKEN}" \
  -d '{"model":"'"${C_GATEWAY_ROUTE}"'","messages":[{"role":"user","content":"System warm-up. Respond: ready."}]}' \
  > /dev/null 2>&1 || warn "Warm-up probe failed (non-fatal)"

# ---- 17d) Register cron jobs ----
info "Registering cron jobs..."
docker exec openclaw-gateway node /app/openclaw.mjs cron add \
  --name "memory-consolidate" \
  --cron "0 2 * * *" \
  --tz "America/Chicago" \
  --agent "temporal-memory" \
  --session isolated \
  --no-deliver \
  --timeout-seconds 120 \
  --message "[SKILL:memory-consolidate] Execute nightly memory consolidation." \
  --json 2>&1 || warn "memory-consolidate cron registration failed (non-fatal)"

# ============================================================
# PHASE 4 — Start services + finalize
# ============================================================

# ---- 17b) Shared workspace architecture ----
# ADR: Agents have isolated workspaces to load distinct SOUL/TOOLS.
# We create a central shared directory and symlink it into every workspace
# so agents can read/write collaborative files (sandbox mode must be off).
info "Setting up shared workspace architecture..."
SHARED_DIR="${OC_HOST_ROOT}/.openclaw/shared"
mkdir -p "$SHARED_DIR"
for dir in "${OC_HOST_ROOT}/.openclaw"/workspace*; do
  if [[ -d "$dir" ]]; then
    ln -snf "$SHARED_DIR" "$dir/shared"
  fi
done

# ---- 17c) Final permissions sweep ----
# ADR: File Ownership Model
# install.sh chowns everything to 1000:1000 (ubuntu). But fleet-bootstrap
# runs as root, and root's umask is 077. Any mkdir/cp/sed AFTER install.sh
# creates files/dirs with 700 permissions (root-only). The ears/mouth
# wrappers need to traverse dirs. This sweep MUST be the LAST thing before
# services start.
info "Final permissions sweep..."
find "${OC_HOST_ROOT}/.openclaw" -type d -exec chmod 755 {} \; 2>/dev/null || true
find "${OC_HOST_ROOT}/.openclaw/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true

# ---- 18) Start agent-ears + agent-mouth + agent-brain ----
info "Starting systemd services..."
systemctl start agent-brain vertex-claude-proxy || warn "agent-brain/vertex-claude-proxy start failed"

if [[ -n "${AGENT_USER_EMAIL}" && -n "${DWD_SIGNER_SA}" ]]; then
  systemctl start agent-ears agent-mouth || warn "ears/mouth start failed (DWD may not be configured)"
else
  warn "ears/mouth not started — AGENT_USER_EMAIL or DWD_SIGNER_SA not set"
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
echo "  Brain module : installed"
echo "  Agent          : ${AGENT_DISPLAY_NAME} (${SPECIALTY})"
echo "  Project        : ${GCP_PROJECT_ID}"
echo "============================================"
