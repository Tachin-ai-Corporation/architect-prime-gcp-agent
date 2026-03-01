\
#!/usr/bin/env bash
set -euo pipefail

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x bootstrap/*.sh bootstrap/checks/*.sh
else
  echo "[WARN] shellcheck not installed; running bash -n only"
  bash -n bootstrap/*.sh bootstrap/checks/*.sh
fi

echo "[OK] Shell scripts linted."
