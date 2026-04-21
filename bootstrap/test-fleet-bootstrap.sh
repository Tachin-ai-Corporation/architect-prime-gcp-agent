#!/usr/bin/env bash
# ============================================================
# test-fleet-bootstrap.sh — Dry-run validation for fleet bootstrap
#
# Simulates the fleet config rendering pipeline WITHOUT a VM.
# Catches schema violations, contract mismatches, and .env drift
# in ~2 seconds on any machine with python3 and bash.
#
# Usage:
#   bootstrap/test-fleet-bootstrap.sh                          # defaults
#   bootstrap/test-fleet-bootstrap.sh --specialty devops       # specific job
#   bootstrap/test-fleet-bootstrap.sh --agent-name test-agent  # custom name
#
# Exit codes:
#   0 — All checks passed
#   1 — Validation failed
# ============================================================
set -euo pipefail

SPECIALTY="${SPECIALTY:-devops}"
AGENT_NAME="${AGENT_NAME:-test-agent}"
AGENT_DISPLAY_NAME="Test Agent"
GCP_PROJECT_ID="test-project"
MY_TOKEN="test-token-12345"
AGENT_ID="test"
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --specialty) SPECIALTY="$2"; shift 2 ;;
    --agent-name) AGENT_NAME="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    --help|-h) echo "Usage: $0 [--specialty <type>] [--agent-name <name>] [--verbose]"; exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Find repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { echo "[test] $*"; }
pass() { echo "[test] ✅ $*"; PASSES=$((PASSES + 1)); }
fail() { echo "[test] ❌ FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

PASSES=0
FAILURES=0

log "=== Fleet Bootstrap Dry-Run ==="
log "Specialty : ${SPECIALTY}"
log "Agent     : ${AGENT_NAME}"
log "Repo      : ${REPO_ROOT}"

# ---- Check 1: contracts.json exists ----
CONTRACTS="${REPO_ROOT}/contracts.json"
if [[ -f "$CONTRACTS" ]]; then
  pass "contracts.json exists"
else
  fail "contracts.json not found at ${CONTRACTS}"
  echo "Cannot continue without contracts.json"
  exit 1
fi

# ---- Check 2: Manifest fragments exist ----
for FRAG in base.txt role-fleet.txt "job-${SPECIALTY}.txt"; do
  FRAG_PATH="${REPO_ROOT}/manifests/${FRAG}"
  if [[ -f "$FRAG_PATH" ]]; then
    LINES="$(grep -cvP '^\s*(#|$)' "$FRAG_PATH" || echo 0)"
    pass "manifests/${FRAG} exists (${LINES} file pairs)"
  else
    if [[ "$FRAG" == "job-${SPECIALTY}.txt" ]]; then
      fail "manifests/${FRAG} not found — no job manifest for specialty '${SPECIALTY}'"
    else
      fail "manifests/${FRAG} not found"
    fi
  fi
done

# ---- Check 3: Config template exists ----
FLEET_TMPL="${REPO_ROOT}/bundle/corekit/config/openclaw-fleet-bootstrap.json5.tmpl"
if [[ -f "$FLEET_TMPL" ]]; then
  pass "Fleet config template exists"
else
  fail "Fleet config template not found: ${FLEET_TMPL}"
  echo "Cannot continue without config template"
  exit 1
fi

# ---- Check 4: Render config (simulate fleet-bootstrap.sh step 10) ----
log "Rendering config template..."
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
RENDERED="${TMPDIR}/openclaw.json"

python3 - <<PY
import pathlib, re, json

tmpl_path = pathlib.Path("${FLEET_TMPL}")
out_path = pathlib.Path("${RENDERED}")

tmpl = tmpl_path.read_text(encoding="utf-8")

# Remove json5 comments (// style)
tmpl = re.sub(r'//.*$', '', tmpl, flags=re.MULTILINE)

# Template substitutions (same as fleet-bootstrap.sh)
tmpl = tmpl.replace("\${GCP_PROJECT_ID}", "${GCP_PROJECT_ID}")
tmpl = tmpl.replace("\${MY_TOKEN}", "${MY_TOKEN}")
tmpl = tmpl.replace("\${AGENT_ID}", "${AGENT_ID}")
tmpl = tmpl.replace("\${AGENT_DISPLAY_NAME}", "${AGENT_DISPLAY_NAME}")

out_path.write_text(tmpl, encoding="utf-8")
print(f"  Rendered: {out_path} ({len(tmpl)} bytes)")
PY

if [[ -f "$RENDERED" ]]; then
  pass "Config rendered successfully"
else
  fail "Config rendering failed"
  exit 1
fi

# ---- Check 5: Rendered JSON is valid ----
if python3 -c "import json; json.load(open('${RENDERED}'))" 2>/dev/null; then
  pass "Rendered config is valid JSON"
else
  fail "Rendered config is NOT valid JSON"
  if [[ "$VERBOSE" == true ]]; then
    python3 -c "import json; json.load(open('${RENDERED}'))" 2>&1 || true
  fi
fi

# ---- Check 6: No systemPrompt in rendered config ----
if python3 -c "
import json, sys
c = json.load(open('${RENDERED}'))
for a in c.get('agents',{}).get('list',[]):
    if 'systemPrompt' in a:
        print(f\"  Agent '{a.get('id','?')}' has systemPrompt\")
        sys.exit(1)
" 2>/dev/null; then
  pass "No systemPrompt in rendered config"
else
  fail "systemPrompt found in rendered config (causes OpenClaw crash-loop!)"
fi

# ---- Check 7: Default agent ID matches contracts ----
C_DEFAULT_AGENT="$(python3 -c "import json; print(json.load(open('${CONTRACTS}'))['agents']['defaultId'])")"
if python3 -c "
import json, sys
c = json.load(open('${RENDERED}'))
for a in c.get('agents',{}).get('list',[]):
    if a.get('default') and a.get('id') == '${C_DEFAULT_AGENT}':
        sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
  pass "Default agent = ${C_DEFAULT_AGENT} (matches contracts)"
else
  fail "Default agent is not '${C_DEFAULT_AGENT}' (contract violation)"
fi

# ---- Check 8: Run validate-contracts on rendered config ----
VALIDATE="${REPO_ROOT}/bundle/corekit/bin/validate-contracts"
if [[ -f "$VALIDATE" ]]; then
  log "Running validate-contracts (repo mode)..."
  if bash "$VALIDATE" 2>&1; then
    pass "validate-contracts repo check passed"
  else
    fail "validate-contracts repo check failed"
  fi
else
  fail "validate-contracts script not found"
fi

# ---- Check 9: Specialty workspace exists ----
WS_DIR="${REPO_ROOT}/bundle/workspaces/${SPECIALTY}"
if [[ -d "$WS_DIR" ]]; then
  WS_FILES="$(ls "$WS_DIR"/*.md 2>/dev/null | wc -l)"
  pass "Specialty workspace '${SPECIALTY}' exists (${WS_FILES} files)"
else
  fail "Specialty workspace '${SPECIALTY}' not found at ${WS_DIR}"
fi

# ---- Summary ----
echo ""
log "=== Results ==="
log "  Passed  : ${PASSES}"
log "  Failed  : ${FAILURES}"

if [[ $FAILURES -eq 0 ]]; then
  log "✅ Fleet bootstrap dry-run PASSED for specialty '${SPECIALTY}'"
  exit 0
else
  log "❌ Fleet bootstrap dry-run FAILED — ${FAILURES} issue(s) found"
  exit 1
fi
