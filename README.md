# Architect Prime

**Self-bootstrapping agent factory for Google Cloud.**

Architect Prime creates, upgrades, monitors, and tears down autonomous AI agents running inside your own GCP project. Each agent gets a Compute Engine VM, a host-native brain powered by Vertex AI, and a Google Workspace identity — reachable by chat and email, working alongside humans in the channels humans already use.

Prime handles **infrastructure, not orchestration**. Humans assign work to agents directly; agents delegate to each other directly. The factory builds and maintains the fleet — it never sits in the middle of the work.

Everything runs inside the operator's own GCP project: no shared infrastructure, no external runtime dependencies, no API keys. Authentication is Application Default Credentials, Domain-Wide Delegation, and per-agent IAM, end to end.

---

## Quick Deploy

### Cloud Shell (Recommended)

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/YOUR_GITHUB_ORG/architect-prime-gcp-agent&tutorial=infra/deploy/tutorial.md)

### Manual

```bash
git clone https://github.com/YOUR_GITHUB_ORG/architect-prime-gcp-agent
cd architect-prime-gcp-agent
export PROJECT_ID="your-project-id"
bash infra/deploy/install.sh
```

After install, open the printed URL to access the dashboard.

---

## Getting Started

1. **Deploy a Prime** — Dashboard → Enter a name → Click **Deploy Prime**. Ready in minutes.
2. **Configure DWD** *(optional, required for fleet Google Chat)* — See [Chat Setup](docs/CHAT_SETUP.md).
3. **Hire agents** — Set an agent email domain, create a Workspace email, then hire a specialist from the Fleet tab. Prime deploys a specialist VM and brings the agent online.
4. **Work** — Talk to Prime through the dashboard. Add fleet agent emails to Chat spaces. Agents read and respond independently.

---

## Architecture

```
Dashboard (Cloud Run — Next.js)
    │  control plane: fleet lifecycle, chat, work trees, introspection,
    │  projects, processes, plans, secret management
    ▼
Firestore (state store)
    ▼
Agent VMs (GCE, host-native under systemd — no containers)
    ├── agent-ears       — deterministic input: poll, dedup, fire-and-forget
    ├── agent-brain      — envelope orchestrator: classify, decide, dispatch
    ├── agent-mouth      — output delivery to the channel
    ├── agent-introspect — dashboard introspection bus
    └── neural-gateway    — cognitive organs: cortex, prefrontal, motor,
                           cerebellum, temporal-research, temporal-memory
```

The brain is a deterministic state machine that consults intelligence. It owns the loop; the models own only the judgments inside it. All work flows through the **R→M→C→T** envelope hierarchy (Responsibility → Mission → Checkpoint → Task). Models, ports, agent IDs, and all cross-cutting values live in [`infra/contracts.json`](infra/contracts.json) — the single source of truth, validated at bootstrap and upgrade. Work products are stored in the git artifact substrate (GCS-backed repos with Firestore CAS refs, one repo per project) with merge-policy governance (`auto` or `gated`) and changed-paths manifests. The brain daemon decomposes action handling through a dispatch table, enforces iteration guards against cortex non-compliance (including a dedup spin guard that forces synthesis when all checkpoint tasks replay from prior iterations), and budgets prior-results to prevent unbounded context growth. Any brain can pause a mission via the `wait` action — the daemon sets `waiting` state with a resume clock and resumes automatically via the poll loop (B-27). Completion ceremonies are centralized in a single `completeEnvelope()` lifecycle function, shared by both the ad-hoc cortex pipeline and the deterministic process engine. Prefrontal receives the full skill catalog for plan structuring. Delegation governance enforces concurrent-delegation guards, per-checkpoint caps, and dedup advisory nudges. Post-success processify evaluates completed missions for repeatable workflows and auto-creates process definitions. Post-mission context extraction mines project-relevant facts and persists them to project context. LLM cost telemetry tracks per-call and per-mission token usage. Claude Opus 4.6 streaming is supported via the neural gateway. Memory recall queries four layers — MEMORY.md, core-memory, 7-day work digest, and cue-driven episodic search — with structured telemetry and an escalation contract for deep retrieval.

For the full cognitive architecture, see [Brain Canon](docs/BRAIN_CANON.md). For governing invariants, see [Product Canon](docs/PRODUCT_CANON.md).

---

## Repository Layout

```
.
├── app/            # Dashboard control plane (Cloud Run, Next.js)
├── infra/          # contracts.json, install.sh, bootstraps, manifests
├── corekit/        # VM runtime — daemons, libs, tools, config
├── brain/          # Agent identity workspaces — SOUL.md, IDENTITY.md per role
├── specialties/    # Per-agent-type bundles — workspace, brain appends, skills
├── skills/         # Versioned skill packages — the system's codified know-how
├── docs/           # Canons, culture of work, primitives, guides, plans
└── MISSION_PLAN.md # What the system is and is becoming
```

Six modules, one home for everything. See [MISSION_PLAN.md](MISSION_PLAN.md) for the full map.

---

## Governing Documents

| Document | Purpose |
|----------|---------|
| [MISSION_PLAN.md](MISSION_PLAN.md) | Identity + trajectory — what Architect Prime is and is becoming |
| [Product Canon](docs/PRODUCT_CANON.md) | The walls — invariants that must never be crossed |
| [Brain Canon](docs/BRAIN_CANON.md) | The gradient — what better looks like for the brain |
| [Culture of Work](docs/CULTURE_OF_WORK.md) | The operational framework — eight primitives, the R→M→C→T spine |
| [contracts.json](infra/contracts.json) | Single source of truth for all cross-cutting values |

---

## Uninstall

```bash
export PROJECT_ID="your-project-id"
bash infra/deploy/uninstall.sh
```

---

## Version History

| Version | Date | Summary |
|----------|---------|---------|
| v2026.07.09.2.0 | 2026-07-09 | **Dashboard Chat Redesign**: removed the floating slide-out chat overlay from the main dashboard (`app/src/app/page.tsx`); updated dashboard routing to direct users to the dedicated full-page agent chat view (`/p/[primeId]/a/[agentName]#chat`); completely rewrote `ChatPanel.tsx` and `ChatPanel.module.css` to adopt a premium, centered, 1health-inspired conversational UI with a hero avatar, clean single-column feed, and glassmorphic input area. 3 files, 212 insertions, 316 deletions. |
| v2026.07.09.1.0 | 2026-07-09 | **Manifest fix + fleet recovery**: added missing `wait.mjs` to `base.txt` manifest (was imported by `actions/index.mjs` but never shipped — crashed agent-brain on every VM); created `/opt/corekit/lib` symlink on all 7 agent VMs; recovered all fleet and prime brains from crash-loop. 1 repo file, 7 VMs hotfixed. |
| v2026.07.07.4.0 | 2026-07-07 | **Probe pipeline fail-closed + load-bearing gating + bin-complete delivery**: terminal tools (`request_probe`, `report_pass`, `report_fail`) get 4000-char arg cap in tool log (was 200, truncating realistic probe payloads); `extractProbes` regex anchors on structural ` → ` separator instead of first `)` (paren-heavy instructions now parse); both empty-probes paths (checkpoint-executor + synthesize) fail closed (`result.success = false` / `activeGuard` with `probe_unparseable`) instead of silent pass; `load_bearing` Brief parts now widen attack duty and probe eligibility gates regardless of mission stakes; `composeAnswerFirst` renders all three bins (assumed → inferred → verified) under `— Reasoning —` / `— Risk & assumptions —` section markers; Mouth prompt preserves bin labels and markers. 5 files, 43 insertions. |
| v2026.07.07.2.0 | 2026-07-07 | **Epistemic Discipline (B-28..B-31)**: verification is re-derivation via independent probes (`request_probe` tool, daemon-dispatched fresh-context motor sessions, single re-verdict round); every claim carries its epistemic bin (verified/inferred/assumed) via `decide.assumptions[]` riding envelope to Mission Record and delivery; answer-first delivery composition (`composeAnswerFirst` in synthesize.mjs); named impostor anti-patterns owned per organ; attack duty (stakes-gated, three named attacks in cerebellum verification); schemas extended (classify: `stakes`/`job_to_be_done`, analyze: `check`/`assumes`/`load_bearing`/`kill_shot`/`premise`, decide: `answer`/`risk`/`assumptions[]`); irreversibility guard in checkpoint_plan; probe context stripping; 12 organ SOULs updated; verification/skill-authoring skills amended; `completion` delivery type in mouth. 31 files, 910 insertions. |
| v2026.07.07.1.0 | 2026-07-07 | **Wait activation + canon reconciliation**: added `wait` to the cortex decide schema enum and validator in `vertex-text.mjs` (the missing link that made `wait` reachable); added B-27 (timed-wait discipline); added `wait` to B-11's legal-move set; reconciled the Prime-role description in project-context and MISSION_PLAN; added a timed-wait subsection to CULTURE_OF_WORK; added the pause notification to the operator. |
| v2026.07.06.1.1 | 2026-07-06 | **Unbind Prime & Wait/Resume**: transformed Prime into a creative system operator with `system-shell`, `gcp-admin`, and `scripting` skills; implemented daemon-owned `wait` capability for all agents with deterministic resumption in `agent-brain.mjs`; amended Brain Canon (B-14, B-26) to codify Prime's unbinding and the `waiting` state. |
| v2026.07.06.1.0 | 2026-07-06 | **Google Docs Skill v5**: upgraded `workspace-docs` to support professionally formatted documents via HTML/CSS multipart upload, added `docs-clone-template` for placeholder replacement in template clones, added `docs-format-page` for margins/headers/footers/page numbers/orientation, and established a comprehensive Document Design System in SKILL.md. |
| v2026.07.05.3.0 | 2026-07-05 | Outcome Integrity: 7-checkpoint implementation — contract-driven `smartTruncate` transport (10 sites), durable mission records (output.md + result.json in git workspace), delegation trailer grammar with deterministic `work-output-read` recovery, accept criteria pinning via `[ACCEPT-CRITERIA]` blocks, GOAL STATE injection in decide payload with `goal_check` schema, universal completion verification (cerebellum pre-completeEnvelope), `accept_criteria` required in checkpoint schemas, Goal Discipline in both SOUL.md files, B-25 canon amendment. |
| v2026.07.05.2.0 | 2026-07-05 | Delegation Delivery Fix: normalized GChat space addressing in `makeAddress()` (`channel.mjs`) to ensure exactly one `spaces/` prefix — `gchat_space_id` values stored with the prefix were being double-prefixed to `spaces/spaces/...`, causing 404 on all delegation POSTs. Removed redundant manual prefixing from 5 call sites (`delegate.mjs`, `agent-brain.mjs` ×2, `checkpoint-executor.mjs`, `envelope-lifecycle.mjs`). Fixed `deliverDelegation()` in `agent-mouth.mjs` to throw on GChat POST failure — previously returned `false` silently, causing envelopes to be marked `delivered` despite 404 rejection. Verified end-to-end: Archie→Dot delegation now delivers successfully. |
| v2026.07.05.1.0 | 2026-07-05 | Delegation Silence Fix: added user-facing delegation acknowledgment envelope (immediate "I've delegated this to..." notification via Mouth), 4-hour delegation timeout escalation in `checkWaitingEnvelopes()` (fails delegation envelope + parent mission, delivers user-facing timeout message), and `status_update` delivery routing for needs_input/blocked envelopes. |
| v2026.07.04.2.0 | 2026-07-04 | Git Substrate Audit Fix: 14-finding audit resolution across 18 files. Transport correctness (private fetch namespace `refs/git-store/remote/{branch}`, push-race retry via rebase, merge re-merge loop, hard-fail on missing bundles, Firestore non-404 error surfacing, input validation with `sanitizeRepoId`/`validateBranch`). Merge policy governance (`resolveMergePolicy` with `auto`/`gated`, AWAITING_APPROVAL gate parking pending_merge on envelope context). Deterministic daily versioning (`allocateVersion`). Drive publish path fully removed — git manifest is now `context.artifacts`. Changed-paths manifests via `git diff --name-only mainBefore..mergedSha`. Store injection seam (`_setTestStore`/`_setTestConfig`) with 9-test local test suite (filesystem-backed mock store, no network). CI-safe test skip when GCP_PROJECT_ID unset. Migration script for Drive→Git artifact transition. Doc sweep across 8 SOUL/skill/reference files. |
| v2026.07.04.1.0 | 2026-07-04 | Git Artifact Substrate (C-24): GCS-backed git repos with Firestore CAS refs as the primary artifact storage. `git-store.mjs` transport layer (ensure, clone, fetch, push, merge, gc, manifest), `workspace-git` skill (8 motor atoms: work-clone, work-branch, work-commit, work-sync, work-merge, work-status, work-diff, work-log), daemon lifecycle integration (auto clone+branch on mission start, commit+sync per checkpoint, merge+manifest on completion), objects-before-refs crash safety, weekly GC responsibility. All 10 specialties updated with `workspace-git` base skill, Workspace Convention SOULs, and Workspace Convention Gate cerebellum verification. Canon C-24 added. |
| v2026.06.30.1.0 | 2026-06-30 | Chat Approval Routing Fix: added deterministic `handleApprovalResponse()` pre-check in `agent-brain.mjs` that intercepts approve/reject messages before LLM classification, queries pending approval docs in Firestore, flips the doc status, and triggers `resumeProcessPlan` — preventing approval messages from being mis-classified as new missions. Supports single/multi-pending disambiguation, numbered selection (`approve 2`), and `approve all`. Defense-in-depth: ears intercept → brain pre-check → approval checker poll. Also fixed double-logging in ears and mouth (removed redundant `appendFileSync` — systemd `StandardError=append` already persists stderr to log files). |
| v2026.06.28.7.6 | 2026-06-28 | Dashboard Chat Fix: aligned Firestore collection paths between dashboard, ears, and mouth for Prime agents. Dashboard writes/reads `primes/{id}/messages`, but mouth was writing responses to `primes/{id}/fleet/{hostname}/messages` and ears was stamping addresses with the VM hostname. Fixed: Prime ChatPanel passes `agentName=null` (was `agentName={id}`), ears stamps `fleet_agent: null` for dashboard channel, mouth overrides `fleet_agent` to null for Prime. Added send-failure handling to ChatPanel (removes optimistic message, restores input on error). |
| v2026.06.28.7.5 | 2026-06-28 | Work-Log-Read Owner Filter Fix: moved owner filtering from Firestore-side strict equality to client-side substring/segment matching in `work-log-read` brain tool. Firestore stores owner as full email (e.g. `assistant-agent-millie@tachin.ag`) but callers pass short names (e.g. `millie`). Also handles `mapValue` owner fields from channel addressing. Fixes Prime's inability to pull/review fleet agent work via `work-log-read --owner <agent>`. |
| v2026.06.28.7.4 | 2026-06-28 | Dashboard Work Tab & Telemetry Cost Fix: resolved active/archived work pages showing nothing and cost telemetry showing empty charts for the Prime agent by introducing a robust case-insensitive owner matching logic matching 'prime' with 'prime-{id}' and direct email prefixes. |
| v2026.06.28.7.3 | 2026-06-28 | Prime Manifest Workspace Skills Fix: added workspace-* skills to the `role-prime.txt` manifest so that self-improvement processes (like `p-improve-skills`) can read and grade fleet workspace skills on Prime VMs. |
| v2026.06.28.7.2 | 2026-06-28 | Fleet Upgrade Bootstrap Fix: updated `fleet-upgrade` to download the latest `upgrade-corekit` script from the target ref directly to the fleet VM before executing it. This resolves bootstrapping issues on agents running old versions of `upgrade-corekit` (e.g. stan) that fail to parse multiple space-separated jobs. |
| v2026.06.28.7.1 | 2026-06-28 | Audit & Cleanup Plan: deleted the superseded and contaminated legacy plan document `docs/fleet_improvement_prime_agent_plan.md`, and normalized executable bits (+x) on the 10 original `docs-*` scripts. |
| v2026.06.28.7.0 | 2026-06-28 | Google Docs Skill v4: upgraded workspace-docs skill to support formatting-capable generation and edits across three explicit lanes: Lane A (Markdown surface via multipart/related Drive upload), Lane B (surgical formatting-preserving edits using anchors/named ranges without index math), and Lane C (Word .docx round-trip), completely aligning assistant/designer/pm job manifests. |
| v2026.06.28.6.3 | 2026-06-28 | Fleet Upgrade Space-Separated Jobs Fix: corrected upgrade-corekit and install.sh to split existing space-separated jobs by word when reconstructing arguments for install.sh and running assemble-persona, preventing unknown argument failures (e.g. for archie with multiple jobs). |
| v2026.06.28.6.2 | 2026-06-28 | Custom Repository Settings: added ability for user to configure GitHub organization/owner and repository name in the settings System tab, stored these settings in Firestore config/settings, and propagated them when executing upgrade scripts and triggering Cloud Builds. |
| v2026.06.28.6.1 | 2026-06-28 | Prime CoreKit Upgrade Fix: resolved GH_OWNER and GH_REPO from STATE.json and GCE VM metadata in upgrade-corekit to prevent raw github 404/exit errors when environment variables are not populated, and handled RESOLVED_SHA retrieval errors gracefully without exiting the shell. |
| v2026.06.28.6.0 | 2026-06-28 | CI Fixes & Fleet Upgrade Resilience: fixed delegation test to expect `drive: null` field (unit test failure), added missing `workspace-drive/skill.json` to `role-fleet.txt` manifest (contracts validation failure), hardened `fleet-upgrade` to resolve VM from GCP metadata instead of requiring local fleet-registry.json, added Firestore coreRef sync on successful upgrade so dashboard reflects new version. |
| v2026.06.28.5.0 | 2026-06-28 | Tiered Improvement System (REPO vs LOCAL): 9 improvement modules (7 REPO + 2 LOCAL) replacing the flat 8-module set. Two tier-landing skills (`repo-improvement` for contamination scan + PR, `local-improvement` for Firestore/overlay with no PR) enforce the separation — REPO and LOCAL paths share nothing. `fresh-install-audit` skill with `fresh-install-scan` script provides the REPO contamination gate. Context & Memory split into machinery-repo + content-local; Work Layer split into platform-repo + operator-local. Delegation module deleted — findings routed to owning modules (daemons, souls, work-layer, context). All processes declare `tier` field. Triage and review processes updated to the 9-module tiered set with delegation routing rule. SOUL, manifest, and IMPROVEMENT_MODULES.md updated. |
| v2026.06.28.4.0 | 2026-06-28 | Prime Skill-Framework Readiness: `p-improve-skills` v3 process (7 steps, 2 operator approval gates, baseline→improve→re-test cycle with fleet agent loop, drops phantom `validate-skills` dependency), Prime cortex SOUL `Operator skill-improvement requests` routing section, `architect-prime` Firestore project record seeded (module-defs pointer + `workspace/skill-tests` sandbox path), `workspace/skill-tests/` created on Prime VM, fleet API filters removed/deleted agents from response (ghost agent fix). |
| v2026.06.28.3.0 | 2026-06-28 | Human-Triggered Improvement Loop & Install Hardening: new `p-review-and-improve` entry process (5 steps, operator-triggered via dashboard chat), Prime cortex SOUL rule for operator improvement requests, 4 improvement module processes rewritten to v2 (derive evidence from `work-log-read` trees, not phantom telemetry), `install.sh` JOB array migration fix (4 string-style refs under `set -u`), workspace template re-rendering on upgrade (reads agent identity from GCE metadata), job manifest lookup checks `operator/manifests/` first then `infra/manifests/`, fresh-install contamination punch list (genericize contracts.json owner, github.ts fallback, duplicate manifest, skill example Drive IDs). Full fleet upgrade: all 6 VMs (prime-chuck + 5 fleet) upgraded, contracts validated, templates rendered. |
| v2026.06.28.2.0 | 2026-06-28 | Operator Manifest Pipeline & Process Validation: multi-job manifest support in install.sh (array-based --job flags), operator_jobs VM metadata for fleet-bootstrap/fleet-deploy/upgrade-corekit, manifest path alignment to operator/ prefix, p-triage-improvement acceptance fix for Firestore-only changes, end-to-end process validation (improvement on chuck, web-content on archie), workspace-docs tab suggestion UX improvements. |
| v2026.06.28.1.0 | 2026-06-28 | Fresh-Install Contamination Remediation: 93 files changed — deleted committed scratch/ (37 findings), stripped hardcoded Tachin Drive/Cloud Run fallbacks from sync-service (fail-fast env vars), templatized contracts.json + bootstrap scripts (YOUR_GITHUB_ORG placeholders), removed operator website from base.txt manifest, relocated operator content (sites, processes, design docs, responsibilities) to operator/ directory with dedicated job manifest layer, genericized all example values across skills, specialties, corekit, and docs to example.com/fake IDs. Platform default surface is now operator-neutral for fresh forks. |
| v2026.06.27.1.2 | 2026-06-27 | Deterministic User Identity Resolution: stripped regex mappings for pinger email, extracted canonical identity fields directly from the GChat payload in `agent-ears` and `chat-read`, updated `agent-brain` to rely exclusively on `source_meta.senderEmail` for `## Requester` block injection, added strict email validation to `drive-share`, and standardized `SourceMeta` type in `types.ts`. |
| v2026.06.27.1.1 | 2026-06-27 | Robust Pinger Email Propagation: propagated `_sourceMeta` pinger email to prefrontal planning dispatches in `checkpoint_plan.mjs` and `agent-brain.mjs`, prepended the `## Requester (Pinger)` block to Cortex prompts in `callCortex`, implemented fallback owner variation normalization to `owner@example.com` inside `drive-share` script, and updated Firestore project registers for `your-website-project` and `legal-processes` to correct the owner email. |
| v2026.06.26.2.0 | 2026-06-26 | Fleet Mission Success at Scale: delegation governance (concurrent guard, per-checkpoint cap, dedup nudge), post-success processify (auto-creates processes from successful ad-hoc missions), plan-process alignment (checkpoint_plan checks for matching processes, project-scoped process preference in decide payload), post-mission context extraction (mines project facts from output via Flash), motor context discovery writes (9 SOUL_APPEND files with Project Context Discovery section), `project-manage` add-context/add-process subcommands. |
| v2026.06.26.1.0 | 2026-06-26 | Brain Audit Hardening: unified process-engine completion ceremony via `completeEnvelope` dep injection (fixed silent skip of memory/artifacts/cleanup/events for process missions), prefrontal skill catalog injection, `toStr` deduplication, bare `status='failed'` lifecycle routing, `handleAttach` status-query regex fix, `processIntakeAsNewTask` log type fix. |
| v2026.06.25.1.0 | 2026-06-25 | Drive Workspace Standard: deterministic `work-publish` artifact publisher enforcing `{project}/{MM-DD}/` and `{prime}/{agent}/{MM-DD}/` folder hierarchy, `artifacts.mjs` MM-DD date subfolders replacing old prime/agent nesting, `ensureAgentFolder()` at brain startup, delegation markers extended with `drive:<folderId>` field for project Drive context, `projects.mjs` rendering `work-publish` usage patterns, engineer agents granted Drive access (`workspace-drive` + full manifest), 9 motor SOUL_APPEND files with unified Drive convention, 9 cerebellum SOUL_APPEND files with Drive verification gate. Blocked delegation terminal state fix + delegation result notification fix. |
| v2026.06.22.1.0 | 2026-06-22 | Cross-Agent Delegation & Self-Delegation Prevention: delegation-first intelligence for Product Architect and PM agents, parallel delegation fan-out in checkpoint-executor, 4-layer self-delegation prevention (prefrontal SOUL ownership detection, cortex SOUL delegation rules, inbound delegation rules, code-level checkpoint-executor guard converting self-delegations to local motor tasks), designer motor SOUL with mandatory HTML writeFile workflow, assemble-persona integrated into upgrade-corekit for automatic specialty SOUL application during upgrades. |
| v2026.06.21.1.0 | 2026-06-21 | Memory System Overhaul: removed auto core-memory-write noise from daemon writeMemory() (only MEMORY.md auto-appends now, core memory via Motor tools and nightly consolidation only), hardened p-memory-consolidate process (scope enforcement preamble, printf pattern replacing fragile heredoc), updated memory-system SKILL.md with troubleshooting table and recovery procedures. |
| v2026.06.20.6.0 | 2026-06-20 | Episodic Memory Recall: work ledger as first-class recall source. recallMemory() queries 4 layers (MEMORY.md, core-memory, 7-day digest, cue-driven work search). New corekit/lib/work-recall.mjs (extractCues, scoreRelevance, searchWork, recentWorkDigest — 16 tests). Escalation contract for temporal-memory deep retrieval. core-memory-read --query client-side filtering. work-log-read snake_case fix. BRAIN_CANON B-15 extended with episodic framing. memory-consolidate work ledger scan step. |
| v2026.06.20.5.0 | 2026-06-20 | Fleet Skill Testing & Brain Hardening: tested all 13 deployed skills on Stan (DevOps) via live GChat injection. Dedup spin guard in checkpoint_plan.mjs prevents cortex from looping 5-7 iterations when all tasks replay from prior iterations (forces synthesize via activeGuard). EnforceSchema timeout fix (8s→15s configurable, Flash thinking disabled). Claude Opus 4.6 streaming enabled (stream().finalMessage() + top_p removal). Memory recall pre-fetch (daemon-side dual-pass retrieval). Dashboard agent-type detail page with manifest-driven skill discovery. Introspect dedup fix (seenSkillIds prevents duplicate base/specialty skills). Firebase SKILL.md updated with explicit valid CLI commands to prevent motor hallucination. |
| v2026.06.19.4.0 | 2026-06-19 | Skill System Cleanup: restructured skill-introspect to cortex-only "Agent Capabilities", created read-my-skills (all brain parts) and memory-recall (temporal-memory) skills, deleted workspace-chat (daemon capability not skill), merged work-logging into work-management "Culture of Work Tools", moved telemetry and skill-authoring to prime-only, renamed web-search to "Web Search & Fetch", removed Gmail from devops. Fleet skill count reduced from 20 to 13. |
| v2026.06.18.4.3 | 2026-06-18 | Checkpoint Executor dependency injection fix: passed buildProjectContext dependency to executeCheckpoints in agent-brain, process-engine, and checkpoint_plan action to resolve daemon runtime crash loops (ReferenceError: buildProjectContext is not defined) when processing projects. |
| v2026.06.18.4.2 | 2026-06-18 | Upgrade Script Self-Overwrite Protection: Added a self-cloning pre-execution check to `upgrade-corekit` that copies the script to `/tmp/upgrade-corekit` and runs it from there, preventing shell offset corruption when the script file on disk is overwritten during upgrades. |
| v2026.06.18.4.1 | 2026-06-18 | Command Runner & Manifest Fix: Fixed command-runner crashloop and brain daemon startup failures on VM upgrade by adding missing brain overhaul libraries and action handlers to base.txt manifest and updating upgrade-corekit to preserve/restore GCP_PROJECT_ID and PRIME_ID in command-runner.service on upgrade. |
| v2026.06.18.4.0 | 2026-06-18 | Skill Library Upgrade: upgraded all 36 skills to meet or exceed Grade 3, with 5 workspace/fleet skills at Grade 5 (`workspace-drive`, `workspace-gmail`, `workspace-docs`, `fleet-fire`, `fleet-hire`) and 12 skills at Grade 4, ensuring 0 errors and 0 warnings under `validate-skills.mjs`.
| v2026.06.18.3.3 | 2026-06-18 | GitHub Coordinates & Version Upgrade Fix: changed github.ts to lazy-resolve coordinates and base URLs via runtime functions to prevent Next.js startup crashes, updated 8 API route handlers to use dynamic getters, wrapped coordinate lookups in try/catch to return structured error details, auto-detected repository owner/repo in install.sh from git remote, and propagated coordinates during VM creation and dashboard upgrades.
| v2026.06.18.3.2 | 2026-06-18 | Final Gaps Decomposition: decomposed processes page into modular subcomponents (StepEditor, ParamEditor, ProcessDetailView, ProcessListView, CreateProcessModal) (Item 1), shared projects components on the global page (Item 2), extracted home page modals (Item 3), and decoupled presentation maps from brain-config API (Item 4).
| v2026.06.18.3.1 | 2026-06-18 | CI & Validation Fixes: fixed SyntaxError due to missing closing brace in agent-brain.mjs, converted validate-contracts script to use relative paths in repo mode for cross-platform compatibility, and added firebase-hosting-diagnostics skill files to job-devops manifest.
| v2026.06.18.3.0 | 2026-06-18 | Second Audit Gaps Resolution: fixed potential fallback criteria crash in checkpoint-executor.mjs via toStr() (Gap 1), corrected github.ts to fail closed in production while permitting local/build defaults (Gap 3), and enabled prompt caching (anthropic_prompt_caching) in contracts.json (Gap 5).
| v2026.06.18.2.0 | 2026-06-18 | Dashboard Audit Gaps Resolution: unified model scan routes under global endpoint /api/models/scan?primeId=... and deleted legacy prime route (D1.4), decomposed settings/page.tsx into 5 distinct tab components under components/settings/ (Issue 2) and restored DWDGuide for onboarding, decomposed projects/page.tsx into modular components under components/projects/ (Issue 3), and verified clean compilation (no tsc errors).
| v2026.06.18.1.0 | 2026-06-18 | Brain Overhaul Audit Implementation: resolved all 7 gaps from audit report. Wired motor failure detection via caller-side check in checkpoint-executor (Gap 1), implemented toStr coercion for task instructions (Gap 2), unified SWF state machine using exclusively _swf_state and removed legacy _unblock_attempted flags (Gap 3), wired checkpoint-executor into process-engine and agent-brain (Gap 4), extracted all inline action handlers to actions/ modules with DI signatures (Gap 5), wired prompt caching to contracts.json (Gap 6), and added enforceSchema validation for prefrontal plan output (Gap 7).
| v2026.06.17.10 | 2026-06-17 | 6-Phase Dashboard Refactor: client/server type coherence and duplicate type removal, centralized and de-hardcoded GitHub configuration with env var fallbacks, home page decomposition into dedicated components (OnboardingFlow, PrimeGrid, FleetVisualization, HireModal), screen-brain alignment (VerdictCard, InternalsPanel, global contracts API, approvals API, intent keywords display), operational features (CostDashboard, global approvals/telemetry APIs, responsibility fire history), and MCP schema/badge UI alignment |
| v2026.06.17.9 | 2026-06-17 | Brain Daemon Overhaul (Phases 1-5): completeEnvelope extraction (7 ceremony sites → 1), action dispatch table, guard enforcement, priorResults budget, SWF state machine, LLM cost telemetry, toStr type-safety sweep (25 sites), process engine verification hardening, shared modules (plan-utils, agent-output, checkpoint-executor, to-str, envelope-lifecycle), cerebellum E2E tests (8/8 passing) |
| v2026.06.17.3 | 2026-06-17 | Deployment Resilience: strip literal backslash-r from tools.mjs (gateway crash loop), add /snap/bin to command-runner PATH (gcloud unreachable → exit 127), inject GCP_PROJECT_ID/PRIME_ID env into bootstrap service heredoc |
| v2026.06.17.2 | 2026-06-17 | Knowledge Layer Hardening: full project context + source_text to motor, process selection by intent_keywords, hallucinated skill path guards, semantic stuck detection, firebase-hosting-diagnostics skill, p-memory-consolidate process, structured telemetry |
| v2026.06.17.1 | 2026-06-17 | Idempotency & replay-safety hardening (step ledger, durable claims, checkpoint resume, idempotent createCT) + neural gateway rename (brain-gateway → neural-gateway everywhere) |
| v2026.06.16.3 | 2026-06-16 | Brain-Part Skill Visibility & Dashboard Work Refactoring: structured scannable capabilities in system prompt, explicit cortex routing rules, R-type active container bucketing, and blocked status current-trees display |
| v2026.06.16.2 | 2026-06-16 | Flash Load & Execution Quality: parse-first enforceSchema, deterministic titles, context fidelity (smartTruncate), evidence floor, mandatory accept_criteria, orphan resume, ears preprocess gate, LoopGuard, dashboard responsibilities → Persona |
| v2026.06.15.3.0 | 2026-06-15 | Product-architect abstracted: removed all Architect Prime project context from role definition, renamed repo-audit→codebase-audit, discovery-driven auditing, empty responsibilities (configured at runtime) |
| v2026.06.15.2.0 | 2026-06-15 | Designer agent role (10th specialty), workspace-slides core skill (5 Slides API tools), DWD scopes fixed in dashboard + docs (was only showing chat scopes, now all 18) |
| v2026.06.15.1.0 | 2026-06-15 | SOUL + Skills canon audit: persona layer cognition-only (prefrontal refactored, cortex genericized, -2.5k lines), skills library normalized (daemon boundary, metadata, templates, validate enhanced), agent-types.json drift fixed |
| v2026.06.14.3.0 | 2026-06-14 | App-level artifacts config (survives teardown), Skills Library rewrite (pure catalog, brain function + agent role grouping, auto-discovery, search, click-to-popup) |
| v2026.06.14.2.0 | 2026-06-14 | Resilient Prime teardown (always cleans Firestore), zombie doc auto-cleanup on deploy, ears highwater defaults to now with /var/lib persistence |
| v2026.06.14.1.0 | 2026-06-14 | Eliminate TOOLS.md: skills as single source of truth, brain daemon skill index, assemble-persona, skill-setup, 6 new skill packages, agent_part arrays |
| v2026.06.13.5.0 | 2026-06-13 | Dashboard UI redesign: sidebar navigation for Prime/Fleet agent pages, AgentWorkPanel (4-tab work view with archived search), FleetPanel inline in Prime, enlarged chat input |
| v2026.06.08.2.0 | 2026-06-08 | Brain v3 envelope orchestration, 6-organ cognitive architecture, Culture of Work primitives |

---

## License

MIT License. See [LICENSE](LICENSE).
