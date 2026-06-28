#!/usr/bin/env bash
# ============================================================
# prime-bootstrap.sh — Prime VM setup (Native Node.js Brain)
#
# Downloaded and executed by the deploy API's boot stub.
# All config is read from VM metadata attributes.
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
GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo 'YOUR_GITHUB_ORG')"
GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo 'architect-prime-gcp-agent')"
GCP_PROJECT_ID="$(curl -sf -H "$MH" "$META/project/project-id")"

MY_TOKEN="$(openssl rand -hex 16)"
CORE_ROOT="/opt/corekit"
CORE_DIR="${CORE_ROOT}"
CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

info "Prime VM Bootstrap: $(date -Is)"
echo "Prime ID    : ${PRIME_ID}"
echo "Agent       : ${AGENT_ID}"
echo "CoreRef     : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "Project     : ${GCP_PROJECT_ID}"

FIRESTORE_URL="https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)/documents"
VM_NAME="prime-${PRIME_ID}"
DEPLOY_TS="$(date -Is)"

# ---- Deploy step tracking (writes to primes/{id}.deploySteps[]) ----
write_deploy_step() {
  local step_id="$1"
  local step_label="$2"
  local step_status="${3:-done}"   # done | active | failed | pending
  local step_detail="${4:-}"

  [[ "$PRIME_ID" != "unknown" ]] || return 0

  local token
  token="$(curl -sH 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)" || return 0

  python3 - <<PYEOF "$token" "$step_id" "$step_label" "$step_status" "$step_detail"
import sys, json, urllib.request
from datetime import datetime, timezone

token, step_id, step_label, step_status, step_detail = sys.argv[1:6]
now = datetime.now(timezone.utc).isoformat()
fs_url = "${FIRESTORE_URL}/primes/${PRIME_ID}"

# Read current doc
try:
    req = urllib.request.Request(fs_url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        doc = json.loads(resp.read())
except:
    doc = {}

# Extract existing deploySteps
existing_steps = []
if "fields" in doc and "deploySteps" in doc["fields"]:
    existing_steps = doc["fields"]["deploySteps"].get("arrayValue", {}).get("values", [])

# Build new step
new_step = {"mapValue": {"fields": {
    "id": {"stringValue": step_id},
    "label": {"stringValue": step_label},
    "status": {"stringValue": step_status},
    "timestamp": {"stringValue": now},
}}}
if step_detail:
    new_step["mapValue"]["fields"]["detail"] = {"stringValue": step_detail}

# Update existing step in-place or append
updated = False
for i, s in enumerate(existing_steps):
    flds = s.get("mapValue", {}).get("fields", {})
    if flds.get("id", {}).get("stringValue") == step_id:
        existing_steps[i] = new_step
        updated = True
        break
if not updated:
    existing_steps.append(new_step)

fields = {
    "deploySteps": {"arrayValue": {"values": existing_steps}},
}
mask = "updateMask.fieldPaths=deploySteps"

body = json.dumps({"fields": fields}).encode()
req = urllib.request.Request(f"{fs_url}?{mask}", data=body, method="PATCH",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
try:
    urllib.request.urlopen(req)
except Exception as e:
    print(f"[prime-bootstrap] Firestore step write failed: {e}", file=sys.stderr)
PYEOF
}

# Seed all expected steps as pending
init_deploy_steps() {
  [[ "$PRIME_ID" != "unknown" ]] || return 0

  local token
  token="$(curl -sH 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)" || return 0

  python3 - <<PYEOF "$token"
import sys, json, urllib.request
from datetime import datetime, timezone

token = sys.argv[1]
now = datetime.now(timezone.utc).isoformat()
fs_url = "${FIRESTORE_URL}/primes/${PRIME_ID}"

all_steps = [
    ("deploy_started", "Deployment initiated", "done"),
    ("packages", "System packages", "pending"),
    ("nodejs", "Node.js installed", "pending"),
    ("corekit", "CoreKit installed", "pending"),
    ("contracts", "Contracts loaded", "pending"),
    ("brain_deps", "Brain dependencies installed", "pending"),
    ("neural_gateway", "Neural gateway started", "pending"),
    ("neural_ready", "Neural gateway ready", "pending"),
    ("services", "Systemd services installed", "pending"),
    ("command_runner", "Command runner started", "pending"),
    ("online", "Prime online", "pending"),
]

steps_values = []
for sid, slabel, sstatus in all_steps:
    step = {"mapValue": {"fields": {
        "id": {"stringValue": sid},
        "label": {"stringValue": slabel},
        "status": {"stringValue": sstatus},
        "timestamp": {"stringValue": now if sstatus == "done" else ""},
    }}}
    steps_values.append(step)

fields = {
    "status": {"stringValue": "deploying"},
    "deploySteps": {"arrayValue": {"values": steps_values}},
    "vmName": {"stringValue": "${VM_NAME}"},
    "zone": {"stringValue": "us-central1-a"},
    "deployedAt": {"stringValue": "${DEPLOY_TS}"},
}
mask = "&".join(f"updateMask.fieldPaths={f}" for f in fields.keys())
body = json.dumps({"fields": fields}).encode()
req = urllib.request.Request(f"{fs_url}?{mask}", data=body, method="PATCH",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
try:
    urllib.request.urlopen(req)
except Exception as e:
    print(f"[prime-bootstrap] Init steps failed: {e}", file=sys.stderr)
PYEOF
}

init_deploy_steps

# ============================================================
# PHASE 1 — System setup
# ============================================================

# ---- 1) Install system packages ----
info "Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git python3 ca-certificates gnupg jq openssl

write_deploy_step "packages" "System packages" "done"


# ---- 3) Install Node.js & npm ----
info "Installing Node.js & npm..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

write_deploy_step "nodejs" "Node.js installed" "done" "$(node --version 2>/dev/null || echo 'unknown')"

# ---- 4) Install CoreKit via manifest (base + prime) ----
info "Installing CoreKit..."
mkdir -p "${CORE_DIR}"
curl -sfL "${CORE_BASE}/infra/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
CORE_REF="${CORE_REF}" \
  GH_OWNER="${GH_OWNER}" \
  GH_REPO="${GH_REPO}" \
  CORE_ROOT="${CORE_ROOT}" \
  bash /tmp/install.sh --role prime

write_deploy_step "corekit" "CoreKit installed" "done"

# ---- 5) Read contracts.json for cross-cutting values ----
CONTRACTS="${CORE_DIR}/corekit/contracts.json"
if [[ -f "$CONTRACTS" ]]; then
  C_LOCATION="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['vertex']['location'])")"
  C_GATEWAY_PORT="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['gateway']['port'])")"
  info "Contracts loaded: location=${C_LOCATION} port=${C_GATEWAY_PORT}"
else
  warn "contracts.json not found — using defaults"
  C_LOCATION="us-central1"
  C_GATEWAY_PORT="18789"
fi

write_deploy_step "contracts" "Contracts loaded" "done" "location=${C_LOCATION}"

# ---- 6) Save gateway token for ears/mouth ----
echo "${MY_TOKEN}" > "${CORE_DIR}/.gateway-token"
chmod 600 "${CORE_DIR}/.gateway-token"

# ============================================================
# PHASE 2 — Brain Module setup
# ============================================================

# ---- 7) Install brain dependencies ----
info "Installing brain module dependencies..."
cd "${CORE_DIR}/corekit/brain"
npm install --omit=dev 2>&1 | tail -5
chown -R 1000:1000 node_modules 2>/dev/null || true

write_deploy_step "brain_deps" "Brain dependencies installed" "done"

# ---- 8) Write agent configs from contracts ----
info "Writing agent configs..."
C_SUBAGENT_IDS="$(python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
print(' '.join(c['agents']['subagentIds']))
" 2>/dev/null || echo "temporal-research temporal-memory prefrontal motor cerebellum")"

for AGENT_ID in cortex ${C_SUBAGENT_IDS}; do
  AGENT_DIR="${CORE_DIR}/workspace-${AGENT_ID}"
  if [[ "${AGENT_ID}" == "cortex" ]]; then
    AGENT_DIR="${CORE_DIR}/workspace"
  fi
  mkdir -p "${AGENT_DIR}"
  
  # config.json: model, fallback, maxSteps
  python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
agent_config = {
  'model': c['vertex']['models'].get('cortex' if '${AGENT_ID}' == 'cortex' else 'subagent', 'vertex-google/gemini-2.5-flash'),
  'fallbackModel': c['vertex']['models'].get('cortexFallback', 'vertex-google/gemini-2.5-flash'),
  'maxSteps': c['dispatch']['max_iterations'],
}
json.dump(agent_config, open('${AGENT_DIR}/config.json', 'w'), indent=2)
"
done

# ---- 9) Start brain as systemd service ----
info "Starting neural gateway service..."
cat > /etc/systemd/system/agent-neural-gateway.service <<UNIT
[Unit]
Description=Architect Prime Neural Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${CORE_DIR}/corekit/brain
Environment=GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}
Environment=GOOGLE_CLOUD_LOCATION=${C_LOCATION}
Environment=BRAIN_PORT=${C_GATEWAY_PORT}
Environment=CONTRACTS_PATH=${CONTRACTS}
Environment=AGENTS_DIR=${CORE_DIR}
Environment=WORKSPACE_BASE=${CORE_DIR}
ExecStart=/usr/bin/node index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now agent-neural-gateway

write_deploy_step "neural_gateway" "Neural gateway started" "active" "Waiting for healthz..."

# ---- 10) Wait for neural gateway readiness ----
info "Waiting for neural gateway..."
WAITED=0
until curl -sf http://127.0.0.1:${C_GATEWAY_PORT}/healthz > /dev/null 2>&1; do
  sleep 2; WAITED=$((WAITED+2))
  [[ $WAITED -ge 60 ]] && { echo "[ERROR] Neural gateway did not start within 60s"; exit 1; }
done
info "Neural gateway is ready (took ~${WAITED}s)."

write_deploy_step "neural_ready" "Neural gateway ready" "done" "Took ~${WAITED}s"

# ---- 11) Warm-up probe (pre-warm ADC tokens) ----
info "Running warm-up probe..."
curl -s --max-time 30 -X POST "http://localhost:${C_GATEWAY_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MY_TOKEN}" \
  -d '{"model":"brain/cortex","messages":[{"role":"user","content":"System warm-up. Respond: ready."}]}' \
  > /dev/null 2>&1 || warn "Warm-up probe failed (non-fatal)"

# ============================================================
# PHASE 3 — finalize
# ============================================================

# ---- 12) Write prime-config.json ----
cat > "${CORE_DIR}/corekit/prime-config.json" <<PCFG
{
  "primeId": "${PRIME_ID}",
  "projectId": "${GCP_PROJECT_ID}",
  "role": "prime"
}
PCFG

# ---- 12b) Write identity lockfile ----
PRIME_EMAIL=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/agent_user_email" 2>/dev/null || true)
if [[ -n "${PRIME_EMAIL}" ]]; then
  echo "${PRIME_EMAIL}" > "${CORE_DIR}/.identity-lock"
  chmod 444 "${CORE_DIR}/.identity-lock"
  info "Identity lock: ${PRIME_EMAIL}"
fi

# ---- 12c) Shared workspace architecture ----
info "Setting up shared workspace architecture..."
SHARED_DIR="${CORE_DIR}/shared"
mkdir -p "$SHARED_DIR"
for dir in "${CORE_DIR}"/workspace*; do
  if [[ -d "$dir" ]]; then
    ln -snf "$SHARED_DIR" "$dir/shared"
  fi
done

# ---- 12d) Run assemble-persona for prime ----
ASSEMBLE="${CORE_DIR}/bin/assemble-persona"
if [[ -x "$ASSEMBLE" ]]; then
  info "Assembling persona for prime..."
  CORE_DIR="${CORE_DIR}" "$ASSEMBLE" "prime" || warn "assemble-persona failed"
fi

# ---- 12e) Install skill dependencies ----
SKILL_SETUP="${CORE_DIR}/bin/skill-setup"
if [[ -x "$SKILL_SETUP" ]]; then
  "$SKILL_SETUP" --all || warn "skill-setup had errors"
fi

# ---- 12e) Final permissions sweep ----
info "Final permissions sweep..."
find "${CORE_DIR}" -type d -exec chmod 755 {} \; 2>/dev/null || true
find "${CORE_DIR}/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true

# ---- 13) Install agent-ears, agent-mouth, agent-brain, agent-introspect as systemd services ----
info "Installing systemd services..."
for svc in agent-ears agent-mouth agent-brain agent-introspect; do
  SVC_SRC="${CORE_DIR}/corekit/${svc}.service"
  if [[ -f "$SVC_SRC" ]]; then
    cp "$SVC_SRC" "/etc/systemd/system/${svc}.service"
  fi
done

systemctl daemon-reload
systemctl enable agent-ears agent-mouth agent-brain agent-introspect 2>/dev/null || true
systemctl start agent-ears agent-mouth agent-brain agent-introspect

write_deploy_step "services" "Systemd services installed" "done" "ears + mouth + brain + introspect"

# ---- 14) Install command-runner as systemd service ----
info "Installing command-runner systemd service..."
cat > /etc/systemd/system/command-runner.service <<CRUNIT
[Unit]
Description=Architect Prime Command Runner (Deterministic Operations)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=CORE_ROOT=${CORE_ROOT}
Environment=GCP_PROJECT_ID=${GCP_PROJECT_ID}
Environment=PRIME_ID=${PRIME_ID}
Environment=AGENT_ID=${AGENT_ID:-prime}
Environment=PATH=/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=POLL_INTERVAL=5
ExecStart=${CORE_DIR}/bin/command-runner
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
CRUNIT

systemctl daemon-reload
systemctl enable command-runner
systemctl start command-runner

write_deploy_step "command_runner" "Command runner started" "done"

# ---- 15) Install fleet-health-check timer ----
info "Installing fleet-health-check systemd timer..."
cp "${CORE_DIR}/corekit/fleet-health-check.service" /etc/systemd/system/fleet-health-check.service
cp "${CORE_DIR}/corekit/fleet-health-check.timer" /etc/systemd/system/fleet-health-check.timer
chmod +x "${CORE_DIR}/bin/fleet-health-check"
chmod +x "${CORE_DIR}/bin/update-deep-truths"
systemctl daemon-reload
systemctl enable fleet-health-check.timer
systemctl start fleet-health-check.timer

# ---- Done ----
write_deploy_step "online" "Prime online" "done"

# Mark prime as online in Firestore
if [[ "$PRIME_ID" != "unknown" ]]; then
  FINAL_TOKEN="$(curl -sH 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)" || true
  if [[ -n "$FINAL_TOKEN" ]]; then
    curl -sf -X PATCH \
      "${FIRESTORE_URL}/primes/${PRIME_ID}?updateMask.fieldPaths=status" \
      -H "Authorization: Bearer ${FINAL_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"fields":{"status":{"stringValue":"online"}}}' \
      >/dev/null 2>&1 || true
  fi
fi

echo
echo "============================================"
echo "  PRIME VM SETUP COMPLETE"
echo "============================================"
echo "  Log file       : ${LOG_FILE}"
echo "  Gateway token  : ${MY_TOKEN}"
echo "  CoreKit        : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "  Project        : ${GCP_PROJECT_ID}"
echo "  Prime ID       : ${PRIME_ID}"
echo "  I/O Services   : agent-ears + agent-mouth"
echo "  Health check   : fleet-health-check.timer"
echo "============================================"
