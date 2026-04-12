#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — INTERACTIVE BOOTSTRAP
#
# Walks you through the complete setup from an empty GCP project
# to a working Architect Prime with DWD Chat integration.
#
# Usage:
#   bash bootstrap.sh
#   PROJECT_ID=my-proj bash bootstrap.sh   # skip project selection
#
# The script will:
#   1. Auto-discover GCP projects, billing accounts, organizations
#   2. Let you pick from menus (or accept env vars)
#   3. Run Phase 1 (automated GCP setup)
#   4. Pause and guide you through DWD admin steps
#   5. Verify each step before continuing
#   6. Wait for Phase 2 (VM self-setup)
#   7. Test that everything works end-to-end
# ============================================================
set -euo pipefail

# ---- Colors + Formatting ----
BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
BLUE="\033[34m"
RESET="\033[0m"

# ---- Helpers ----
banner()   { echo -e "\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"; echo -e "${BOLD}${CYAN}║  $*${RESET}"; echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}\n"; }
section()  { echo -e "\n${BOLD}${BLUE}── $* ──${RESET}\n"; }
info()     { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()     { echo -e "  ${YELLOW}⚠${RESET} $*"; }
err()      { echo -e "  ${RED}✗${RESET} $*"; }
prompt()   { echo -en "  ${BOLD}$*${RESET} "; }
dim()      { echo -e "  ${DIM}$*${RESET}"; }

wait_for_user() {
  echo ""
  prompt "Press ENTER when done (or 'q' to quit)..."
  read -r input
  if [[ "$input" == "q" || "$input" == "Q" ]]; then
    echo "Exiting."
    exit 0
  fi
}

pick_from_list() {
  # Usage: pick_from_list "prompt" "${items[@]}"
  local prompt_text="$1"
  shift
  local items=("$@")
  local count=${#items[@]}

  if [[ $count -eq 0 ]]; then
    return 1
  fi

  echo ""
  for i in "${!items[@]}"; do
    echo -e "  ${BOLD}$((i+1))${RESET}) ${items[$i]}"
  done
  echo ""
  prompt "$prompt_text"
  read -r choice

  if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -ge 1 ]] && [[ "$choice" -le "$count" ]]; then
    PICKED="${items[$((choice-1))]}"
    return 0
  else
    return 1
  fi
}

verify_command() {
  # Run a command and return success/failure
  "$@" >/dev/null 2>&1
}

# ============================================================
# STEP 0: Welcome
# ============================================================
banner "ARCHITECT PRIME — INTERACTIVE BOOTSTRAP"
echo -e "  This will guide you through setting up Architect Prime"
echo -e "  from an empty GCP project to a working system with"
echo -e "  DWD Chat integration."
echo ""
echo -e "  ${DIM}You can pre-set env vars to skip prompts:${RESET}"
echo -e "  ${DIM}  PROJECT_ID, BILLING_ACCOUNT, GCP_ORG_ID,${RESET}"
echo -e "  ${DIM}  AGENT_USER_EMAIL, CHAT_SPACE_ID, ZONE${RESET}"
echo ""

# Verify gcloud is available
if ! command -v gcloud &>/dev/null; then
  err "gcloud CLI not found. Install it: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Verify authenticated
CURRENT_USER="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1)"
if [[ -z "$CURRENT_USER" ]]; then
  err "No active gcloud session. Run: gcloud auth login"
  exit 1
fi
info "Authenticated as: ${BOLD}${CURRENT_USER}${RESET}"

# ============================================================
# STEP 1: Select GCP Project
# ============================================================
section "STEP 1: Select GCP Project"

if [[ -n "${PROJECT_ID:-}" ]]; then
  info "Using PROJECT_ID from env: ${BOLD}${PROJECT_ID}${RESET}"
else
  echo "  Searching for your GCP projects..."
  mapfile -t PROJECTS < <(gcloud projects list --format='value(projectId)' 2>/dev/null | head -20)

  if [[ ${#PROJECTS[@]} -eq 0 ]]; then
    err "No projects found. Create one at: https://console.cloud.google.com/projectcreate"
    prompt "Enter your project ID manually: "
    read -r PROJECT_ID
  else
    info "Found ${#PROJECTS[@]} project(s)."
    if pick_from_list "Pick a project (number): " "${PROJECTS[@]}"; then
      PROJECT_ID="$PICKED"
    else
      prompt "Enter project ID manually: "
      read -r PROJECT_ID
    fi
  fi
fi

[[ -n "$PROJECT_ID" ]] || { err "PROJECT_ID is required."; exit 1; }
gcloud config set project "$PROJECT_ID" 2>/dev/null
info "Selected project: ${BOLD}${PROJECT_ID}${RESET}"

# ============================================================
# STEP 2: Verify Billing
# ============================================================
section "STEP 2: Verify Billing"

BILLING_ENABLED="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo 'False')"
if [[ "$BILLING_ENABLED" == "True" ]]; then
  info "Billing is enabled on project ${PROJECT_ID}"
else
  warn "Billing is NOT enabled on project ${PROJECT_ID}"
  echo ""
  echo "  Enable it at: https://console.cloud.google.com/billing?project=${PROJECT_ID}"
  wait_for_user

  BILLING_ENABLED="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo 'False')"
  [[ "$BILLING_ENABLED" == "True" ]] || { err "Billing must be enabled to continue."; exit 1; }
  info "Billing enabled."
fi

# Select billing account (for fleet deployment)
if [[ -n "${BILLING_ACCOUNT:-}" ]]; then
  info "Using BILLING_ACCOUNT from env: ${BOLD}${BILLING_ACCOUNT}${RESET}"
else
  mapfile -t BILLING_ACCOUNTS < <(gcloud billing accounts list --filter=open=true --format='value(name)' 2>/dev/null)
  mapfile -t BILLING_NAMES < <(gcloud billing accounts list --filter=open=true --format='value(displayName)' 2>/dev/null)

  if [[ ${#BILLING_ACCOUNTS[@]} -eq 1 ]]; then
    BILLING_ACCOUNT="${BILLING_ACCOUNTS[0]}"
    info "Auto-selected billing account: ${BOLD}${BILLING_NAMES[0]}${RESET} (${BILLING_ACCOUNT})"
  elif [[ ${#BILLING_ACCOUNTS[@]} -gt 1 ]]; then
    DISPLAY_BILLING=()
    for i in "${!BILLING_ACCOUNTS[@]}"; do
      DISPLAY_BILLING+=("${BILLING_NAMES[$i]} (${BILLING_ACCOUNTS[$i]})")
    done
    if pick_from_list "Pick a billing account (for fleet deployment): " "${DISPLAY_BILLING[@]}"; then
      BILLING_ACCOUNT="${BILLING_ACCOUNTS[$((choice-1))]}"
    fi
  fi
  BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
fi

# ============================================================
# STEP 3: Select Organization (optional, for fleet)
# ============================================================
section "STEP 3: Organization (for fleet deployment)"

if [[ -n "${GCP_ORG_ID:-}" ]]; then
  info "Using GCP_ORG_ID from env: ${BOLD}${GCP_ORG_ID}${RESET}"
else
  mapfile -t ORGS < <(gcloud organizations list --format='value(ID)' 2>/dev/null)
  mapfile -t ORG_NAMES < <(gcloud organizations list --format='value(displayName)' 2>/dev/null)

  if [[ ${#ORGS[@]} -eq 0 ]]; then
    warn "No organizations found. Fleet deployment will require manual setup."
    GCP_ORG_ID=""
  elif [[ ${#ORGS[@]} -eq 1 ]]; then
    GCP_ORG_ID="${ORGS[0]}"
    info "Auto-selected org: ${BOLD}${ORG_NAMES[0]}${RESET} (${GCP_ORG_ID})"
  else
    DISPLAY_ORGS=()
    for i in "${!ORGS[@]}"; do
      DISPLAY_ORGS+=("${ORG_NAMES[$i]} (${ORGS[$i]})")
    done
    if pick_from_list "Pick an organization: " "${DISPLAY_ORGS[@]}"; then
      GCP_ORG_ID="${ORGS[$((choice-1))]}"
    else
      GCP_ORG_ID=""
    fi
  fi
fi

# ============================================================
# STEP 4: Zone Selection
# ============================================================
section "STEP 4: Zone"

if [[ -n "${ZONE:-}" ]]; then
  info "Using ZONE from env: ${BOLD}${ZONE}${RESET}"
else
  ZONE="us-central1-a"
  info "Using default zone: ${BOLD}${ZONE}${RESET}"
  dim "(set ZONE env var to override)"
fi

# ============================================================
# STEP 5: Agent User Email
# ============================================================
section "STEP 5: Workspace User for Prime"

echo "  Architect Prime needs a Google Workspace user account to"
echo "  send and read Chat messages via Domain-Wide Delegation."
echo ""
echo -e "  This should be a dedicated user in your domain, e.g.:"
echo -e "    ${BOLD}prime@yourdomain.com${RESET}"
echo ""

if [[ -n "${AGENT_USER_EMAIL:-}" ]]; then
  info "Using AGENT_USER_EMAIL from env: ${BOLD}${AGENT_USER_EMAIL}${RESET}"
else
  echo -e "  ${YELLOW}If this user doesn't exist yet, create it now:${RESET}"
  echo "    → https://admin.google.com → Users → Add new user"
  echo ""
  prompt "Enter the Workspace user email for Prime: "
  read -r AGENT_USER_EMAIL
fi

[[ -n "$AGENT_USER_EMAIL" ]] || { warn "No agent user email provided — Chat integration will be skipped."; }

# ============================================================
# STEP 6: Summary & Confirm
# ============================================================
section "STEP 6: Confirm Configuration"

echo -e "  ${BOLD}Project:${RESET}        ${PROJECT_ID}"
echo -e "  ${BOLD}Zone:${RESET}           ${ZONE}"
echo -e "  ${BOLD}Billing:${RESET}        ${BILLING_ACCOUNT:-not set}"
echo -e "  ${BOLD}Organization:${RESET}   ${GCP_ORG_ID:-not set}"
echo -e "  ${BOLD}Agent Email:${RESET}    ${AGENT_USER_EMAIL:-not set}"
echo -e "  ${BOLD}Authenticated:${RESET}  ${CURRENT_USER}"
echo ""
prompt "Proceed with bootstrap? (y/n): "
read -r confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || { echo "Aborted."; exit 0; }

# ============================================================
# STEP 7: Run Phase 1 (automated GCP setup)
# ============================================================
banner "PHASE 1 — GCP Infrastructure Setup"
echo "  This will take ~5 minutes. Setting up APIs, service account,"
echo "  firewall, and creating the VM..."
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CORE_REF="${CORE_REF:-main}"
export PROJECT_ID ZONE BILLING_ACCOUNT GCP_ORG_ID AGENT_USER_EMAIL CORE_REF
export GCP_PROJECT_ID="$PROJECT_ID"  # phase1 uses this alias too

# Run Phase 1 in a subshell so we can capture the SA info
bash "${SCRIPT_DIR}/bootstrap/phase1-cloudshell.sh"

info "Phase 1 complete!"

# ============================================================
# STEP 8: DWD Setup (manual — pause and guide)
# ============================================================
PRIME_SA_NAME="${PRIME_SA_NAME:-architect-prime}"
PRIME_SA_EMAIL="${PRIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SA_CLIENT_ID="$(gcloud iam service-accounts describe "$PRIME_SA_EMAIL" --format='value(uniqueId)' 2>/dev/null || echo 'unknown')"

banner "DOMAIN-WIDE DELEGATION SETUP"
echo -e "  ${YELLOW}This step requires a Google Workspace Super Admin.${RESET}"
echo ""
echo -e "  ${BOLD}1. Open the Admin Console:${RESET}"
echo "     https://admin.google.com"
echo ""
echo -e "  ${BOLD}2. Navigate to:${RESET}"
echo "     Security → Access and data control → API Controls"
echo "     → Manage Domain Wide Delegation → Add new"
echo ""
echo -e "  ${BOLD}3. Enter these values:${RESET}"
echo ""
echo -e "     Client ID:  ${BOLD}${GREEN}${SA_CLIENT_ID}${RESET}"
echo ""
echo "     Scopes (copy this entire line):"
echo ""
echo -e "     ${BOLD}https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/chat.messages.create,https://www.googleapis.com/auth/chat.messages.readonly,https://www.googleapis.com/auth/chat.spaces.readonly${RESET}"
echo ""
echo -e "  ${BOLD}4. Click 'Authorize'${RESET}"
echo ""
dim "It may take a few minutes for DWD to propagate."
echo ""

wait_for_user

# Verify DWD by attempting a token request
section "Verifying DWD..."
echo "  Testing DWD token generation for ${AGENT_USER_EMAIL}..."
echo "  (SSH into the VM to test — this can't be done from Cloud Shell)"
echo ""
info "We'll verify DWD after Phase 2 completes."

# ============================================================
# STEP 9: Chat Space Setup
# ============================================================
banner "GOOGLE CHAT SPACE SETUP"

if [[ -n "${CHAT_SPACE_ID:-}" ]]; then
  info "Using CHAT_SPACE_ID from env: ${BOLD}${CHAT_SPACE_ID}${RESET}"
else
  echo "  Architect Prime needs a Google Chat space to communicate in."
  echo ""
  echo -e "  ${BOLD}1. Open Google Chat:${RESET}  https://chat.google.com"
  echo -e "  ${BOLD}2. Create a new space${RESET} (e.g., \"Architect Prime Ops\")"
  echo -e "  ${BOLD}3. Add ${AGENT_USER_EMAIL:-the agent user}${RESET} to the space"
  echo -e "  ${BOLD}4. Get the space ID${RESET} from the URL bar:"
  echo ""
  echo "     The URL looks like: https://mail.google.com/chat/u/0/#chat/space/XXXXXXXXX"
  echo -e "     The space ID is: ${BOLD}spaces/XXXXXXXXX${RESET}"
  echo ""
  prompt "Enter the Chat space ID (spaces/XXXXXXXXX): "
  read -r CHAT_SPACE_ID
fi

if [[ -n "${CHAT_SPACE_ID:-}" ]]; then
  info "Space ID: ${BOLD}${CHAT_SPACE_ID}${RESET}"

  # Update VM metadata with the Chat config
  echo "  Updating VM metadata with Chat configuration..."
  VM="${VM:-architect-prime}"
  gcloud compute instances add-metadata "$VM" --zone "$ZONE" --project "$PROJECT_ID" \
    --metadata="agent_user_email=${AGENT_USER_EMAIL:-},chat_space_id=${CHAT_SPACE_ID}" \
    2>/dev/null || warn "Failed to update VM metadata (VM may still be starting)"
  info "VM metadata updated."
else
  warn "No Chat space ID provided — you can set it later with:"
  echo "    gcloud compute instances add-metadata architect-prime --zone $ZONE \\"
  echo "      --metadata=chat_space_id=spaces/YOUR_SPACE_ID"
fi

# ============================================================
# STEP 10: Wait for Phase 2
# ============================================================
banner "PHASE 2 — VM Self-Setup"
echo "  Phase 2 is running automatically on the VM."
echo "  It installs Docker, builds OpenClaw, installs CoreKit,"
echo "  and starts the inbox-daemon."
echo ""
echo "  This takes ~15-20 minutes."
echo ""
VM="${VM:-architect-prime}"
dim "Monitoring progress..."
echo ""

PHASE2_DONE=false
CHECKS=0
MAX_CHECKS=60  # 60 * 20s = 20 minutes

while [[ "$PHASE2_DONE" == "false" && $CHECKS -lt $MAX_CHECKS ]]; do
  CHECKS=$((CHECKS + 1))

  # Check serial output for completion marker
  SERIAL_OUTPUT="$(gcloud compute instances get-serial-port-output "$VM" \
    --zone "$ZONE" --project "$PROJECT_ID" \
    --start=0 2>/dev/null | tail -50)"

  if echo "$SERIAL_OUTPUT" | grep -q "========== PHASE 2 COMPLETE =========="; then
    PHASE2_DONE=true
    break
  fi

  # Show progress indicator
  ELAPSED=$((CHECKS * 20))
  echo -ne "\r  ⏳ Waiting... (${ELAPSED}s elapsed) "

  # Show last meaningful log line
  LAST_LINE="$(echo "$SERIAL_OUTPUT" | grep -E '(==>|✅|Installing|Building|Starting|CoreKit)' | tail -1 | sed 's/^/  /')"
  if [[ -n "$LAST_LINE" ]]; then
    echo -ne "| $LAST_LINE"
  fi

  sleep 20
done

echo ""
if [[ "$PHASE2_DONE" == "true" ]]; then
  info "Phase 2 complete! VM is ready."
else
  warn "Phase 2 didn't complete within 20 minutes."
  echo "  Check manually:"
  echo "    gcloud compute instances get-serial-port-output $VM --zone $ZONE"
  echo ""
  prompt "Continue anyway? (y/n): "
  read -r cont
  [[ "$cont" == "y" || "$cont" == "Y" ]] || { echo "Exiting."; exit 0; }
fi

# ============================================================
# STEP 11: Verify Everything
# ============================================================
banner "VERIFICATION"

echo "  Running final checks..."
echo ""

# Check VM is running
VM_STATUS="$(gcloud compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT_ID" --format='value(status)' 2>/dev/null || echo 'UNKNOWN')"
if [[ "$VM_STATUS" == "RUNNING" ]]; then
  info "VM '${VM}' is ${GREEN}RUNNING${RESET}"
else
  err "VM '${VM}' status: ${VM_STATUS}"
fi

# Check SSH access
echo "  Testing SSH access..."
if gcloud compute ssh "$VM" --zone "$ZONE" --project "$PROJECT_ID" \
    --command="echo ok" --quiet 2>/dev/null; then
  info "SSH access works"
else
  warn "SSH access failed (may need a few more seconds)"
fi

# Check inbox-daemon is running
echo "  Checking inbox-daemon service..."
DAEMON_STATUS="$(gcloud compute ssh "$VM" --zone "$ZONE" --project "$PROJECT_ID" \
  --command="systemctl is-active inbox-daemon 2>/dev/null || echo 'inactive'" \
  --quiet 2>/dev/null || echo 'unknown')"
if [[ "$DAEMON_STATUS" == *"active"* && "$DAEMON_STATUS" != *"inactive"* ]]; then
  info "inbox-daemon is ${GREEN}active${RESET}"
else
  warn "inbox-daemon status: ${DAEMON_STATUS}"
  echo "  It may need DWD to propagate first. You can check later:"
  echo "    gcloud compute ssh $VM --zone $ZONE -- 'sudo systemctl status inbox-daemon'"
fi

# Check DWD token generation (from VM)
if [[ -n "${AGENT_USER_EMAIL:-}" ]]; then
  echo "  Testing DWD token generation on VM..."
  DWD_TEST="$(gcloud compute ssh "$VM" --zone "$ZONE" --project "$PROJECT_ID" \
    --command="sudo /opt/openclaw/.openclaw/bin/dwd-token --user '${AGENT_USER_EMAIL}' 2>&1 | head -1" \
    --quiet 2>/dev/null || echo 'failed')"
  if [[ "$DWD_TEST" != *"ERROR"* && "$DWD_TEST" != *"failed"* && -n "$DWD_TEST" ]]; then
    info "DWD token generation ${GREEN}works${RESET}!"
  else
    warn "DWD token generation failed — DWD may need more time to propagate."
    echo "  Error: $DWD_TEST"
    echo ""
    echo "  If this persists, verify in Admin Console:"
    echo "    - Client ID ${SA_CLIENT_ID} is authorized"
    echo "    - Scopes include chat.messages"
    echo "    - Wait up to 24 hours for propagation"
    echo ""
    echo -e "  ${BOLD}To re-test later:${RESET}"
    echo "    gcloud compute ssh $VM --zone $ZONE -- \\"
    echo "      'sudo /opt/openclaw/.openclaw/bin/dwd-token --user ${AGENT_USER_EMAIL}'"
  fi
fi

# ============================================================
# STEP 12: Summary
# ============================================================
banner "BOOTSTRAP COMPLETE! 🎉"

VM_IP="$(gcloud compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT_ID" --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || echo 'unknown')"

echo -e "  ${BOLD}Project:${RESET}        ${PROJECT_ID}"
echo -e "  ${BOLD}VM:${RESET}             ${VM} (${VM_STATUS})"
echo -e "  ${BOLD}External IP:${RESET}    ${VM_IP}"
echo -e "  ${BOLD}Zone:${RESET}           ${ZONE}"
echo -e "  ${BOLD}SA:${RESET}             ${PRIME_SA_EMAIL}"
echo -e "  ${BOLD}Agent User:${RESET}     ${AGENT_USER_EMAIL:-not set}"
echo -e "  ${BOLD}Chat Space:${RESET}     ${CHAT_SPACE_ID:-not set}"
echo -e "  ${BOLD}DWD Client ID:${RESET}  ${SA_CLIENT_ID}"
echo ""

if [[ -n "${AGENT_USER_EMAIL:-}" && -n "${CHAT_SPACE_ID:-}" ]]; then
  echo -e "  ${BOLD}${GREEN}TEST IT:${RESET} Open Google Chat and @-mention"
  echo -e "  ${BOLD}${AGENT_USER_EMAIL}${RESET} in your Chat space."
  echo ""
  echo "  Try: @${AGENT_USER_EMAIL%%@*} help"
  echo "  Try: @${AGENT_USER_EMAIL%%@*} status"
  echo "  Try: @${AGENT_USER_EMAIL%%@*} What is Architect Prime?"
else
  echo "  To finish Chat setup later, set the metadata:"
  echo "    gcloud compute instances add-metadata $VM --zone $ZONE \\"
  echo "      --metadata=agent_user_email=prime@yourdomain.com,chat_space_id=spaces/YOUR_ID"
fi

echo ""
echo -e "  ${BOLD}SSH into Prime:${RESET}"
echo "    gcloud compute ssh $VM --zone $ZONE --project $PROJECT_ID"
echo ""
echo -e "  ${BOLD}View logs:${RESET}"
echo "    gcloud compute ssh $VM --zone $ZONE -- 'sudo journalctl -u inbox-daemon -f'"
echo ""
echo -e "  ${BOLD}Deploy fleet agent:${RESET}"
echo "    gcloud compute ssh $VM --zone $ZONE -- \\"
echo "      'sudo /opt/openclaw/.openclaw/bin/fleet-deploy --name alpha --specialty \"billing expert\"'"
echo ""
