# MEMORY (Main)

## Durable decisions

- Core kit is hosted publicly on GitHub and installed via `manifest.txt`.
- Canonical OpenClaw CLI wrapper is `oc` (never call `pnpm openclaw ...` directly).
- `exec` runs on the gateway host; sandbox regressions must be treated as configuration failures.
- OpenClaw version should be pinned by commit SHA (`OPENCLAW_PIN_SHA`) rather than date-based `PIN_BEFORE`.
- Workspace state files (`STATE.md`, `checkpoint/progress.json`) are seeded by bootstrap and maintained by Main.
- Cross-agent coordination uses `~/.openclaw/shared/`.

## Current status

- Bootstrap: complete (Phase 1 + Phase 2 one-shot verified).
- CoreKit: installed via manifest from GitHub.
- Agents: Main (gemini-2.5-flash), Engineer (gemini-3.1-pro-preview), DevOps (gemini-3.1-pro-preview).
- No plans executed yet. Awaiting first prompt.
