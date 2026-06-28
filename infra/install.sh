#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — MANIFEST INSTALLER (install.sh)
#
# Standalone, idempotent installer that:
#   1. Fetches manifest fragments from the CoreKit repo at a pinned ref
#   2. Chains: base + role (prime|fleet) + job (devops|engineer|...)
#   3. Downloads each file to the correct destination
#   4. Writes STATE.json with provenance + file checksums
#
# Modes:
#   install (default) — Full install from scratch or overwrite
#   --check           — Compare installed files against STATE.json, report drift
#   --upgrade <ref>   — Re-install from a new ref (preserves runtime state)
#
# Role/Job flags (chained installation):
#   --role prime      — Install base + prime-specific tools + prime workspaces
#   --role fleet      — Install base + fleet-specific tools
#   --job devops      — Layer devops workspace on top (requires --role fleet)
#   --job engineer    — Layer engineer workspace on top (requires --role fleet)
#
# If no --role is specified, falls back to flat manifest.txt (backward compat).
#
# Exit codes:
#   0 — Success / up-to-date (check mode)
#   1 — Error
#   2 — Upgrade available (check mode, different ref on remote)
#   3 — Drift detected (check mode, files modified locally)
#
# Usage:
#   # Fresh install (Prime)
#   export CORE_REF="main"
#   curl -fsSL ".../install.sh" | bash -s -- --role prime
#
#   # Fresh install (Fleet devops agent)
#   curl -fsSL ".../install.sh" | bash -s -- --role fleet --job devops
#
#   # Check for drift
#   install.sh --check
#
#   # Upgrade to new ref (non-destructive — overwrites manifest files only)
#   install.sh --upgrade main
# ============================================================
set -euo pipefail

# ---- Parse args ----
MODE="install"
UPGRADE_REF=""
ROLE=""
JOB=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   MODE="check"; shift ;;
    --upgrade) MODE="upgrade"; UPGRADE_REF="${2:-}"; shift 2 || { echo "[ERROR] Missing ref for --upgrade"; exit 1; } ;;
    --role)    ROLE="${2:-}"; shift 2 || { echo "[ERROR] Missing value for --role"; exit 1; } ;;
    --job)     JOB+=("${2:-}"); shift 2 || { echo "[ERROR] Missing value for --job"; exit 1; } ;;
    --help|-h) echo "Usage: install.sh [--check | --upgrade <ref>] [--role prime|fleet] [--job devops|engineer]"; exit 0 ;;
    *) echo "[ERROR] Unknown argument: $1"; exit 1 ;;
  esac
done

# Validate role/job combinations
if [[ ${#JOB[@]} -gt 0 && "$ROLE" != "fleet" ]]; then
  echo "[ERROR] --job requires --role fleet"
  exit 1
fi
if [[ -n "$ROLE" && "$ROLE" != "prime" && "$ROLE" != "fleet" ]]; then
  echo "[ERROR] --role must be 'prime' or 'fleet'"
  exit 1
fi

# ---- CONFIG (env-overridable) ----
GH_OWNER="${GH_OWNER:-YOUR_GITHUB_ORG}"
GH_REPO="${GH_REPO:-architect-prime-gcp-agent}"
CORE_REF="${CORE_REF:-main}"
INSTALL_ROOT="${CORE_ROOT:-/opt/corekit}"
INSTALL_USE_SUDO="${INSTALL_USE_SUDO:-1}"

# For upgrade mode, override CORE_REF with the target
if [[ "$MODE" == "upgrade" ]]; then
  if [[ -z "$UPGRADE_REF" ]]; then
    echo "[ERROR] --upgrade requires a ref argument"; exit 1
  fi
  CORE_REF="$UPGRADE_REF"
fi

CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"
STATE_FILE="${INSTALL_ROOT}/corekit/STATE.json"

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
  installed_role="$(json_value "role" "$STATE_FILE")"
  installed_job="$(json_value "job" "$STATE_FILE")"
  echo "Installed : ${installed_ref} (at ${installed_at})"
  echo "Role      : ${installed_role:-legacy}"
  echo "Job       : ${installed_job:-none}"
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

    full_path="${INSTALL_ROOT}/${file_path}"

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
  done < <(grep -o '"[^"]*":"sha256:[^"]*"' "$STATE_FILE")

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
    # On upgrade, read role/job from existing STATE.json if not specified
    if [[ -z "$ROLE" ]]; then
      ROLE="$(json_value "role" "$STATE_FILE")"
    fi
    if [[ -z "$JOB" ]]; then
      JOB="$(json_value "job" "$STATE_FILE")"
    fi
    echo "Role      : ${ROLE:-legacy}"
    echo "Job       : ${JOB:-none}"
  else
    echo "No previous install found, performing fresh install."
  fi
else
  info "Architect Prime Installer"
fi

echo "CoreKit : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "Target  : ${INSTALL_ROOT}"
echo "Role    : ${ROLE:-all (legacy)}"
echo "Job     : ${JOB[*]:-none}"

# ---- 1. Build manifest list ----
info "Building manifest..."
tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

if [[ -n "$ROLE" ]]; then
  # Fragment-based install: base + role + job
  MANIFEST_URLS=("${CORE_BASE}/infra/manifests/base.txt")

  if [[ "$ROLE" == "prime" ]]; then
    MANIFEST_URLS+=("${CORE_BASE}/infra/manifests/role-prime.txt")
  elif [[ "$ROLE" == "fleet" ]]; then
    MANIFEST_URLS+=("${CORE_BASE}/infra/manifests/role-fleet.txt")
    for j in "${JOB[@]}"; do
      MANIFEST_URLS+=("${CORE_BASE}/infra/manifests/job-${j}.txt")
    done
  fi

  # Download and concatenate all fragments
  manifest="${tmpdir}/manifest.txt"
  > "$manifest"
  for url in "${MANIFEST_URLS[@]}"; do
    echo "  Fetching: ${url##*/}"
    curl -fsSL --retry 3 --retry-delay 2 "$url" >> "$manifest"
    echo "" >> "$manifest"  # ensure newline between fragments
  done
else
  # Legacy mode: flat manifest.txt
  manifest="${tmpdir}/manifest.txt"
  curl -fsSL --retry 3 --retry-delay 2 "${CORE_BASE}/manifest.txt" -o "$manifest"
fi

# ---- 2. Parse manifest into pairs ----
# Format: <repo_relative_path> <dest_relative_to_HOME> [?]
# Lines starting with # are comments; blank lines are ignored.
# A trailing '?' means "install only if destination doesn't already exist" (no-clobber).
pairs=()
while IFS= read -r line; do
  # Strip comments and whitespace
  line="${line%%#*}"
  line="$(echo "$line" | xargs)" # trim
  [[ -z "$line" ]] && continue
  pairs+=("$line")
done < "${manifest}"

if [[ ${#pairs[@]} -eq 0 ]]; then
  die "No file pairs found in manifest"
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

  # Check for no-clobber flag (? suffix on dest)
  noclobber=0
  if [[ "$dest" == *\? ]]; then
    noclobber=1
    dest="${dest%?}"  # strip trailing ?
  fi

  # Safety: refuse absolute destination paths
  if [[ "$dest" == /* ]]; then
    die "Refusing absolute destination path: $dest"
  fi

  out_path="${INSTALL_ROOT}/${dest}"
  out_dir="$(dirname "$out_path")"
  src_url="${CORE_BASE}/${rel}"

  # No-clobber: skip if file already exists on disk
  if [[ $noclobber -eq 1 ]] && run test -f "$out_path" 2>/dev/null; then
    echo "  [skip] ${dest} (exists, no-clobber)"
    # Still include in STATE.json with existing file's hash
    tmpexist="$(mktemp)"
    run cat "$out_path" > "$tmpexist"
    hash="$(compute_sha256 "$tmpexist")"
    rm -f "$tmpexist"
    file_hashes["$dest"]="sha256:${hash}"
    installed=$((installed + 1))
    continue
  fi

  # Create directory and download
  run mkdir -p "$out_dir"
  echo "  [download] $src_url"
  curl -fsSL --retry 3 --retry-delay 2 "$src_url" -o "${tmpdir}/dl_tmp"

  # Strip Windows CRLF line endings (\r) — prevents shebang failures on Linux
  sed -i 's/\r$//' "${tmpdir}/dl_tmp" 2>/dev/null || true

  run cp "${tmpdir}/dl_tmp" "$out_path"

  # Compute hash for STATE.json
  hash="$(compute_sha256 "${tmpdir}/dl_tmp")"
  file_hashes["$dest"]="sha256:${hash}"

  installed=$((installed + 1))
done

echo "Installed ${installed} files into ${INSTALL_ROOT}."

# ---- 4. Set permissions ----
info "Setting ownership and permissions..."
run chown -R 1000:1000 "${INSTALL_ROOT}" 2>/dev/null || true
run find "${INSTALL_ROOT}" -type d -exec chmod 755 {} \; 2>/dev/null || true
run find "${INSTALL_ROOT}" -type f -exec chmod 644 {} \; 2>/dev/null || true
run find "${INSTALL_ROOT}/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true

# Belt-and-suspenders: ensure no CRLF in any bin scripts
# (defensive against SCP from Windows, git autocrlf, etc.)
run find "${INSTALL_ROOT}/bin" -type f -exec sed -i 's/\r$//' {} \; 2>/dev/null || true

# ---- 5. Write STATE.json ----
info "Writing STATE.json..."
state_dir="${INSTALL_ROOT}/corekit"
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
  \"version\": 2,
  \"coreRef\": \"${CORE_REF}\",
  \"owner\": \"${GH_OWNER}\",
  \"repo\": \"${GH_REPO}\",
  \"role\": \"${ROLE}\",
  \"job\": \"${JOB}\",
  \"installedAt\": \"$(date -Is)\",
  \"fileCount\": ${installed},
  \"fileHashes\": ${hashes_json}
}"

echo "$state_json" | run tee "${state_dir}/STATE.json" > /dev/null
run chown 1000:1000 "${state_dir}/STATE.json" 2>/dev/null || true
run chmod 644 "${state_dir}/STATE.json" 2>/dev/null || true

# ---- 6. Verify critical files ----
info "Verifying critical files..."
for check_file in \
  "${INSTALL_ROOT}/workspace/SOUL.md" \
  "${INSTALL_ROOT}/workspace/IDENTITY.md"; do
  if ! run test -f "$check_file"; then
    # Not fatal for fleet — workspace files are deployed by bootstrap, not manifest
    if [[ "$ROLE" == "fleet" ]]; then
      warn "Missing (expected for fleet pre-bootstrap): $check_file"
    else
      die "Missing after install: $check_file"
    fi
  fi
done

# ---- 7. Run contract validation (if script is available) ----
VALIDATE="${INSTALL_ROOT}/bin/validate-contracts"
if run test -x "$VALIDATE" 2>/dev/null; then
  info "Running contract validation..."
  if run "$VALIDATE" --runtime 2>&1; then
    echo "  ✅ Contracts validated"
  else
    warn "Contract validation found issues (non-fatal during install — bootstrap may fix)"
  fi
fi

if [[ "$MODE" == "upgrade" ]]; then
  info "Upgrade complete."
else
  info "Install complete."
fi
echo "  CoreKit : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "  Target  : ${INSTALL_ROOT}"
echo "  Role    : ${ROLE:-all (legacy)}"
echo "  Job     : ${JOB:-none}"
echo "  State   : ${state_dir}/STATE.json"
echo "  Files   : ${installed}"
