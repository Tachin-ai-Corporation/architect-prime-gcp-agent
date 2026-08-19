#!/usr/bin/env bash
# ============================================================
# fleet-bootstrap.sh — Fleet Agent VM setup (Native Node.js Brain)
#
# Downloaded and executed by fleet-deploy's boot stub.
# All config is read from VM metadata attributes.
# ============================================================
set -euo pipefail

export HOME="${HOME:-/root}"
export USER="${USER:-$(whoami)}"

LOG_FILE="/var/log/fleet-agent-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "Log: $LOG_FILE"; exit 1' ERR

info(){ echo -e "\n==> $*\n"; }
ok()  { echo -e "\n[ OK ] $*\n"; }
warn(){ echo -e "\n[WARN] $*\n"; }

# ---- Read config from VM metadata ----
META="http://metadata.google.internal/computeMetadata/v1"
MH="Metadata-Flavor: Google"
AGENT_ID="$(curl -sf -H "$MH" "$META/instance/attributes/agent_id" || echo 'unknown')"
SPECIALTY="$(curl -sf -H "$MH" "$META/instance/attributes/specialty" || echo 'general')"
CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || echo 'main')"
GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo 'YOUR_GITHUB_ORG')"
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
OPERATOR_JOBS="$(curl -sf -H "$MH" "$META/instance/attributes/operator_jobs" || true)"

AGENT_MENTION="${AGENT_FIRST_NAME} ${AGENT_LAST_NAME}"
AGENT_MENTION="$(echo "$AGENT_MENTION" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

MY_TOKEN="$(openssl rand -hex 16)"
CORE_ROOT="/opt/corekit"
CORE_DIR="${CORE_ROOT}"

# ---- C-35: resolve the channel to an immutable commit before anything reads it ----
# VM metadata may legitimately carry a human channel ("main", "STABLE", a tag).
# This is the boundary where it stops being one: everything downstream — the
# manifest fetches below, install.sh, STATE.json — sees only a commit SHA. If we
# cannot resolve, we abort rather than install from a moving target.
resolve_core_ref() {
  local ref="$1"
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] && { echo "$ref"; return 0; }
  curl -fsSL -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/commits/${ref}" 2>/dev/null \
    | grep -m1 '"sha"' | cut -d'"' -f4
}
RESOLVED_REF="$(resolve_core_ref "$CORE_REF")"
if [[ ! "$RESOLVED_REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[ERROR] Could not resolve '${CORE_REF}' to a commit in ${GH_OWNER}/${GH_REPO}." >&2
  echo "        Refusing to bootstrap from a mutable ref (C-35)." >&2
  exit 1
fi
[[ "$RESOLVED_REF" != "$CORE_REF" ]] && info "Resolved ${CORE_REF} -> ${RESOLVED_REF:0:12}"
CORE_REF="$RESOLVED_REF"

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


# ---- 2) Install Node.js & npm ----
info "Installing Node.js & npm..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi


# ---- 3) Install CoreKit via manifest ----
info "Installing CoreKit..."
mkdir -p "${CORE_DIR}"
# Per-run temp file. A fixed /tmp name is owned by whoever ran the bootstrap
# first, so a re-run under a different user fails to overwrite it and installs
# whatever the previous run left there — silently, and at the one moment the
# machine has no other source of truth.
INSTALLER="$(mktemp -t corekit-install.XXXXXX)"
trap 'rm -f "$INSTALLER"' EXIT
curl -sfL "${CORE_BASE}/infra/install.sh" -o "$INSTALLER"
chmod +x "$INSTALLER"
# Export the CoreKit source so install.sh (a CHILD process) inherits it. Without `export`
# these are unexported shell variables — install.sh then silently falls back to its
# `GH_OWNER=YOUR_GITHUB_ORG` / `CORE_REF=main` defaults and 404s on the very first manifest
# fetch. (Only JOB_FLAGS is safe as a plain var: it is expanded by THIS shell on the bash line
# below, not read from install.sh's environment.) A missing trailing `\` on the JOB_FLAGS line
# had detached these assignments from the `bash "$INSTALLER"` invocation, so they applied to
# nothing.
export CORE_REF GH_OWNER GH_REPO CORE_ROOT
JOB_FLAGS="--job ${SPECIALTY}"
# Append operator job layers (comma-separated in VM metadata)
if [[ -n "$OPERATOR_JOBS" ]]; then
  IFS=',' read -ra OJ_ARRAY <<< "$OPERATOR_JOBS"
  for oj in "${OJ_ARRAY[@]}"; do
    oj="$(echo "$oj" | xargs)"  # trim whitespace
    [[ -n "$oj" ]] && JOB_FLAGS="$JOB_FLAGS --job $oj"
  done
fi
# INSTALL_VALIDATE=defer: on first boot the runtime is not assembled yet
# (no workspaces, no chat-config), so runtime contract checks legitimately fail
# here. The bootstrap runs the same validation as a hard gate at the end (step 13b).
INSTALL_VALIDATE="defer" bash "$INSTALLER" --role fleet $JOB_FLAGS

# ---- 4) Read contracts.json for cross-cutting values ----
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

# ---- 5) Save gateway token for ears/mouth ----
echo "${MY_TOKEN}" > "${CORE_DIR}/.gateway-token"
chmod 600 "${CORE_DIR}/.gateway-token"

# ============================================================
# PHASE 2 — Brain Module setup
# ============================================================

# ---- 6) Install brain dependencies ----
info "Installing brain module dependencies..."
cd "${CORE_DIR}/corekit/brain"
# `npm ci` when a lockfile is present: install the exact reviewed tree, not
# whatever the registry resolves today. Falls back to `npm install` only for a
# pre-lockfile CoreKit ref.
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev 2>&1 | tail -5
else
  echo "[WARN] no package-lock.json — dependency tree is not reproducible"
  npm install --omit=dev 2>&1 | tail -5
fi
chown -R 1000:1000 node_modules 2>/dev/null || true

# ---- 7) Write agent configs from contracts ----
info "Writing agent configs..."
C_SUBAGENT_IDS="$(python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
print(' '.join(c['agents']['subagentIds']))
" 2>/dev/null || echo "temporal-research temporal-memory prefrontal motor cerebellum")"

for AGENT_ID_ITEM in cortex ${C_SUBAGENT_IDS}; do
  AGENT_DIR="${CORE_DIR}/workspace-${AGENT_ID_ITEM}"
  if [[ "${AGENT_ID_ITEM}" == "cortex" ]]; then
    AGENT_DIR="${CORE_DIR}/workspace"
  fi
  mkdir -p "${AGENT_DIR}"
  
  # config.json: model, fallback, maxSteps
  python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
agent_config = {
  'model': c['vertex']['models'].get('cortex' if '${AGENT_ID_ITEM}' == 'cortex' else 'subagent', 'vertex-google/gemini-3.6-flash'),
  'fallbackModel': c['vertex']['models'].get('cortexFallback', 'vertex-google/gemini-3.6-flash'),
  'maxSteps': c['dispatch']['max_iterations'],
}
json.dump(agent_config, open('${AGENT_DIR}/config.json', 'w'), indent=2)
"
done

# ---- 8) Start brain as systemd service ----
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
Environment=AGENT_ID=${AGENT_ID}
ExecStart=/usr/bin/node index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now agent-neural-gateway

# ---- 9) Wait for neural gateway readiness ----
info "Waiting for neural gateway..."
WAITED=0
until curl -sf http://127.0.0.1:${C_GATEWAY_PORT}/healthz > /dev/null 2>&1; do
  sleep 2; WAITED=$((WAITED+2))
  [[ $WAITED -ge 60 ]] && { echo "[ERROR] Neural gateway did not start within 60s"; exit 1; }
done
info "Neural gateway is ready (took ~${WAITED}s)."

# ---- 10) Warm-up probe (pre-warm ADC tokens) ----
info "Running warm-up probe..."
curl -s --max-time 30 -X POST "http://localhost:${C_GATEWAY_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MY_TOKEN}" \
  -d '{"model":"brain/cortex","messages":[{"role":"user","content":"System warm-up. Respond: ready."}]}' \
  > /dev/null 2>&1 || warn "Warm-up probe failed (non-fatal)"

# ============================================================
# PHASE 3 — finalize
# ============================================================

# ---- 11) Write chat-config.json (ears uses this to select gchat channel) ----
if [[ -n "${AGENT_USER_EMAIL}" ]]; then
  info "Writing Google Chat config..."
  cat > "${CORE_DIR}/corekit/chat-config.json" <<CHATCFG
{
  "primeId": "${PRIME_ID}",
  "agentId": "${AGENT_ID}",
  "agentDisplayName": "${AGENT_DISPLAY_NAME}",
  "agentUserEmail": "${AGENT_USER_EMAIL}",
  "chatSpaceId": "${CHAT_SPACE_ID}",
  "agentFirstName": "${AGENT_FIRST_NAME}",
  "agentLastName": "${AGENT_LAST_NAME}",
  "agentMention": "${AGENT_MENTION}",
  "projectId": "${GCP_PROJECT_ID}",
  "dwdSignerSa": "${DWD_SIGNER_SA}",
  "geminiProject": "${GCP_PROJECT_ID}",
  "agentType": "${SPECIALTY}",
  "specialty": "${SPECIALTY}"
}
CHATCFG
fi

# ---- 11b) Write identity lockfile ----
if [[ -n "${AGENT_USER_EMAIL}" ]]; then
  echo "${AGENT_USER_EMAIL}" > "${CORE_DIR}/.identity-lock"
  chmod 444 "${CORE_DIR}/.identity-lock"
  info "Identity lock: ${AGENT_USER_EMAIL}"
fi

# ---- 11c) Shared workspace architecture ----
info "Setting up shared workspace architecture..."
SHARED_DIR="${CORE_DIR}/shared"
mkdir -p "$SHARED_DIR"
for dir in "${CORE_DIR}"/workspace*; do
  if [[ -d "$dir" ]]; then
    ln -snf "$SHARED_DIR" "$dir/shared"
  fi
done

# ---- 11e) Provision git artifact substrate bucket (idempotent) ----
info "Provisioning git artifact bucket..."
GIT_BUCKET="$(node -e "const c=JSON.parse(require('fs').readFileSync('${CORE_DIR}/corekit/contracts.json','utf8'));console.log((c.git||{}).bucket||'')" 2>/dev/null || echo '')"
GIT_BUCKET="${GIT_BUCKET//\$\{TENANT\}/${GCP_PROJECT_ID}}"
if [[ -n "$GIT_BUCKET" ]]; then
  if gcloud storage buckets describe "gs://${GIT_BUCKET}" --project="${GCP_PROJECT_ID}" &>/dev/null; then
    info "Git bucket gs://${GIT_BUCKET} already exists — skipping"
  else
    gcloud storage buckets create "gs://${GIT_BUCKET}" \
      --project="${GCP_PROJECT_ID}" \
      --location="us-central1" \
      --uniform-bucket-level-access \
      --public-access-prevention 2>&1 || warn "Git bucket creation failed (may already exist)"
    info "Git bucket gs://${GIT_BUCKET} created"
  fi
  SA_EMAIL="$(curl -sf -H "$MH" "$META/instance/service-accounts/default/email" || echo '')"
  if [[ -n "$SA_EMAIL" ]]; then
    gcloud storage buckets add-iam-policy-binding "gs://${GIT_BUCKET}" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="roles/storage.objectAdmin" \
      --project="${GCP_PROJECT_ID}" 2>&1 || warn "Git bucket IAM binding failed"
  fi
fi

# ---- 11d) Final permissions sweep ----
info "Final permissions sweep..."
find "${CORE_DIR}" -type d -exec chmod 755 {} \; 2>/dev/null || true
find "${CORE_DIR}/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true

# ---- Render workspace templates ----
echo "==> Rendering workspace templates"
# Escape sed-special chars in values
TPL_NAME_ESC="${AGENT_DISPLAY_NAME//&/\\&}"
TPL_SPECIALTY_ESC="${SPECIALTY//&/\\&}"
TPL_EMAIL_ESC="${AGENT_USER_EMAIL//&/\\&}"
TPL_PROJECT_ESC="${GCP_PROJECT_ID//&/\\&}"
for f in "${CORE_ROOT}"/workspace*/*.md; do
  [[ -f "$f" ]] || continue
  sed -i \
    -e "s|{{AGENT_NAME}}|${TPL_NAME_ESC}|g" \
    -e "s|{{SPECIALTY}}|${TPL_SPECIALTY_ESC}|g" \
    -e "s|{{PROJECT_ID}}|${TPL_PROJECT_ESC}|g" \
    -e "s|{{AGENT_USER_EMAIL}}|${TPL_EMAIL_ESC}|g" \
    -e "s|{{DEPLOY_TIMESTAMP}}|$(date -u +%Y-%m-%dT%H:%M:%SZ)|g" \
    "$f"
done

# ---- 12) Run assemble-persona for this agent type ----
ASSEMBLE="${CORE_DIR}/bin/assemble-persona"
if [[ -x "$ASSEMBLE" ]]; then
  info "Assembling persona for fleet specialty: ${SPECIALTY}"
  CORE_DIR="${CORE_DIR}" "$ASSEMBLE" "${SPECIALTY}" || warn "assemble-persona failed"
fi

# ---- 12e) Install skill dependencies ----
SKILL_SETUP="${CORE_DIR}/bin/skill-setup"
if [[ -x "$SKILL_SETUP" ]]; then
  "$SKILL_SETUP" --all || warn "skill-setup had errors"
fi

# ---- 12f) The validator must exist before we rely on it (C-19) ----
# The gate itself runs at 13b. It used to run HERE, which could never pass: the
# runtime check asserts the four daemons are active, and the step that installs
# them is the next one. Every fresh fleet deploy failed at this line and exited
# before installing a single unit — invisible for a month, because upgrades do
# not run bootstrap and nobody hired an agent in between.
#
# A gate placed where the thing it checks cannot yet be true does not test the
# system, it tests the ordering.
VALIDATE="${CORE_DIR}/bin/validate-contracts"
if [[ ! -x "$VALIDATE" ]]; then
  echo "[ERROR] validate-contracts missing at ${VALIDATE} — cannot verify this install (C-19)." >&2
  exit 1
fi

# ---- 13) Install agent-ears, agent-mouth, agent-brain, agent-introspect as systemd services ----
info "Installing systemd services..."
# A missing unit used to be skipped in silence. The agent then booted, reported
# healthy, and had no brain — and because bootstrap runs only on a fresh deploy,
# every existing agent kept working, so nothing pointed at the cause. These four
# are not optional; a deploy that cannot install them has failed.
for svc in agent-ears agent-mouth agent-brain agent-introspect; do
  SVC_SRC="${CORE_DIR}/corekit/${svc}.service"
  if [[ ! -f "$SVC_SRC" ]]; then
    echo "[ERROR] ${svc}.service missing at ${SVC_SRC} — the manifest did not install it." >&2
    echo "        An agent without this unit boots and does nothing. Refusing to continue." >&2
    exit 1
  fi
  cp "$SVC_SRC" "/etc/systemd/system/${svc}.service"
done

systemctl daemon-reload
systemctl enable agent-ears agent-mouth agent-brain agent-introspect 2>/dev/null || true
systemctl start agent-brain agent-introspect || warn "agent-brain/introspect start failed"

# Fleet Definition sync (C-36). Installed but never enabled by bootstrap until
# now, so a fresh agent would sit at its manifest-installed defaults forever and
# only reconcile if an operator remembered to start the timer by hand.
#
# Safe to enable everywhere: a pass is a no-op unless this agent has an
# assignment, and an agent with no `fleet_assignments` record skips immediately.
# `fleet_config.sync_enabled: false` switches the whole mechanism off.
if [[ -f "${CORE_DIR}/corekit/agent-content-sync.timer" ]]; then
  cp "${CORE_DIR}/corekit/agent-content-sync.service" /etc/systemd/system/ 2>/dev/null || true
  cp "${CORE_DIR}/corekit/agent-content-sync.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now agent-content-sync.timer 2>/dev/null || warn "content-sync timer not enabled"
fi

if [[ -n "${AGENT_USER_EMAIL}" && -n "${DWD_SIGNER_SA}" ]]; then
  systemctl start agent-ears agent-mouth || warn "ears/mouth start failed (DWD may not be configured)"
else
  warn "ears/mouth not started — AGENT_USER_EMAIL or DWD_SIGNER_SA not set"
fi

# ---- 13b) Contract validation gate (C-19) ----
# Runs HERE, not before step 13, because what it asserts — daemons active — is
# only answerable once they have been installed and started. The intent is
# unchanged: a VM whose contracts do not hold must not report itself online. It
# now also stops what it started, so a failing VM is left inert rather than
# half-serving.
info "Validating contracts..."
if ! CORE_ROOT="${CORE_ROOT}" "$VALIDATE" --runtime 2>&1; then
  echo "[ERROR] Contract validation failed — stopping services and refusing to report online (C-19)." >&2
  systemctl stop agent-brain agent-introspect agent-ears agent-mouth 2>/dev/null || true
  exit 1
fi
info "Contracts validated"

# ---- 14) Report completion to Firestore via Prime's API ----
# Authenticated with this VM's own GCE workload identity: a Google-signed OIDC
# token, audience-bound to the dashboard, asserting the fleet service account.
# No shared secret exists (C-8); the control plane fails closed without it.
if [[ -n "$DASHBOARD_URL" && -n "$PRIME_ID" ]]; then
  info "Reporting completion to dashboard..."
  STATUS_BODY="{\"agent\":\"${AGENT_ID}\",\"status\":\"online\",\"actionRequired\":{\"type\":\"workspace_user\",\"title\":\"Create Workspace user and add to Chat space\",\"instructions\":[\"Create Workspace user at https://admin.google.com/ac/users — First: ${AGENT_FIRST_NAME:-Agent}, Last: ${AGENT_LAST_NAME:-${AGENT_ID}}, Email: ${AGENT_USER_EMAIL}\",\"Add ${AGENT_USER_EMAIL} to the AI Fleet Command Chat space\",\"The agent will come online automatically once the user exists\"]}}"

  ID_TOKEN="$(curl -sf --max-time 10 -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${DASHBOARD_URL}&format=full" \
    2>/dev/null || true)"

  if [[ -z "$ID_TOKEN" ]]; then
    warn "Could not mint a workload identity token — skipping dashboard status update"
  else
    STATUS_RESP="$(curl -s --max-time 15 -X POST \
      "${DASHBOARD_URL}/api/primes/${PRIME_ID}/fleet/update-status" \
      -H "Authorization: Bearer ${ID_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$STATUS_BODY" 2>&1)" || STATUS_RESP="CURL_ERROR"

    if echo "$STATUS_RESP" | grep -q '"success"'; then
      info "Dashboard status updated: online"
    else
      warn "Dashboard status update failed: ${STATUS_RESP:0:200}"
    fi
  fi
else
  warn "Skipping dashboard status update (DASHBOARD_URL=${DASHBOARD_URL:-unset}, PRIME_ID=${PRIME_ID:-unset})"
fi

# ---- Done ----
echo
echo "============================================"
echo "  FLEET AGENT SETUP COMPLETE"
echo "============================================"
echo "  Log file       : ${LOG_FILE}"
# C-8: never print the token. Startup-script output lands in the serial console,
# readable by anyone with compute.viewer. A fingerprint is enough to confirm the
# ears/mouth/brain all hold the same one.
echo "  Gateway token  : ${CORE_DIR}/.gateway-token (sha256:$(printf '%s' "${MY_TOKEN}" | sha256sum | cut -c1-12))"
echo "  Brain module   : installed natively"
echo "  Agent          : ${AGENT_DISPLAY_NAME} (${SPECIALTY})"
echo "  Project        : ${GCP_PROJECT_ID}"
echo "============================================"
