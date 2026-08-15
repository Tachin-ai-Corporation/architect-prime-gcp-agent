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

# Dedupe --job (defence in depth; upgrade-corekit dedupes too). A repeated job
# fetches and concatenates the same manifest twice, and is written back verbatim
# to STATE.json — where the next upgrade re-expands it into flags again. That
# feedback loop reached 53 copies of one job on a production agent.
if [[ ${#JOB[@]} -gt 1 ]]; then
  _seen_jobs=" "
  _dedup_jobs=()
  for _j in "${JOB[@]}"; do
    case "$_seen_jobs" in *" ${_j} "*) continue ;; esac
    _seen_jobs="${_seen_jobs}${_j} "
    _dedup_jobs+=("$_j")
  done
  if [[ ${#_dedup_jobs[@]} -lt ${#JOB[@]} ]]; then
    echo "[WARN] Dropped $(( ${#JOB[@]} - ${#_dedup_jobs[@]} )) duplicate --job flag(s)"
  fi
  JOB=("${_dedup_jobs[@]}")
fi

# ---- CONFIG (env-overridable) ----
GH_OWNER="${GH_OWNER:-YOUR_GITHUB_ORG}"
GH_REPO="${GH_REPO:-architect-prime-gcp-agent}"
CORE_REF="${CORE_REF:-}"
INSTALL_ROOT="${CORE_ROOT:-/opt/corekit}"
INSTALL_USE_SUDO="${INSTALL_USE_SUDO:-1}"

# For upgrade mode, override CORE_REF with the target
if [[ "$MODE" == "upgrade" ]]; then
  if [[ -z "$UPGRADE_REF" ]]; then
    echo "[ERROR] --upgrade requires a ref argument"; exit 1
  fi
  CORE_REF="$UPGRADE_REF"
fi

# ---- C-35: only an immutable source may be activated ----
#
# This is the single structural gate for the whole install graph. A branch name
# is a moving target: two VMs installed "from main" minutes apart can hold
# different code while both claim the same ref, and a mid-install force-push
# produces a hybrid runtime with no way to name what is on disk. Every caller
# (fleet-deploy, both bootstrap scripts, upgrade-corekit, the control plane)
# resolves its human channel to a commit SHA *before* getting here, and fails
# closed if it cannot. Refusing anything else is what makes that discipline real
# rather than advisory.
if [[ -z "$CORE_REF" ]]; then
  echo "[ERROR] CORE_REF is required — resolve your channel (STABLE/main/tag) to a full commit SHA first." >&2
  exit 1
fi
if [[ ! "$CORE_REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[ERROR] CORE_REF must be a full 40-character commit SHA, got: '${CORE_REF}'" >&2
  echo "        Branch names and tags are not activatable (C-35). Resolve first, e.g.:" >&2
  echo "        CORE_REF=\$(curl -fsSL https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/commits/main | grep -m1 '\"sha\"' | cut -d'\"' -f4)" >&2
  exit 1
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

  # ---- Extra files: present under managed dirs but absent from STATE.json ----
  # Observability for orphans that predate the upgrade-time prune. Reported, not
  # treated as drift, to preserve the check-mode exit-code contract (0/2/3).
  declare -A known_dests
  while IFS= read -r match; do
    d="$(echo "$match" | sed 's/"\([^"]*\)":"sha256:.*/\1/')"
    [[ -n "$d" ]] && known_dests["$d"]=1
  done < <(grep -o '"[^"]*":"sha256:[^"]*"' "$STATE_FILE")
  # Two classes, reported distinctly so the label matches what actually happens:
  #   [ORPHAN] — under a reconciled dir (skills/, corekit/specialties/); step 4.6
  #             removes it on the next upgrade.
  #   [EXTRA]  — under bin/, corekit/lib/, corekit/processes/; reported only.
  #             bin/ is deliberately not swept (agents and skill-setup write there).
  extra_count=0
  orphan_count=0
  for scan_dir in skills corekit/specialties bin corekit/lib corekit/processes; do
    base="${INSTALL_ROOT}/${scan_dir}"
    run test -d "$base" 2>/dev/null || continue
    case "$scan_dir" in
      skills|corekit/specialties) tag="ORPHAN" ;;
      *)                          tag="EXTRA"  ;;
    esac
    while IFS= read -r f; do
      rel="${f#"${INSTALL_ROOT}"/}"
      if [[ -z "${known_dests[$rel]+x}" ]]; then
        echo "  [${tag}] ${rel}"
        if [[ "$tag" == "ORPHAN" ]]; then
          orphan_count=$((orphan_count + 1))
        else
          extra_count=$((extra_count + 1))
        fi
      fi
    done < <(run find "$base" -type f -not -path "*/custom-skills/*" 2>/dev/null)
  done
  [[ $orphan_count -gt 0 ]] && echo "  (${orphan_count} orphan(s) — removed on next upgrade by the manifest-truth reconcile)"
  [[ $extra_count -gt 0 ]] && echo "  (${extra_count} extra file(s) outside reconciled dirs — reported only, not removed)"

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
    if [[ ${#JOB[@]} -eq 0 ]]; then
      EXISTING_JOB="$(json_value "job" "$STATE_FILE")"
      if [[ -n "$EXISTING_JOB" ]]; then
        for j in $EXISTING_JOB; do
          JOB+=("$j")
        done
      fi
    fi
    echo "Role      : ${ROLE:-legacy}"
    if [[ ${#JOB[@]} -gt 0 ]]; then echo "Job       : ${JOB[*]}"; else echo "Job       : none"; fi
  else
    echo "No previous install found, performing fresh install."
  fi
else
  info "Architect Prime Installer"
fi

echo "CoreKit : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "Target  : ${INSTALL_ROOT}"
echo "Role    : ${ROLE:-all (legacy)}"
if [[ ${#JOB[@]} -gt 0 ]]; then echo "Job     : ${JOB[*]}"; else echo "Job     : none"; fi

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
    if [[ ${#JOB[@]} -gt 0 ]]; then
      for j in "${JOB[@]}"; do
        # Job manifests: operator/manifests/ (operator content) first,
        # then infra/manifests/ (platform specialties) as fallback.
        op_url="${CORE_BASE}/operator/manifests/job-${j}.txt"
        infra_url="${CORE_BASE}/infra/manifests/job-${j}.txt"
        if curl -sfI "$op_url" >/dev/null 2>&1; then
          MANIFEST_URLS+=("$op_url")
        else
          MANIFEST_URLS+=("$infra_url")
        fi
      done
    fi
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
declare -A noclobber_dests   # dests seeded no-clobber (?) — runtime-owned, never pruned
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
    noclobber_dests["$dest"]=1  # runtime-owned seed — excluded from the prune below
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

# ---- 3b. Layout symlinks ----
# bin/ daemon code is flattened into bin/ but imports ../../lib (= ${INSTALL_ROOT}/lib), while the
# actual modules install to corekit/lib. Create the bridge symlink so those imports resolve.
# Idempotent (ln -sfn) and self-healing. Older agents carry this symlink from an earlier install and
# keep it across upgrades — which is why only FRESH deploys regressed without it (agent-brain
# crash-loops with ERR_MODULE_NOT_FOUND on lib/*.mjs, e.g. lib/verdict.mjs from actions/synthesize).
run ln -sfn "${INSTALL_ROOT}/corekit/lib" "${INSTALL_ROOT}/lib"

# ---- 4. Set permissions ----
info "Setting ownership and permissions..."
run chown -R 1000:1000 "${INSTALL_ROOT}" 2>/dev/null || true
run find "${INSTALL_ROOT}" -type d -exec chmod 755 {} \; 2>/dev/null || true
run find "${INSTALL_ROOT}" -type f -exec chmod 644 {} \; 2>/dev/null || true
run find "${INSTALL_ROOT}/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true
# Skill setup.sh scripts live in skill dirs (not bin/), so the blanket 644 above leaves them
# non-executable and skill-setup's `-x` check skips them. Make any manifested setup.sh runnable.
run find "${INSTALL_ROOT}" -type f -name 'setup.sh' -exec chmod 755 {} \; 2>/dev/null || true

# Belt-and-suspenders: ensure no CRLF in any bin scripts
# (defensive against SCP from Windows, git autocrlf, etc.)
run find "${INSTALL_ROOT}/bin" -type f -exec sed -i 's/\r$//' {} \; 2>/dev/null || true

# ---- 4.5 Prune decommissioned files (C-9 removal discipline, C-18-safe) ----
# Remove files that were manifest-managed on the PREVIOUS install (recorded in
# STATE.json fileHashes) but are ABSENT from the CURRENT manifest. This is what
# makes manifest removal a real operation: a tool/skill deleted from a manifest
# (e.g. an agent send-CLI removed to enforce C-27) is deleted from the VM on the
# next upgrade instead of lingering as an orphan.
#
# Two protections keep runtime state safe: (1) files never in a manifest
# (node_modules/, shared/, custom-skills/, generated configs) are not STATE.json
# keys, so they are never candidates. (2) No-clobber (?) manifest seeds ARE
# recorded in STATE.json (they get hashed in at install), and several are LIVE
# runtime state — sessions.json, MEMORY.md, progress.json, fleet-registry.json,
# auth-profiles.json — so the loop below explicitly SKIPS no-clobber dests and
# the runtime dirs, pruning only decommissioned manifest-managed product files
# (bin/, skills/, lib/, processes). Honors C-18. Idempotent (a second run finds
# nothing stale). Guarded on a non-empty new manifest so a partial fetch cannot
# compute the whole prior tree as stale.
if [[ -f "$STATE_FILE" && ${#file_hashes[@]} -gt 0 ]]; then
  info "Pruning decommissioned files (manifest diff)..."
  pruned=0
  while IFS= read -r old_dest; do
    [[ -z "$old_dest" ]] && continue
    # Still manifest-managed? (present in the freshly-built dest set) → keep.
    if [[ -n "${file_hashes[$old_dest]+x}" ]]; then continue; fi
    # Never prune runtime-owned state: no-clobber (?) seeds recorded this run, or
    # anything under the runtime dirs / known runtime files — even if a future
    # manifest edit drops the seed line (its old STATE.json key would otherwise
    # make it a false stale candidate). Prune only decommissioned product files.
    if [[ -n "${noclobber_dests[$old_dest]+x}" ]]; then continue; fi
    case "$old_dest" in
      agents/*|workspace/*|workspace-*/*|*/MEMORY.md|*/progress.json|corekit/fleet-registry.json|corekit/chat-config.json) continue ;;
    esac
    stale_path="${INSTALL_ROOT}/${old_dest}"
    if run test -f "$stale_path" 2>/dev/null; then
      run rm -f "$stale_path" 2>/dev/null || true
      echo "  [prune] ${old_dest}"
      pruned=$((pruned + 1))
    fi
  done < <(grep -o '"[^"]*":"sha256:[^"]*"' "$STATE_FILE" | sed 's/"\([^"]*\)":"sha256:.*/\1/')
  # Sweep now-empty skill/action dirs left behind by pruned files.
  run find "${INSTALL_ROOT}/skills" "${INSTALL_ROOT}/bin/actions" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  echo "Pruned ${pruned} decommissioned file(s)."
fi

# ---- 4.6 Manifest-truth reconcile (orphans the STATE.json prune cannot see) ----
# The prune above is keyed on the PREVIOUS STATE.json: it removes what the last
# manifest owned and this one dropped. Anything orphaned BEFORE that mechanism
# existed was never a STATE.json key, so it is structurally invisible to it — and
# stays on the VM forever. A fleet audit found exactly that: `work-logging` (no
# source anywhere in the repo) on four agents, prime-only `telemetry` and
# `skill-authoring` on three fleet agents, fleet-only `delegation` on both primes,
# and a stale `specialties/assistant/` tree on an agent whose job had been
# switched. Every one reported `in_STATE=0`.
#
# This pass reconciles against the CURRENT manifest instead of the previous one:
# under the two directories that hold nothing but manifest-managed product content,
# any file the freshly-built manifest does not own is an orphan and is removed.
# Both scopes are exhaustively manifest-owned by construction — skills/ holds
# SKILL.md + skill.json, corekit/specialties/ holds specialty SOUL appends and
# skill bundles. Runtime state lives elsewhere (workspace*/, agents/, shared/) and
# is never scanned. custom-skills/ is excluded so agent-authored skills survive.
#
# NOT extended to bin/: agents legitimately write helper scripts there mid-mission,
# and skill-setup installs dependencies into it. Deleting those would violate C-18.
# Guarded on a non-empty manifest so a partial fetch cannot sweep the tree.
if [[ ${#file_hashes[@]} -gt 0 ]]; then
  info "Reconciling against current manifest (orphan sweep)..."
  orphaned=0
  for scan_dir in skills corekit/specialties; do
    base="${INSTALL_ROOT}/${scan_dir}"
    run test -d "$base" 2>/dev/null || continue
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      rel="${f#"${INSTALL_ROOT}"/}"
      # Owned by the manifest we just installed? → keep.
      if [[ -n "${file_hashes[$rel]+x}" ]]; then continue; fi
      # Runtime-owned seeds (?) and live agent state are never orphans.
      if [[ -n "${noclobber_dests[$rel]+x}" ]]; then continue; fi
      case "$rel" in
        */MEMORY.md|*/progress.json) continue ;;
      esac
      run rm -f "$f" 2>/dev/null || true
      echo "  [orphan] ${rel}"
      orphaned=$((orphaned + 1))
    done < <(run find "$base" -type f -not -path "*/custom-skills/*" 2>/dev/null)
  done
  run find "${INSTALL_ROOT}/skills" "${INSTALL_ROOT}/corekit/specialties" \
    -mindepth 1 -type d -empty -delete 2>/dev/null || true
  echo "Removed ${orphaned} orphaned file(s) not owned by the current manifest."
fi

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
  \"job\": \"${JOB[*]:-}\",
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

# ---- 6b. Render workspace templates (if on GCE) ----
# Workspace .md files contain {{AGENT_NAME}}, {{SPECIALTY}}, etc.
# On bootstrap these are rendered by fleet-bootstrap.sh; on upgrade, install.sh
# overwrites them with raw templates, so we must re-render here.
META_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
META_HEADER="Metadata-Flavor: Google"
TPL_AGENT_NAME="$(curl -sf -H "$META_HEADER" "$META_URL/agent_display_name" 2>/dev/null || true)"
if [[ -n "$TPL_AGENT_NAME" ]]; then
  info "Rendering workspace templates..."
  TPL_SPECIALTY="$(curl -sf -H "$META_HEADER" "$META_URL/specialty" 2>/dev/null || true)"
  TPL_EMAIL="$(curl -sf -H "$META_HEADER" "$META_URL/agent_user_email" 2>/dev/null || true)"
  TPL_PROJECT="$(curl -sf -H "$META_HEADER" "$META_URL/gemini_project" 2>/dev/null || echo "${GH_OWNER:-unknown}")"
  # Escape sed-special chars
  TPL_AGENT_NAME_ESC="${TPL_AGENT_NAME//&/\\&}"
  TPL_SPECIALTY_ESC="${TPL_SPECIALTY//&/\\&}"
  TPL_EMAIL_ESC="${TPL_EMAIL//&/\\&}"
  TPL_PROJECT_ESC="${TPL_PROJECT//&/\\&}"
  for f in "${INSTALL_ROOT}"/workspace*/*.md; do
    [[ -f "$f" ]] || continue
    sed -i \
      -e "s|{{AGENT_NAME}}|${TPL_AGENT_NAME_ESC}|g" \
      -e "s|{{SPECIALTY}}|${TPL_SPECIALTY_ESC}|g" \
      -e "s|{{PROJECT_ID}}|${TPL_PROJECT_ESC}|g" \
      -e "s|{{AGENT_USER_EMAIL}}|${TPL_EMAIL_ESC}|g" \
      -e "s|{{DEPLOY_TIMESTAMP}}|$(date -u +%Y-%m-%dT%H:%M:%SZ)|g" \
      "$f"
  done

  # Also render contracts.json placeholders
  CONTRACTS_FILE="${INSTALL_ROOT}/corekit/contracts.json"
  if [[ -f "$CONTRACTS_FILE" ]]; then
    TPL_GH_OWNER="$(curl -sf -H "$META_HEADER" "$META_URL/gh_owner" 2>/dev/null || echo "${GH_OWNER:-}")"
    if [[ -n "$TPL_GH_OWNER" ]]; then
      sed -i "s|YOUR_GITHUB_ORG|${TPL_GH_OWNER//&/\\&}|g" "$CONTRACTS_FILE"
    fi
  fi
fi

# ---- 7. Run contract validation (C-19: fatal, before anything starts) ----
#
# This was previously a warning. A warning is not a gate: an install that fails
# validation still finished, still reported success, and still let the caller
# restart services onto a runtime whose contracts do not hold. Validation now
# fails the install. During first-boot the bootstrap script may legitimately run
# install.sh before the runtime is fully assembled, so a bootstrap caller passes
# INSTALL_VALIDATE=defer and validates once at the end of its own sequence.
VALIDATE="${INSTALL_ROOT}/bin/validate-contracts"
INSTALL_VALIDATE="${INSTALL_VALIDATE:-fatal}"
if run test -x "$VALIDATE" 2>/dev/null; then
  info "Running contract validation..."
  if run "$VALIDATE" --runtime 2>&1; then
    echo "  ✅ Contracts validated"
  elif [[ "$INSTALL_VALIDATE" == "defer" ]]; then
    warn "Contract validation failed — deferred to the bootstrap sequence (INSTALL_VALIDATE=defer)"
  else
    die "Contract validation failed. Refusing to complete an install whose contracts do not hold (C-19)."
  fi
elif [[ "$INSTALL_VALIDATE" != "defer" ]]; then
  die "validate-contracts is not installed at ${VALIDATE} — cannot verify this install (C-19)."
fi

if [[ "$MODE" == "upgrade" ]]; then
  info "Upgrade complete."
else
  info "Install complete."
fi
echo "  CoreKit : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "  Target  : ${INSTALL_ROOT}"
echo "  Role    : ${ROLE:-all (legacy)}"
if [[ ${#JOB[@]} -gt 0 ]]; then echo "  Job     : ${JOB[*]}"; else echo "  Job     : none"; fi
echo "  State   : ${state_dir}/STATE.json"
echo "  Files   : ${installed}"
