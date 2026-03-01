# Architect Prime -- GCP Agent CoreKit

This repository defines the **public, curlable bootstrap contract** for
Architect Prime and its descendant GCP VM agents.

It contains **no secrets** and is safe to be public.

It is designed to be: - Installed via raw.githubusercontent.com - Pinned
to versioned checkpoints - Updated by Architect Prime itself - Used as a
pattern for deploying child agents

------------------------------------------------------------------------

# 1. Purpose

This repo provides:

-   Core OpenClaw bootstrap configuration
-   Agent persona/workspace seed files
-   A manifest-driven file layout
-   A versioned checkpoint model
-   A pattern Prime can reuse to deploy additional agents

This repo **does not** contain: - Service account keys - Tokens -
Project IDs - Internal URLs - Environment-specific values

------------------------------------------------------------------------

# 2. Versioning & Release Discipline

## Checkpoint Tags (Semantic Meaning)

Tags like:

cp001-init\
cp002-vertex-adc\
cp004-ok

ARE semantic.

They represent: - A known-good bootstrap state - A validated runtime
checkpoint - A reproducible deployment snapshot

Tags must only be created after: - Bootstrap completes successfully -
Smoke tests pass - Prime confirms stability

------------------------------------------------------------------------

## Rule for `main`

`main` may move forward with commits.

However:

-   `main` is **not** guaranteed stable.
-   Only checkpoint tags are considered stable install targets.
-   Bootstrap instructions should recommend pinning to a tag.

------------------------------------------------------------------------

## Pinning Recommendation

Default install recommendation:

CORE_REF=cp004-ok

Advanced / deterministic installs may pin to commit SHA.

Prime itself should: - Pin to tags during production upgrades - Use SHA
only during self-testing workflows

------------------------------------------------------------------------

# 3. Installation Model

Currently: - Human operator runs Cloud Shell - Executes bootstrap
scripts locally - Uses `manifest.txt` to install files

Future: - An `install.sh` will live in this repo - Prime will be able to
run the installer itself - Prime will be able to update itself using
this repo

------------------------------------------------------------------------

## Manifest Contract

`manifest.txt` defines file mappings.

Format:

# comment lines begin with

`<repo_path>`{=html} `<destination_path>`{=html}

Example:

bundle/corekit/config/openclaw-bootstrap.json5.tmpl
.openclaw/config/openclaw-bootstrap.json5.tmpl\
bundle/workspaces/main/AGENTS.md .openclaw/workspaces/main/AGENTS.md

Rules: - Destination paths are relative to `$HOME` - Installer must
create directories if missing - Installer must overwrite files
idempotently

------------------------------------------------------------------------

## Idempotency Requirement

Installs must:

-   Overwrite existing files safely
-   Be repeatable
-   Not fail due to existing directories
-   Not delete unknown files

------------------------------------------------------------------------

## Future Integrity Model

Installer should eventually record:

\~/.openclaw/corekit/STATE.json

Containing: - CORE_REF - Install timestamp - File hashes

This allows Prime to: - Detect drift - Perform upgrades safely - Verify
integrity

------------------------------------------------------------------------

# 4. Security Model

This repository is public.

It must NEVER contain:

-   Service account JSON keys
-   Access tokens
-   OAuth refresh tokens
-   Internal IPs
-   Internal hostnames
-   GCP project IDs
-   Organization IDs
-   Secret Manager references
-   .env files
-   Private endpoints
-   Gemini API keys
-   xAI API keys

If Prime attempts to commit any of the above, it must abort.

------------------------------------------------------------------------

## Runtime Secret Injection Model

Secrets must be:

-   Injected at runtime via environment variables
-   Managed in GCP Secret Manager
-   Passed into Docker or VM environment
-   Never stored in git

------------------------------------------------------------------------

# 5. Repository Structure

bundle/\
corekit/\
config/\
bin/\
scripts/\
openclaw/\
workspaces/\
manifest.txt\
README.md\
LICENSE

------------------------------------------------------------------------

## CoreKit

Contains: - Bootstrap template config - Wrapper binaries - Smoke test
scripts

------------------------------------------------------------------------

## Workspaces

Contains: - Agent persona files - Identity files - Tool restrictions -
Heartbeat configuration

These are safe to publish.

------------------------------------------------------------------------

# 6. Optional Packs (Future Expansion)

Prime will eventually extend this repo pattern.

Under `bundle/` we will add:

bundle/packs/chat-integration/\
bundle/packs/gcp-introspect/\
bundle/packs/pubsub-relay/

Each pack must: - Be installable via manifest - Contain no secrets - Be
self-contained - Follow same idempotent contract

Prime will: - Propose pack changes - Open PR - Await approval phrase -
Tag new checkpoint

------------------------------------------------------------------------

# 7. Self-Maintenance Governance Model

Architect Prime is expected to:

1.  Clone this repo in its GCP VM
2.  Create feature branch
3.  Modify bundle files
4.  Run local validation
5.  Open PR
6.  Await human approval phrase
7.  Merge
8.  Create new checkpoint tag

Prime must never: - Push directly to main - Modify tags retroactively -
Commit secrets

------------------------------------------------------------------------

# 8. Human Bootstrap Quickstart

Example:

export CORE_REF=cp004-ok\
export GCP_PROJECT_ID=architect-prime-beta\
export MY_TOKEN=\$(openssl rand -hex 16)

curl -L
https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/\$CORE_REF/manifest.txt

(Installer script logic here --- to be formalized in future
`install.sh`.)

------------------------------------------------------------------------

# 9. Long-Term Vision

This repo becomes:

-   The canonical pattern for deploying:
    -   Prime
    -   Fleet Agents
    -   Sub-agents
    -   Specialized GCP workers

Each agent deployment: - Pins to a checkpoint - Installs via manifest -
Injects runtime secrets - Registers with Prime

------------------------------------------------------------------------

# 10. Design Principles

-   Public
-   Deterministic
-   Idempotent
-   Self-upgradable
-   No secrets
-   Agent-maintainable
-   Human-auditable

------------------------------------------------------------------------

# Why This Structure Enables Prime Self-Evolution

This README:

-   Defines clear governance rules Prime can follow.
-   Defines what is forbidden.
-   Establishes checkpoint semantics.
-   Formalizes pack extensibility.
-   Prevents configuration drift.
-   Enables hierarchical deployment (Prime → Fleet Agents).
