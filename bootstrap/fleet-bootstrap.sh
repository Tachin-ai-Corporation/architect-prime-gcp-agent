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
# ============================================================
set -euo pipefail

export HOME="${HOME:-/root}"
export USER="${USER:-$(whoami)}"

LOG_FILE="/var/log/fleet-agent-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "Log: $LOG_FILE"; exit 1' ERR

info(){ echo -e "\n==> $*\n"; }
warn(){ echo -e "\n[WARN] $*\n"; }

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

# Derive the @-mention text used by Google Chat (e.g., "Devops-Agent Stan")
# This MUST match the Workspace account's First Name + Last Name exactly
AGENT_MENTION="${AGENT_FIRST_NAME} ${AGENT_LAST_NAME}"
AGENT_MENTION="$(echo "$AGENT_MENTION" | xargs)"  # trim

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
echo "Prime ID    : ${PRIME_ID:-<not set>}"

# ---- Firestore deploy step reporter ----
# Appends a step to the deploySteps[] array in the fleet Firestore doc
FIRESTORE_URL="https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)/documents"

write_deploy_step() {
  local step_id="$1"
  local step_label="$2"
  local step_status="${3:-done}"
  local step_detail="${4:-}"
  local new_status="${5:-}"
  local action_json="${6:-}"

  [[ -n "${PRIME_ID}" ]] || return 0

  local token
  token="$(curl -sH 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)" || return 0

  python3 - <<'PYEOF' "$token" "$step_id" "$step_label" "$step_status" "$step_detail" "$new_status" "$action_json" "${FIRESTORE_URL}" "${PRIME_ID}" "${AGENT_ID}"
import sys, json, urllib.request
from datetime import datetime, timezone

token, step_id, step_label, step_status, step_detail, new_status, action_json, fs_url, prime_id, agent_id = sys.argv[1:11]

url = f"{fs_url}/primes/{prime_id}/fleet/{agent_id}"
now = datetime.now(timezone.utc).isoformat()

# Read current doc
try:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        doc = json.loads(resp.read())
except:
    doc = {}

existing_steps = []
if "fields" in doc and "deploySteps" in doc["fields"]:
    existing_steps = doc["fields"]["deploySteps"].get("arrayValue", {}).get("values", [])

new_step = {"mapValue": {"fields": {
    "id": {"stringValue": step_id},
    "label": {"stringValue": step_label},
    "status": {"stringValue": step_status},
    "timestamp": {"stringValue": now},
}}}
if step_detail:
    new_step["mapValue"]["fields"]["detail"] = {"stringValue": step_detail}
existing_steps.append(new_step)

cur_status = "deploying"
if "fields" in doc and "status" in doc["fields"]:
    cur_status = doc["fields"]["status"].get("stringValue", "deploying")

fields = {
    "status": {"stringValue": new_status if new_status else cur_status},
    "deploySteps": {"arrayValue": {"values": existing_steps}},
}
mask = "updateMask.fieldPaths=status&updateMask.fieldPaths=deploySteps"

if action_json:
    try:
        ar = json.loads(action_json)
        ar_fields = {}
        for k, v in ar.items():
            if isinstance(v, list):
                ar_fields[k] = {"arrayValue": {"values": [{"stringValue": s} for s in v]}}
            elif isinstance(v, str):
                ar_fields[k] = {"stringValue": v}
        fields["actionRequired"] = {"mapValue": {"fields": ar_fields}}
        mask += "&updateMask.fieldPaths=actionRequired"
    except:
        pass

body = json.dumps({"fields": fields}).encode()
req = urllib.request.Request(f"{url}?{mask}", data=body, method="PATCH",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
try:
    urllib.request.urlopen(req)
except Exception as e:
    print(f"[fleet-bootstrap] Firestore write failed: {e}", file=sys.stderr)
PYEOF
}

# ---- 1) Install system packages ----
info "Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git python3 ca-certificates gnupg jq openssl
write_deploy_step "packages_installed" "System packages installed"

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
write_deploy_step "docker_installed" "Docker CE installed"

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
write_deploy_step "corekit_installed" "CoreKit installed"

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
  # identity from leaking into fleet agents. The manifest installs
  # Prime's workspace files into .openclaw/workspace/ by default.
  info "Clearing Prime workspace files..."
  rm -f "${OC_HOST_DIR}/workspace/"*.md 2>/dev/null || true

  for f in "${OC_HOST_DIR}/${WORKSPACE_SRC}"/*.md; do
    [[ -f "$f" ]] || continue
    BASENAME="$(basename "$f")"
    # Template substitution
    sed -e "s|{{AGENT_NAME}}|${AGENT_DISPLAY_NAME}|g" \
        -e "s|{{SPECIALTY}}|${SPECIALTY}|g" \
        -e "s|{{PROJECT_ID}}|${GCP_PROJECT_ID}|g" \
        -e "s|{{DEPLOY_TIMESTAMP}}|$(date -Is)|g" \
        "$f" > "${OC_HOST_DIR}/workspace/${BASENAME}"
    echo "  Deployed: ${BASENAME} (from ${WORKSPACE_SRC})"
  done
fi

# ---- 5) Write DWD chat config ----
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

# ---- 6) Save gateway token ----
mkdir -p /root/.openclaw
echo "${MY_TOKEN}" > /root/.openclaw/.gateway-token
chmod 600 /root/.openclaw/.gateway-token

# ---- 7) Clone + build OpenClaw Docker image ----
info "Cloning OpenClaw repo..."
cd /root
if [[ ! -d openclaw/.git ]]; then
  git clone https://github.com/openclaw/openclaw.git
fi
cd openclaw
git fetch --all --prune
# Pin to same known-good commit as Prime
OC_PIN="163c6f5e354be2a8e2ff5b11a237077beb9e70fe"
STABLE_COMMIT="${OC_PIN}"
git checkout "${STABLE_COMMIT}"
info "Using OpenClaw commit: ${STABLE_COMMIT} (pinned)"

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
GOOGLE_CLOUD_LOCATION=us-central1
GCE_METADATA_HOST=metadata.google.internal
EOF

info "Building Docker image openclaw:local ..."
DOCKER_BUILDKIT=1 docker build -t openclaw:local .
write_deploy_step "openclaw_built" "OpenClaw Docker image built"

# ---- 8) Run OpenClaw container ----
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

# ---- 9) Wait for gateway readiness ----
info "Waiting for OpenClaw gateway..."
READY=false
MAX_WAIT=180
WAITED=0
INTERVAL=5
while [[ "$WAITED" -lt "$MAX_WAIT" ]]; do
  if docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.get --json --params '{}' > /dev/null 2>&1; then
    READY=true
    break
  fi
  echo "  Gateway not ready yet (${WAITED}s elapsed, retrying in ${INTERVAL}s)..."
  sleep "$INTERVAL"
  WAITED=$((WAITED + INTERVAL))
done
[[ "$READY" == "true" ]] || { echo "[ERROR] Gateway did not become ready within ${MAX_WAIT}s"; exit 1; }
info "Gateway is ready (took ~${WAITED}s)."
write_deploy_step "gateway_ready" "OpenClaw gateway started" "done" "Ready in ~${WAITED}s"

# ---- 10) Harden container perms ----
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

# ---- 11) Render fleet config template ----
info "Rendering fleet bootstrap config..."
FLEET_TMPL="${OC_HOST_DIR}/corekit/openclaw-fleet-bootstrap.json5.tmpl"
if [[ ! -f "$FLEET_TMPL" ]]; then
  # Fall back to prime template if fleet template not installed
  FLEET_TMPL="${OC_HOST_DIR}/corekit/openclaw-bootstrap.json5.tmpl"
  warn "Fleet config template not found, using prime template"
fi

python3 - <<PY
import pathlib
tmpl_path = pathlib.Path("${FLEET_TMPL}")
out_path = pathlib.Path("/tmp/openclaw-bootstrap.json5")
tmpl = tmpl_path.read_text(encoding="utf-8")
tmpl = tmpl.replace("\${GCP_PROJECT_ID}", "${GCP_PROJECT_ID}")
tmpl = tmpl.replace("\${MY_TOKEN}", "${MY_TOKEN}")
tmpl = tmpl.replace("\${AGENT_ID}", "${AGENT_ID}")
tmpl = tmpl.replace("\${AGENT_DISPLAY_NAME}", "${AGENT_DISPLAY_NAME}")
out_path.write_text(tmpl, encoding="utf-8")
PY

# ---- 12) Apply config via RPC ----
info "Applying fleet config..."
APPLY_OK=false
for attempt in 1 2 3 4 5; do
  BASE_HASH="$(docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.get --json --params '{}' 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("hash",""))' 2>/dev/null || true)"
  if [[ -z "$BASE_HASH" ]]; then
    warn "config.get returned no hash (attempt $attempt). Retrying in 15s..."
    sleep 15
    continue
  fi

  PARAMS="$(python3 - <<PYAPPLY
import json
raw=open("/tmp/openclaw-bootstrap.json5","r",encoding="utf-8").read()
print(json.dumps({"raw": raw, "baseHash": "${BASE_HASH}", "note": "fleet-bootstrap"}))
PYAPPLY
)"

  if docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.apply --json --params "${PARAMS}" 2>&1; then
    APPLY_OK=true
    break
  fi
  warn "config.apply attempt ${attempt} failed. Retrying in 15s..."
  sleep 15
done

if [[ "$APPLY_OK" != "true" ]]; then
  info "Checking if config was written despite errors..."
  sleep 10
  if docker exec openclaw-gateway test -f /home/node/.openclaw/openclaw.json 2>/dev/null; then
    info "openclaw.json exists — config.apply likely succeeded."
    APPLY_OK=true
  else
    echo "[ERROR] config.apply failed after 5 attempts"
    exit 1
  fi
fi
write_deploy_step "config_applied" "Agent config applied"

# ---- 13) Post-apply harden + inject Docker CLI ----
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

# ---- 14) Install gcloud CLI + jq + PATH in container ----
info "Installing gcloud CLI and dependencies in container..."
docker exec -u 0 openclaw-gateway bash -c '
set -e
if ! which gcloud >/dev/null 2>&1; then
  curl -sfL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz | tar xz -C /tmp
  /tmp/google-cloud-sdk/install.sh --quiet --path-update=true --usage-reporting=false 2>/dev/null
  ln -sf /tmp/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
  echo "  gcloud installed"
fi
which jq >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq jq >/dev/null 2>&1; }

PROFILE="/home/node/.bashrc"
grep -q ".openclaw/bin" "$PROFILE" 2>/dev/null || echo "export PATH=\"/home/node/.openclaw/bin:\$PATH\"" >> "$PROFILE"
cat > /etc/profile.d/openclaw-path.sh << "PATHEOF"
export PATH="/home/node/.openclaw/bin:$PATH"
PATHEOF
chmod +x /etc/profile.d/openclaw-path.sh
CURRENT_PATH=$(grep "^PATH=" /etc/environment 2>/dev/null | cut -d= -f2 || echo "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
echo "PATH=/home/node/.openclaw/bin:${CURRENT_PATH}" > /etc/environment
chown node:node /home/node/.bashrc
' || warn "gcloud/PATH setup had non-fatal errors"

# ---- 15) Vertex AI ADC fix (same as Prime) ----
info "Applying Vertex AI ADC auth fix..."
docker exec -u 0 openclaw-gateway bash -c '
set -e
AP="/home/node/.openclaw/agents/main/agent/auth-profiles.json"
if [ -f "$AP" ]; then
  echo "{\"version\":1,\"profiles\":{}}" > "$AP"
  chown node:node "$AP"
  chmod 600 "$AP"
  echo "  auth-profiles.json emptied"
fi

AUTH_ENV_FILE=$(find /app/dist -name "model-auth-env-*" -type f 2>/dev/null | head -1)
if [ -n "$AUTH_ENV_FILE" ]; then
  if grep -q "if (!envKey) return null;" "$AUTH_ENV_FILE" 2>/dev/null; then
    sed -i '\''s|if (!envKey) return null;|if (!envKey) return { apiKey: "<gce-adc>", source: "gce metadata" };|'\'' "$AUTH_ENV_FILE"
    echo "  Patched model-auth-env: GCE ADC fallback enabled"
  elif grep -q "gce-adc" "$AUTH_ENV_FILE" 2>/dev/null; then
    echo "  model-auth-env already patched"
  fi
fi
rm -f /home/node/.config/gcloud/application_default_credentials.json 2>/dev/null || true
' || warn "ADC fix had non-fatal errors"

# ---- 16) Install inbox-daemon systemd service ----
info "Installing inbox-daemon systemd service..."
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
# Only start if we have the required DWD config
if [[ -n "${AGENT_USER_EMAIL}" && -n "${DWD_SIGNER_SA}" ]]; then
  systemctl start inbox-daemon || warn "inbox-daemon start failed (DWD may not be configured)"
  write_deploy_step "inbox_installed" "Inbox daemon started"
else
  warn "inbox-daemon not started — AGENT_USER_EMAIL or DWD_SIGNER_SA not set"
  write_deploy_step "inbox_installed" "Inbox daemon skipped (no email/DWD config)" "skipped"
fi

# ---- 17) Update Firestore status ----
# Check if DWD healthcheck is working before declaring online
info "Checking DWD healthcheck..."
DWD_OK=false
if [[ -n "${AGENT_USER_EMAIL}" && -n "${DWD_SIGNER_SA}" ]]; then
  # Quick DWD token test (same as inbox-daemon healthcheck)
  DWD_TOKEN_CMD="${OC_HOST_DIR}/bin/dwd-token"
  if [[ -x "$DWD_TOKEN_CMD" ]]; then
    DWD_TEST="$(AGENT_USER_EMAIL="${AGENT_USER_EMAIL}" DWD_SIGNER_SA="${DWD_SIGNER_SA}" \
      GCP_PROJECT_ID="${GCP_PROJECT_ID}" "$DWD_TOKEN_CMD" 2>/dev/null || true)"
    if [[ -n "$DWD_TEST" && "$DWD_TEST" != *"error"* ]]; then
      DWD_OK=true
    fi
  fi
fi

info "Updating Firestore status..."
if [[ "$DWD_OK" == "true" ]]; then
  # DWD works — agent is fully online
  write_deploy_step "online" "Agent online" "done" "" "online"
  # Clear actionRequired since everything is working
  if [[ -n "${PRIME_ID}" ]]; then
    FS_TOKEN="$(curl -sH 'Metadata-Flavor: Google' \
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
      | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || true)"
    if [[ -n "$FS_TOKEN" ]]; then
      curl -s -X PATCH \
        -H "Authorization: Bearer $FS_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"fields":{"actionRequired":{"nullValue":null}}}' \
        "${FIRESTORE_URL}/primes/${PRIME_ID}/fleet/${AGENT_ID}?updateMask.fieldPaths=actionRequired" \
        > /dev/null 2>&1 || true
    fi
  fi
else
  # DWD failed — agent infrastructure is ready but needs admin action
  ACTION_JSON=$(python3 -c "
import json
print(json.dumps({
    'type': 'workspace_user',
    'title': 'Create Workspace user account for DWD authentication',
    'instructions': [
        'Create Workspace user at https://admin.google.com/ac/users — First: ${AGENT_FIRST_NAME:-Agent}, Last: ${AGENT_LAST_NAME:-${AGENT_ID}}, Email: ${AGENT_USER_EMAIL}',
        'Add ${AGENT_USER_EMAIL} to the AI Fleet Command Chat space',
        'The agent will come online automatically once the user exists and DWD succeeds'
    ]
}))
")
  write_deploy_step "dwd_healthcheck" "DWD healthcheck failed — awaiting admin action" "failed" "Workspace user may not exist yet" "needs_action" "$ACTION_JSON"
fi

# ---- 18) Boot announce via DWD ----
if [[ "$DWD_OK" == "true" && -n "${CHAT_SPACE_ID}" && -n "${AGENT_USER_EMAIL}" ]]; then
  export CHAT_SPACE_ID OC_HOST_ROOT
  "${OC_HOST_DIR}/bin/chat-send" \
    "🤖 Fleet agent *${AGENT_DISPLAY_NAME}* is online (OpenClaw).
Specialty: ${SPECIALTY}
Project: \`${GCP_PROJECT_ID}\`
CoreKit: \`${CORE_REF}\`" || warn "Chat announce failed"
fi

# ---- Done ----
echo
echo "============================================"
echo "  FLEET AGENT SETUP COMPLETE"
echo "============================================"
echo "  Log file       : ${LOG_FILE}"
echo "  Gateway token  : ${MY_TOKEN}"
echo "  OpenClaw commit: ${STABLE_COMMIT}"
echo "  Agent          : ${AGENT_DISPLAY_NAME} (${SPECIALTY})"
echo "  Project        : ${GCP_PROJECT_ID}"
if [[ "$DWD_OK" != "true" ]]; then
  echo "  DWD Status     : ⚠️  NEEDS ADMIN ACTION"
  echo "  → Create Workspace user: ${AGENT_USER_EMAIL}"
  echo "  → Add to Chat space"
fi
echo "============================================"
