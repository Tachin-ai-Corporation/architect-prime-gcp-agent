#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — MANIFEST INSTALLER (install.sh)
#
# Standalone, idempotent installer that:
#   1. Fetches manifest.txt from the CoreKit repo at a pinned ref
#   2. Downloads each file to the correct destination
#   3. Writes STATE.json with provenance + file checksums
#
# Usage:
#   export CORE_REF="v0.2.0"
#   export OC_HOST_ROOT="/opt/openclaw"          # default
#   export GH_OWNER="Tachin-ai-Corporation"      # default
#   export GH_REPO="architect-prime-gcp-agent"   # default
#   curl -fsSL "https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}/install.sh" | bash
#
# When invoked from phase2-vm.sh, these vars are already set.
# ============================================================
set -euo pipefail

# ---- CONFIG (env-overridable) ----
GH_OWNER="${GH_OWNER:-Tachin-ai-Corporation}"
GH_REPO="${GH_REPO:-architect-prime-gcp-agent}"
CORE_REF="${CORE_REF:-main}"
OC_HOST_ROOT="${OC_HOST_ROOT:-/opt/openclaw}"
INSTALL_USE_SUDO="${INSTALL_USE_SUDO:-1}"

CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

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

info "Architect Prime Installer"
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

info "Install complete."
echo "  CoreKit : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "  Target  : ${OC_HOST_ROOT}"
echo "  State   : ${state_dir}/STATE.json"
echo "  Files   : ${installed}"
