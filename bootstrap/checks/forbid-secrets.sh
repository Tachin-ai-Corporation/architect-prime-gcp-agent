\
#!/usr/bin/env bash
set -euo pipefail

# Fail if likely secrets appear in the repo.
# This is intentionally simple and biased toward safety.
patterns=(
  "BEGIN PRIVATE KEY"
  "private_key_id"
  "\"private_key\""
  "-----BEGIN"
  "AIza[0-9A-Za-z\-_]{30,}"
  "xox[baprs]-"
  "sk-[0-9A-Za-z]{20,}"
  "gcloud iam service-accounts keys create"
)

# Exclude common harmless files
exclude_globs=(
  ".git"
  "node_modules"
  "dist"
  ".openclaw"
)

files="$(git ls-files)"

hit=0
for p in "${patterns[@]}"; do
  if echo "$files" | xargs -I{} bash -lc "grep -RIn --binary-files=without-match --exclude-dir={.git,node_modules,dist} -e \"$p\" \"{}\" 2>/dev/null" | head -n 1 | grep -q .; then
    echo "[FAIL] Found pattern: $p"
    echo "$files" | xargs -I{} bash -lc "grep -RIn --binary-files=without-match --exclude-dir={.git,node_modules,dist} -e \"$p\" \"{}\" 2>/dev/null" | head -n 20
    hit=1
  fi
done

if [[ "$hit" == "1" ]]; then
  echo
  echo "Refusing to proceed: likely secret material detected."
  exit 2
fi

echo "[OK] No obvious secrets detected."
