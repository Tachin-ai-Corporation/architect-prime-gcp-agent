#!/usr/bin/env bash
# design skill — provision headless Google Chrome (system-wide, reliable, all deps via the .deb).
# pandoc + the npm packages (puppeteer-core, axe-core, pptxgenjs) come from skill.json `requires`.
# Runs as root during skill-setup. Idempotent.
set -uo pipefail
log(){ echo "[design/setup] $*"; }

if command -v google-chrome-stable >/dev/null 2>&1; then
  log "chrome present: $(google-chrome-stable --version 2>/dev/null)"
  exit 0
fi

log "installing google-chrome-stable ..."
tmp="$(mktemp -d)"
url="https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
if command -v wget >/dev/null 2>&1; then
  wget -q -O "$tmp/chrome.deb" "$url" || log "WARN: chrome download failed"
else
  curl -fsSL -o "$tmp/chrome.deb" "$url" || log "WARN: chrome download failed"
fi

if [[ -s "$tmp/chrome.deb" ]]; then
  apt-get update -qq 2>/dev/null || true
  # apt resolves the .deb's dependencies (fonts, libs) automatically.
  apt-get install -y -qq "$tmp/chrome.deb" 2>&1 | tail -3 || log "WARN: apt install failed"
  log "chrome: $(google-chrome-stable --version 2>/dev/null || echo 'NOT installed')"
else
  log "WARN: no chrome.deb downloaded; design render/export/a11y tools will be unavailable"
fi
rm -rf "$tmp"
exit 0
