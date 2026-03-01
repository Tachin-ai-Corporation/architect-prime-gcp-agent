# Architect Prime — CoreKit (GitHub-hosted)

This repo is intended to be **public**, with **no-login curl access** (raw.githubusercontent.com).

## What this is
A small, versionable “core kit” for Architect Prime that includes:

- OpenClaw config template (`openclaw-bootstrap.json5.tmpl`)
- Main / Engineer / DevOps workspace core files (AGENTS/SOUL/TOOLS/etc.)
- Canonical CLI wrapper `oc` (so the agent never regresses into `pnpm openclaw ...`)
- A repeatable smoke test script (`bootstrap_smoke.sh`)
- `exec-approvals.json` (to keep exec non-interactive and repeatable)

## How you use it (bootstrap pattern)
1) Pin a release ref (tag or commit SHA):
   - **Repeatable checkpoints:** use a tag like `cp004-ok`
   - **Development only:** `main`

2) Install via `manifest.txt` (your bootstrap owns the install loop).

### Expected environment variables
Your bootstrap should set:
- `GCP_PROJECT_ID`
- `MY_TOKEN`

Then render the config template to `/tmp/openclaw-bootstrap.json5`, e.g.:

```bash
export CORE_REF="cp004-ok"
export CORE_BASE="https://raw.githubusercontent.com/<OWNER>/<REPO>/${CORE_REF}"

curl -fsSL "${CORE_BASE}/bundle/corekit/config/openclaw-bootstrap.json5.tmpl" -o /tmp/openclaw-bootstrap.json5.tmpl
python3 - <<'PY'
import os, pathlib
tmpl = pathlib.Path("/tmp/openclaw-bootstrap.json5.tmpl").read_text()
for k in ["GCP_PROJECT_ID","MY_TOKEN"]:
    tmpl = tmpl.replace("${"+k+"}", os.environ.get(k,""))
pathlib.Path("/tmp/openclaw-bootstrap.json5").write_text(tmpl)
print("Rendered /tmp/openclaw-bootstrap.json5")
PY

# Apply (from /app)
cd /app && pnpm openclaw config apply /tmp/openclaw-bootstrap.json5
```

> Note: the agent should never call `pnpm openclaw ...` directly; it should always use `oc ...`.
> Your bootstrap should put `~/.openclaw/bin` on PATH for exec via config `tools.exec.pathPrepend`.

## Release date
2026-03-01
