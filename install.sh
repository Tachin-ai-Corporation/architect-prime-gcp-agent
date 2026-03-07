#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — MANIFEST INSTALLER (install.sh)
#
# Standalone, idempotent installer that:
#   1. Fetches manifest.txt from the CoreKit repo at a pinned ref
#   2. Downloads each file to the correct destination
#   3. Writes STATE.json with provenance + file checksums
#
# Modes:
#   install (default) — Full install from scratch or overwrite
#   --check           — Compare installed files against STATE.json, report drift
#   --upgrade <ref>   — Re-install from a new ref (preserves runtime state)
#
# Exit codes:
#   0 — Success / up-to-date (check mode)
#   1 — Error
#   2 — Upgrade available (check mode, different ref on remote)
#   3 — Drift detected (check mode, files modified locally)
#
# Usage:
#   # Fresh install
#   export CORE_REF="v0.3.0"
#   curl -fsSL ".../install.sh" | bash
#
#   # Check for drift
#   install.sh --check
#
#   # Upgrade to new ref
#   install.sh --upgrade v0.3.0
# ============================================================
set -euo pipefail

# ---- Parse args ----
MODE="install"
UPGRADE_REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   MODE="check"; shift ;;
    --upgrade) MODE="upgrade"; UPGRADE_REF="${2:-}"; shift 2 || die "Missing ref for --upgrade" ;;
    --help|-h) echo "Usage: install.sh [--check | --upgrade <ref>]"; exit 0 ;;
    *) echo "[ERROR] Unknown argument: $1"; exit 1 ;;
  esac
done

# ---- CONFIG (env-overridable) ----
GH_OWNER="${GH_OWNER:-Tachin-ai-Corporation}"
GH_REPO="${GH_REPO:-architect-prime-gcp-agent}"
CORE_REF="${CORE_REF:-main}"
OC_HOST_ROOT="${OC_HOST_ROOT:-/opt/openclaw}"
INSTALL_USE_SUDO="${INSTALL_USE_SUDO:-1}"

# For upgrade mode, override CORE_REF with the target
if [[ "$MODE" == "upgrade" ]]; then
  if [[ -z "$UPGRADE_REF" ]]; then
    echo "[ERROR] --upgrade requires a ref argument"; exit 1
  fi
  CORE_REF="$UPGRADE_REF"
fi

CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"
STATE_FILE="${OC_HOST_ROOT}/.openclaw/corekit/STATE.json"

# ---- Helpers ----
info()  { echo -e "\n==> $*\n"; }
warn()  { echo -e "\n[WARN] $*\n"; }
die()   { echo -e "\n[ERROR] $*\n"; exit 1; }

# Conditional sudo: when running as root or when sudo is disabled
run() {
  if [[ "${INSTALL_USE_SUDO}" == "1" ]] && [[ "$(id -u)" != "0" ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

# ---- Validate prereqs ----
command -v curl >/dev/null 2>&1 || die "Required command not found: curl"

# Portable sha256 function (tries sha256sum → shasum → openssl → skip)
compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    echo "no-hash-tool"
  fi
}

# ---- Simple JSON value extractor (no jq dependency) ----
json_value() {
  local key="$1" file="$2"
  # Extracts a simple string value for a given key from JSON
  grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null | head -1 | sed 's/.*: *"\([^"]*\)"/\1/'
}

# ==============================================================
# MODE: CHECK — Compare installed files against STATE.json
# ==============================================================
if [[ "$MODE" == "check" ]]; then
  info "Architect Prime — Integrity Check"

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No STATE.json found at: $STATE_FILE"
    echo "CoreKit does not appear to be installed."
    exit 1
  fi

  # Read installed ref from STATE.json
  installed_ref="$(json_value "coreRef" "$STATE_FILE")"
  installed_at="$(json_value "installedAt" "$STATE_FILE")"
  echo "Installed : ${installed_ref} (at ${installed_at})"
  echo "State     : ${STATE_FILE}"

  # Check for file drift
  drift_count=0
  missing_count=0
  ok_count=0

  # Extract file hashes from STATE.json
  # Format: "path":"sha256:hash"
  while IFS= read -r match; do
    file_path="$(echo "$match" | sed 's/"\([^"]*\)":"sha256:.*/\1/')"
    expected_hash="$(echo "$match" | sed 's/.*"sha256:\([^"]*\)"/\1/')"

    full_path="${OC_HOST_ROOT}/${file_path}"

    if run test -f "$full_path"; then
      # Compute current hash
      tmpfile="$(mktemp)"
      run cat "$full_path" > "$tmpfile"
      actual_hash="$(compute_sha256 "$tmpfile")"
      rm -f "$tmpfile"

      if [[ "$actual_hash" == "$expected_hash" ]]; then
        ok_count=$((ok_count + 1))
      else
        echo "  [DRIFT] ${file_path}"
        echo "          expected: ${expected_hash}"
        echo "          actual:   ${actual_hash}"
        drift_count=$((drift_count + 1))
      fi
    else
      echo "  [MISSING] ${file_path}"
      missing_count=$((missing_count + 1))
    fi
  done < <(grep -o '"\.openclaw/[^"]*":"sha256:[^"]*"' "$STATE_FILE")

  echo ""
  echo "Results: ${ok_count} ok, ${drift_count} drifted, ${missing_count} missing"

  if [[ $drift_count -gt 0 || $missing_count -gt 0 ]]; then
    echo "Status: DRIFT DETECTED"
    exit 3
  else
    echo "Status: OK (all files match STATE.json)"
    exit 0
  fi
fi

# ==============================================================
# MODE: INSTALL / UPGRADE
# ==============================================================
if [[ "$MODE" == "upgrade" ]]; then
  info "Architect Prime — Upgrade"
  if [[ -f "$STATE_FILE" ]]; then
    old_ref="$(json_value "coreRef" "$STATE_FILE")"
    echo "Upgrading : ${old_ref} → ${CORE_REF}"
  else
    echo "No previous install found, performing fresh install."
  fi
else
  info "Architect Prime Installer"
fi

echo "CoreKit : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "Target  : ${OC_HOST_ROOT}"

# ---- 1. Fetch manifest ----
info "Fetching manifest.txt..."
tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

manifest="${tmpdir}/manifest.txt"
curl -fsSL "${CORE_BASE}/manifest.txt" -o "${manifest}"

# ---- 2. Parse manifest into pairs ----
# Format: <repo_relative_path> <dest_relative_to_HOME>
# Lines starting with # are comments; blank lines are ignored.
pairs=()
while IFS= read -r line; do
  # Strip comments and whitespace
  line="${line%%#*}"
  line="$(echo "$line" | xargs)" # trim
  [[ -z "$line" ]] && continue
  pairs+=("$line")
done < "${manifest}"

if [[ ${#pairs[@]} -eq 0 ]]; then
  die "No file pairs found in manifest.txt"
fi

# ---- 3. Download files ----
info "Installing ${#pairs[@]} file pairs..."
declare -A file_hashes
installed=0

for pair in "${pairs[@]}"; do
  # Split into source and destination
  read -r rel dest <<< "$pair"

  # Normalize destination: strip ~/ or ./ prefix
  dest="${dest#\~/}"
  dest="${dest#./}"

  # Safety: refuse absolute destination paths
  if [[ "$dest" == /* ]]; then
    die "Refusing absolute destination path: $dest"
  fi

  out_path="${OC_HOST_ROOT}/${dest}"
  out_dir="$(dirname "$out_path")"
  src_url="${CORE_BASE}/${rel}"

  # Create directory and download
  run mkdir -p "$out_dir"
  curl -fsSL "$src_url" -o "${tmpdir}/dl_tmp"
  run cp "${tmpdir}/dl_tmp" "$out_path"

  # Compute hash for STATE.json
  hash="$(compute_sha256 "${tmpdir}/dl_tmp")"
  file_hashes["$dest"]="sha256:${hash}"

  installed=$((installed + 1))
done

echo "Installed ${installed} files into ${OC_HOST_ROOT}."

# ---- 4. Set permissions ----
info "Setting ownership and permissions..."
run chown -R 1000:1000 "${OC_HOST_ROOT}/.openclaw" 2>/dev/null || true
run find "${OC_HOST_ROOT}/.openclaw" -type d -exec chmod 755 {} \; 2>/dev/null || true
run find "${OC_HOST_ROOT}/.openclaw" -type f -exec chmod 644 {} \; 2>/dev/null || true
run chmod 755 "${OC_HOST_ROOT}/.openclaw/bin/oc" 2>/dev/null || true
run chmod 755 "${OC_HOST_ROOT}/.openclaw/bin/bootstrap_smoke.sh" 2>/dev/null || true
run chmod 755 "${OC_HOST_ROOT}/.openclaw/bin/upgrade-corekit" 2>/dev/null || true
run chmod 755 "${OC_HOST_ROOT}/.openclaw/bin/chat-send" 2>/dev/null || true

# ---- 5. Write STATE.json ----
info "Writing STATE.json..."
state_dir="${OC_HOST_ROOT}/.openclaw/corekit"
run mkdir -p "$state_dir"

# Build JSON with file hashes
hashes_json="{"
first=1
for key in "${!file_hashes[@]}"; do
  if [[ $first -eq 0 ]]; then
    hashes_json+=","
  fi
  hashes_json+="\"${key}\":\"${file_hashes[$key]}\""
  first=0
done
hashes_json+="}"

state_json="{
  \"version\": 1,
  \"coreRef\": \"${CORE_REF}\",
  \"owner\": \"${GH_OWNER}\",
  \"repo\": \"${GH_REPO}\",
  \"installedAt\": \"$(date -Is)\",
  \"fileCount\": ${installed},
  \"fileHashes\": ${hashes_json}
}"

echo "$state_json" | run tee "${state_dir}/STATE.json" >/dev/null
run chown 1000:1000 "${state_dir}/STATE.json" 2>/dev/null || true
run chmod 644 "${state_dir}/STATE.json" 2>/dev/null || true

# ---- 6. Verify critical files ----
info "Verifying critical files..."
for check_file in \
  "${OC_HOST_ROOT}/.openclaw/agents/main/agent/auth-profiles.json" \
  "${OC_HOST_ROOT}/.openclaw/workspace/SOUL.md" \
  "${OC_HOST_ROOT}/.openclaw/bin/oc"; do
  if ! run test -f "$check_file"; then
    die "Missing after install: $check_file"
  fi
done
run test -x "${OC_HOST_ROOT}/.openclaw/bin/oc" || die "oc wrapper not executable after install"

if [[ "$MODE" == "upgrade" ]]; then
  info "Upgrade complete."
else
  info "Install complete."
fi
echo "  CoreKit : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "  Target  : ${OC_HOST_ROOT}"
echo "  State   : ${state_dir}/STATE.json"
echo "  Files   : ${installed}"
