# Architect Prime — Project Context

## What this project is
Architect Prime is an AI agent fleet management system for Google Workspace on GCP. It deploys autonomous AI agent teams (each with its own VM, host-native neural gateway, and Google Chat identity) that collaborate with humans via Google Chat.

## Current Architecture (v2026.06.22.1.0)

### System Stack
- **Cloud Run** — Next.js dashboard (18-route breadcrumb-navigated hierarchy, 1health design system) + REST API (control plane)
- **Firestore** — State: primes, fleet, messages, tasks, dispatch-log, introspect queries, config
- **Compute Engine VMs** — One per Prime + one per fleet agent
- **Neural Gateway** — Host-native AI neural gateway on each VM (Gemini 3.5 Flash / 3.1 Pro via Vertex AI ADC, Claude Opus 4.6 via Anthropic streaming)
- **Google Chat** — Agent-to-human communication via DWD

### Prime VM Architecture
- **6-agent brain**: cortex (plan executor) + 5 sub-agents (temporal-research, temporal-memory, prefrontal, motor, cerebellum)
- **Brain v3 (agent-brain.mjs)**: Deterministic envelope-based orchestration daemon running as a continuous systemd service. Polls Firestore intake → Cortex classify → Cortex decide loop → dispatches to sub-agents → synthesize. M→C→T hierarchy enforced for ALL output (acks, synthesize responses) via `createCT()` helper. R/M/C/T hierarchy (Responsibilities → Missions → Checkpoints → Tasks). Rich context assembly: SOUL.md + IDENTITY.md + MEMORY.md + full agent registry in system prompt (~20K tokens). Envelope context accumulation (400K token rolling budget with oldest-first pruning). Per-agent generation parameters from agent-registry.json. Memory recall/write. Multi-step plans with retry. Delegation. Semantic failure detection. Responsibility scheduler (cron-driven, auto R→M envelopes). Contextual ack with recent mission history + project awareness. Motor timeout detection (`timed_out` status) with cortex `continue` action for re-dispatching timed-out tasks. Process step type dispatch (standard/delegation/spawn_responsibility/approval_gate/optional). Approval gate polling and resume. Responsibility→process linking via processRef (auto-execute, skip Cortex decide).
- **Memory System Overhaul (v2026.06.21.1.0)**:
  - **Removed auto core-memory-write**: `writeMemory()` in agent-brain.mjs no longer writes raw mission dumps to Firestore core memory on every envelope completion. Only MEMORY.md (working memory) is auto-appended. Core memory writes are now exclusively via Motor tool calls (intentional, curated facts) and the nightly `p-memory-consolidate` process (triage and promotion). This eliminates unbounded noise accumulation in long-term memory.
  - **Process hardening (p-memory-consolidate)**: Added SCOPE ENFORCEMENT preamble to step 1 preventing context contamination from unrelated active work. Replaced fragile heredoc syntax in step 8 with deterministic printf pattern for MEMORY.md rewriting.
  - **memory-system SKILL.md**: Added troubleshooting table for common failure modes (oversized MEMORY.md, failed consolidation, skipped appends), manual recovery steps, and documented the 3000-char size guard behavior.
- **Cross-Agent Delegation & Self-Delegation Prevention (v2026.06.22.1.0)**:
  - **Delegation-first intelligence**: Product Architect and PM agents are configured as "delegators, never implementers" — cortex/prefrontal SOUL mandates delegation before self-execution. Cortex classify/decide payload includes project team roster for informed delegation decisions.
  - **Parallel delegation fan-out**: checkpoint-executor processes all delegation tasks in a single checkpoint before waiting, enabling parallel multi-agent dispatch within one checkpoint pass.
  - **Self-delegation prevention (4-layer defense)**:
    - Layer 1 — Prefrontal SOUL: Specialty ownership detection distinguishes self vs teammate specialty, marks own specialty tasks as `agent: motor`.
    - Layer 2 — Cortex SOUL: "Execute work matching your own specialty via motor. NEVER delegate work to an agent with the same specialty as myself."
    - Layer 3 — Cortex SOUL: "When another agent delegates a task to me, that task is for ME to execute via motor. I do NOT re-delegate it."
    - Layer 4 — Code guard: `checkpoint-executor.mjs` compares `targetAgentEmail` against `AGENT_EMAIL` — if delegation resolves to self, silently converts to local motor task (`stepType = 'standard'`, `taskAgent = 'motor'`).
  - **Designer motor SOUL**: Mandatory 6-step workflow for HTML/CSS file modifications — web-fetch → readFile → plan changes → writeFile (complete file) → verify. Prevents the motor from outputting HTML inline instead of writing files.
  - **assemble-persona in upgrade-corekit**: `upgrade-corekit` now runs `assemble-persona` automatically during upgrades, ensuring specialty SOUL_APPEND changes are applied without a separate bootstrap step.
  - **Delegation delivery**: `checkpoint-executor.mjs` creates delegation marker envelopes with `delivery_status: 'pending'` for mouth pickup. Target resolution via Firestore `primes/{id}/fleet` specialty lookup with direct `target_email` override.
- **Brain Overhaul Audit Implementation (v2026.06.18.1)**:
  - **Motor Failure Detection Caller Wiring**: Imported and called `detectMotorFailure` in `checkpoint-executor.mjs` to check motor execution output/error and fail-fast if a token expiration or auth failure is found (resolved Gap 1 regression).
  - **toStr Coercion Protection**: All task and checkpoint string references (e.g. `.substring()`) are wrapped in `toStr` coercion to prevent crash sites when Cortex returns raw objects for task names (resolved Gap 2).
  - **SWF State Machine Sync**: Replaced all legacy `_unblock_attempted` boolean references with the `_swf_state` enum (`'awaiting_unblock'` / `'unblock_attempted'`) across `agent-brain.mjs` and actions to ensure sync in post-unblock guards (resolved Gap 3).
  - **Converged Checkpoint Executor**: Replaced independent execution paths in both `agent-brain.mjs` (`handleCheckpointPlan` + resume paths) and `process-engine.mjs` (`runProcessPlan`) with a unified delegate call to `executeCheckpoints` from `checkpoint-executor.mjs` (resolved Gap 4).
  - **Decomposed Action Handlers**: Fully extracted the remaining 4 large inline action blocks (`synthesize_with_failure`, `follow_process`, `delegate`, `checkpoint_plan`) into separate modules under `corekit/daemon/actions/` using Dependency Injection (DI) signatures, reducing `_processEnvelopeInner` to under 200 lines (resolved Gap 5).
  - **Prompt Caching Config**: Wired prompt caching flag in `loop.mjs` to read from `contracts.json` instead of a hardcoded false value (resolved Gap 6).
  - **Prefrontal EnforceSchema**: Added `plan` schema to `CORTEX_SCHEMAS` in `vertex-text.mjs` to validate Prefrontal structured plan output via `enforceSchema` (resolved Gap 7).
- **Brain-Part Skill Visibility & Dashboard Work Refactoring (v2026.06.16.3)**:
  - **Structured Agent Registry**: The raw JSON registry dump in the Cortex system prompt has been replaced with a clean, scannable format, making agent capabilities and tool constraints highly visible.
  - **Explicit Task Routing Rules**: Added rules in Prime and Fleet Cortex `SOUL.md` files mapping memory tasks to `temporal-memory` only, mutations to `motor`, research to `temporal-research`, verification to `cerebellum`, and decomposition to `prefrontal`, strictly forbidding assigning tasks to agents lacking the required tools.
- **Deployment Resilience (v2026.06.17.3)**:
  - **tools.mjs CRLF fix**: Subagent edits introduced literal `\r` (backslash-r) two-character sequences at the end of 73 lines. Node.js ESM parser treated these as invalid tokens → gateway crash loop (restart counter 500+). Stripped and committed.
  - **command-runner PATH**: `gcloud` on Ubuntu snap lives at `/snap/bin/gcloud`. The command-runner systemd service `PATH` didn't include `/snap/bin` → all fleet deploy/teardown commands failed with exit 127. Fixed in both the live service and `prime-bootstrap.sh` heredoc.
  - **command-runner env injection**: Template `.service` files lack `GCP_PROJECT_ID`/`PRIME_ID` (injected at bootstrap time via heredoc). Manual service installation during hotfix recovery must read these from VM metadata and inject into the unit file.
- **Knowledge Layer Hardening (v2026.06.17.2)**:
  - **Full project context to Motor**: `_projectContext` and `_sourceText` flow as first-class fields through all 3 motor dispatch paths (checkpoint, resume, process-engine). Motor's user message now includes `## Project Context` and `## Original User Request` sections, giving motor the full operational map (hosting rewrites, bucket names, service URLs) and the user's raw request.
  - **Process selection by intent**: `intent_keywords` arrays on process definitions (p-investigate, p-plan) surfaced in Cortex decide payload. DevOps Cortex SOUL adds "Diagnostic Intent Detection" section to prefer p-investigate for symptom/bug reports.
  - **Hallucinated path guard**: `readFile` on nonexistent skill paths lists available skills. Both skill catalogs (gateway-side `buildSkillCatalogPrompt` and brain-side `formatSkillCatalog`) emit exact `→ readFile <path>` per skill with "Do NOT guess skill paths."
  - **Semantic stuck detection**: LoopGuard enhanced with per-tool-name counters (nudge at 8 calls regardless of args), structured `[STUCK REPORT]` JSON on terminate, and `getMetrics()` export.
  - **firebase-hosting-diagnostics skill**: 6-step diagnostic procedure codifying Drive→sync→GCS→proxy→Firebase Hosting pipeline investigation.
  - **p-memory-consolidate process**: 8-step dedicated process for nightly memory consolidation with pre-flight bootstrap (step 1 creates MEMORY.md template if missing). Wired to `r-memory-consolidation` via `processRef`.
  - **Structured telemetry**: `[TELEMETRY] motor_dispatch` and `[TELEMETRY] process_selected` structured log lines for observing motor stuck rate, timeout rate, project context injection status, and process selection.
- **Brain Daemon Overhaul (v2026.06.17.9)**:
  - **completeEnvelope()**: Unified lifecycle function for all terminal state transitions (complete, blocked, needs_input, failed). Replaces 7 inline ceremony sites. Lives in `corekit/lib/envelope-lifecycle.mjs` (standalone factory) and inline in `agent-brain.mjs` (closure-scoped).
  - **Action dispatch table**: 4 handlers extracted to named functions (synthesize, blocked, needs_input, status_update) with `ACTION_HANDLERS` dispatch table. 4 larger handlers (swf, follow_process, delegate, checkpoint_plan) remain inline.
  - **Guard enforcement**: Generalized `_activeGuard` mechanism — guards specify `forbidden` action and `fallback` override, enforced one-shot per iteration. Applied to premature-synthesize and follow_process already-executed guards.
  - **priorResults budget**: Configurable via `dispatch.prior_results_max` contract (default 25). Keeps last 60%, summarizes older entries. Prevents unbounded context growth.
  - **SWF state machine**: `_swf_state` enum (null → awaiting_unblock → unblock_attempted) replaces implicit boolean + string search.
  - **LLM cost telemetry**: Per-call `[TELEMETRY] llm_usage` and per-mission `[TELEMETRY] mission_total` with input/output/cached token counts.
  - **toStr sweep**: 25 `.substring()` sites wrapped with `toStr()` for type safety on LLM/Firestore-origin fields.
  - **New modules**: `corekit/lib/` now contains: `envelope-lifecycle.mjs`, `checkpoint-executor.mjs`, `plan-utils.mjs`, `agent-output.mjs`, `to-str.mjs`, `verdict.mjs` (preexisting).
  - **Process engine hardening**: No-verdict path (cerebellum returns text without calling verdict tool) now continues with telemetry warning instead of implicit fallthrough.
  - **Cerebellum E2E tests**: `tests/cerebellum-verdict.test.mjs` — 8 tests covering verdict extraction, motor failure detection, plan extraction.
- **Idempotency & Replay-Safety Hardening (v2026.06.17.1)**:
  - **Step Ledger**: Deterministic step keys (SHA-256 of `[envId, iteration, action, target]`) recorded in a `step_ledger` field on each envelope. Before every dispatch, the brain checks the ledger and skips already-completed steps — preventing duplicate work on replay.
  - **Durable Claim**: `claimed_by` / `claimed_at_ms` fields on envelopes provide a Firestore-backed processing lock that survives daemon restarts. Stale claims auto-cleared on startup.
  - **Idempotent createCT**: All C→T pair creation uses a `ctKey` for dedup — replaying a crash-interrupted synthesis or ack never creates duplicate envelopes.
  - **Checkpoint Resume**: `_cp_progress` persisted after each task step. On crash recovery, `processEnvelope` detects saved progress and resumes from the last completed step via `executeCheckpointPlanResume()`.
  - **Feature flags**: `dispatch.step_ledger_enabled`, `dispatch.checkpoint_resume_enabled`, `dispatch.claim_stale_ms` in contracts.json (all default-enabled).
- **Neural Gateway Rename (v2026.06.17.1)**: `agent-brain-gateway` systemd service renamed to `agent-neural-gateway` across all code, bootstrap scripts, service files, and documentation.
  - **Dashboard Work Tab Classification**: Refactored `useWorkEnvelopes.ts` and `/api/primes/[id]/work` to properly classify R-type containers under "In Progress" when they have active/pending descendant child missions, and added `"blocked"` status to `ACTIVE_STATUSES` so blocked work is kept in "In Progress" with a crimson pulsing visual indicator.
- **Flash Load & Execution Quality (v2026.06.16.2)**:
  - **Parse-first enforceSchema**: `enforceSchemaFn` validates Opus JSON deterministically (parseJsonResponse + field/enum validation) before calling Flash. Flash LLM call is now a rare repair path, not universal. Saves ~3 Flash calls per mission turn.
  - **Deterministic titles**: `generateTitle` uses `summarizeTitle` (pure JS, no LLM) for checkpoints and tasks. LLM titles reserved for missions only. Saves ~10 Flash calls per mission.
  - **Context fidelity**: Prior results and failure context forwarded via `smartTruncate` (deterministic head+tail) instead of `smartSummarize` (LLM). Preserves raw error messages, file paths, and tool output that LLM summarization was destroying.
  - **Evidence floor**: After motor returns, deterministic check flags suspiciously shallow completions (fast + few tools + no writes) with `[EVIDENCE WARNING]` annotation for cerebellum.
  - **Mandatory accept_criteria**: Tasks without explicit criteria get a default, ensuring cerebellum verification never silently skips.
  - **LoopGuard**: Detects stuck motor loops. Duplicate tool calls: nudge at 3, terminate at 5. Consecutive errors: nudge at 5, terminate at 8. Semantic stuck detection: nudge at 8 same-tool calls even with different args. Structured `[STUCK REPORT]` JSON on terminate. `getMetrics()` export for telemetry.
  - **Orphan resume**: Startup recovery resumes missions with terminal children (re-enters processEnvelope for Cortex re-planning) instead of skipping them.
- **Prime role: infrastructure only** — fleet management (hire/fire/upgrade/monitor), visibility, delegation. ZERO Google Workspace tools. Prime's skills will be progressively exposed through the dashboard for manual triggering.
- **Tool ownership boundaries:**
  - Prime Motor has fleet lifecycle tools only (fleet-deploy, fleet-hire, fleet-fire, fleet-status, fleet-upgrade, fleet-verify)
  - Fleet Motor owns Google Workspace tools per job type: devops (Drive), pm (Drive+Gmail+Docs+Sheets), assistant (Drive+Gmail+Calendar+Docs), etc.
  - temporal-research is web search + URL fetching (Vertex AI grounding + web-fetch, zero execution tools)
  - temporal-memory is pure memory (core-memory-read/write only, zero external APIs)
  - cerebellum is a pure test runner: executes validation rules, reports PASS/FAIL with evidence, structured verdicts (ALL_PASS/FAIL/NO_RULES)
- **Dynamic skill awareness**: Brain daemon builds `skill_index` deterministically by scanning `/opt/corekit/skills/` at startup. Index is injected into cortex classify/decide payloads as structured context (same pattern as `project_registry`, `agent_registry`). Execution agents read specific SKILL.md on-demand via `readFile /opt/corekit/skills/<name>/SKILL.md`. `skill.json` manifests define `agent_part` (array), `requires` (VM deps), `scripts`, `when_to_use`. `skill-author` Motor tool for generating new skill packages. `skill-setup` installs VM dependencies declared in `requires`. Custom skills synced from Firestore during `upgrade-corekit`. Prime runs nightly `r-skill-discovery` responsibility to propose new skills. Dashboard 3-tab skills page (Installed/Library/Proposals) with per-agent install/uninstall.
- **Skill distribution (v2026.06.20.1.0)**: Universal skills (all agents): `skill-introspect` (cortex-only capability awareness), `read-my-skills` (all parts — per-brain-part skill doc reader), `secrets`, `work-management` (merged from work-management + work-logging), `memory-recall` (temporal-memory dual-pass retrieval), `delegation`, `verification`, `plan-structuring`. Fleet-only additions: `web-search` (renamed from Vertex AI Grounding Search), `memory-consolidate`. Prime-only skills: `telemetry`, `skill-authoring`, fleet lifecycle tools. Workspace-chat deleted (chat I/O is handled by ears/mouth daemons, not a brain skill).
- **Fleet Skill Testing & Brain Hardening (v2026.06.20.5.0)**:
  - **Dedup spin guard**: When checkpoint_plan returns with all tasks replayed (deduped from prior iterations), a `[SYSTEM]` message forces cortex to synthesize and an `activeGuard` blocks further `checkpoint_plan` actions. Prevents 5-7 iteration spin loops observed in field testing.
  - **EnforceSchema timeout fix**: Configurable `enforce_schema_timeout_ms` (default 15s, was hardcoded 8s) and `enforce_schema_max_attempts` (default 2) in contracts.json. Flash thinking disabled for schema enforcement calls to prevent timeout cascade.
  - **Claude Opus 4.6 streaming**: Neural gateway uses `stream().finalMessage()` for Anthropic calls instead of non-streaming `create()`. Resolves Opus 4.6 overload errors on non-streaming requests. Conflicting `top_p` parameter removed (Anthropic prohibits both `temperature` and `top_p`).
  - **Memory recall pre-fetch**: Brain daemon performs dual-pass memory retrieval (MEMORY.md + Firestore core_memory + session history) daemon-side, injecting results into temporal-memory's prompt for richer recall context.
  - **Introspect dedup**: `seenSkillIds` set in `agent-introspect.mjs` prevents reporting the same skill twice when it appears in both base and specialty manifest layers.
  - **Firebase SKILL.md accuracy**: Explicit valid Firebase CLI commands listed (e.g. `firebase hosting:sites:list`) with warnings against hallucinated commands (`firebase hosting:get-config` etc.) to prevent motor guess-and-check loops.
- **Episodic Memory Recall (v2026.06.20.6.0)**:
  - **Work ledger as first-class recall source**: `recallMemory()` in `agent-brain.mjs` queries 4 layers: (A) MEMORY.md, (B) core-memory query+recent, (C) 7-day recentWorkDigest, (D) cue-driven searchWork (30d/180d). Structured telemetry: `[TELEMETRY] recall_layers` with per-layer hit counts.
  - **Episodic retrieval module**: New `corekit/lib/work-recall.mjs` — pure ES module with `extractCues` (deterministic tokenizer), `scoreRelevance` (term overlap × recency × status/type weights), `searchWork` (Firestore cue-driven query + client-side scoring), `recentWorkDigest` (7d grouped markdown). 16 unit tests passing.
  - **Escalation contract**: temporal-memory can emit `{recall_escalate: true}` in Pass-1 to trigger one bounded deep pass (180d) for rare prior-work queries.
  - **Schema fixes**: `core-memory-read` `--query` flag now performs client-side filtering (Firestore has no substring search). `work-log-read` field names corrected to snake_case (`created_at`, `completed_at`, `output`).
  - **Canon alignment**: BRAIN_CANON.md B-15 extended — episodic recall is part of the recall tier, not a fourth memory layer (B-23 audit trail retrieval, B-5 preserved). memory-consolidate SKILL.md Step 3 (work ledger scan) added.
- **Processes vs Skills design principle**: Processes are for **orchestration** (when to do things, in what order, with what approvals). Skills are for **execution** (how to do a specific thing correctly every time). Processes should reference skills for mechanical steps. Anti-pattern: a process that tells motor to improvise deterministic operations without a skill providing the exact script. Six core processes defined: implement, review, audit, investigate, deploy-verify, release. Process steps support `intent: research` for read-only steps and `intent: execute` for modification steps. Sub-process composition via `sub_process` field (flattened into parent, circular ref protected).
- **Culture of Work primitives**: Eight primitives form the work hierarchy: **Task** (atomic execution), **Checkpoint** (task group), **Mission** (self-contained goal), **Project** (recursive organizer with context), **Process** (reusable template), **Plan** (unexecuted Mission blueprint: draft→approved→executing→complete), **Responsibility** (scheduled/event-triggered work), **Artifact** (files produced during Missions, auto-published to Google Drive). Every Mission requires `project_id` (defaults to `{agent-id}/general`). Missions support `depends_on` for dependency management (auto-activation on completion). Plans are created via `createPlan()`, approved via `approvePlan()`, and stamped into M→C→T envelopes via `stampPlan()`. Projects are recursive (max depth 4) with accumulated context (documentation, processes, team, configuration). Artifacts persist in Drive under `{root}/{project}/{prime}/{agent}/`; auto-shared with project owner; referenced in project context for cross-mission access.
- **Responsibility self-management**: Agents create responsibilities through normal M→C→T pipeline. `responsibility-manage` Motor tool for CRUD + toggle on `responsibilities-job.json`. Individual responsibilities can be toggled enabled/disabled via dashboard toggle switch, `responsibility-manage toggle` Motor tool, or `set_responsibility_enabled` introspection query. Cortex classifies responsibility requests as new_mission → Prefrontal designs process → Motor writes config → Cerebellum verifies. Brain scheduler fires responsibilities on cron schedules. Responsibilities can link to stored processes via `processRef` + `processParams` for deterministic execution.
- **Context assembly**: System prompt loads SOUL.md only. IDENTITY.md + MEMORY.md + full agent registry (cached, 60s TTL) provided as context. `assemble-persona` appends specialty-specific SOUL sections at bootstrap. Per-agent generation params: Motor 65536 max_tokens, Cortex/Prefrontal 32768, Cerebellum/Memory 8192. Temperature tuned per role (0.1–0.6). Envelope context accumulation: rolling 400K token budget with oldest-first pruning.
- **Input/Output architecture (ears + mouth)**:
  - `agent-ears.mjs` — 100% deterministic input (poll, dedup, rate-limit, fire-and-forget gateway POST)
  - `agent-mouth.mjs` — 1 LLM call (classify+format) + deterministic delivery
  - Legacy `message-daemon.mjs` and `channel-respond` are deleted

### Fleet VM Architecture
- Single neural gateway per VM with specialty-specific workspace (identity fragment + shared SOUL_PROTOCOL.md composed at bootstrap) + brain sub-agents
- Same `agent-ears.mjs` + `agent-mouth.mjs` + `agent-introspect.mjs` as Prime (CHANNEL=gchat) — built-in DWD, fire-and-forget input, strict LLM output classification
- Introspect daemon reads real VM filesystem (bin/, skills/, workspace/) and responds to Firestore queries from the dashboard
- CoreKit tools shared with Prime via manifest system

### I/O Architecture (Ears + Mouth)
- Ears polls channel (Firestore or GChat), deduplicates, repairs Chat-mangled text via Gemini Flash preprocessor (gated to messages >500 chars or multi-line — short direct mentions skip preprocessing), detects approval gate responses in GChat (intercepts approve/reject replies), writes TASK.json, fires gateway POST (non-blocking)
- **GChat context window**: when @mention detected, ears includes prior N messages (default 5) from the space as `[Chat messages since your last reply - for context]` preamble with sender names
- Mouth v2 tails JSONL session transcript (`/opt/corekit/corekit/brain/agents/{agentId}/sessions/{sessionId}.jsonl`) — structurally detects final responses vs intermediate tool output
- Turn state machine: IDLE → WORKING → ACKED → UPDATED → DONE
- Status updates: LLM-voiced ack at 5s, progress at 120s (deterministic fallback if LLM fails)
- LLM classify via Gemini Flash in JSON mode: `{"action": "deliver"|"suppress", "text": "..."}`
- Prompts loaded from external `.md` files (`mouth-classify-prompt.md`, `mouth-status-prompts.md`)
- Mouth also runs independent Brain v3 envelope poll (5s interval) — primary query on `delivery_status=pending`, skips `status=archived` as defense-in-depth
- Agents never call delivery tools directly — mouth handles all outbound
- Ears and mouth are fully independent systemd services — crash/restart of one doesn't affect the other
- **Dashboard**: Living Agent Graph home screen — interactive network topology with prime chip selector (deploy chip as last inline element), SVG connection lines + pulse dots, glassmorphic agent cards with text nav labels (Work/Brain/Skills, unified for Prime and Fleet). 18-route hierarchical navigation: Home → Prime Hub (/p/[id]) → Agent Deep Dive (/p/[id]/a/[agent]). Prime and Fleet agent pages share unified sidebar layout (240px fixed sidebar with avatar, name, email, status, specialty + vertical nav; tabs: Overview/Work/Brain/Skills/Fleet†/Projects/Plans/Processes/Responsibilities/Memory/Chat; responsive — sidebar hidden <768px with dropdown fallback). AgentWorkPanel component (shared by both pages): 4 sub-tabs (In Progress/Queue/Recent Work/Archived) with badge counts, WorkTree rendering, WorkDetail modal, paginated archived work with search (`/api/primes/[id]/work/archived`). FleetPanel component embedded inline in Prime's Fleet tab (agent cards + hire modal + upgrade/fire actions). ChatPanel with large lower-third input area (shift+enter for newlines). Breadcrumb trail in header (replaces flat nav). LiveIndicator component shows data freshness. BrainInspector component (extracted 700+ line model management UI). Settings page decomposed (General/Integration/Security/Secrets/System). 1health design system (Graphite/Charcoal/Teal/Aqua).
  - **Checkpoint Executor Dependency Injection Fix (v2026.06.18.4.3)**: Passed `buildProjectContext` dependency to `executeCheckpoints` in `agent-brain.mjs`, `process-engine.mjs`, and `checkpoint_plan.mjs` action to resolve daemon runtime crash loops (`ReferenceError: buildProjectContext is not defined`) when processing tasks with `project_id`.
  - **Upgrade Script Self-Overwrite Protection (v2026.06.18.4.2)**: Added a self-cloning pre-execution check to `upgrade-corekit` that copies the script to `/tmp/upgrade-corekit` and runs it from there, preventing shell offset corruption when the script file on disk is overwritten during upgrades.
  - **Command Runner & Manifest Fix (v2026.06.18.4.1)**: Fixed the command-runner crashloop and brain daemon startup failures on VM upgrade. Added the missing brain overhaul libraries and action handlers to the `base.txt` manifest, and updated `upgrade-corekit` to preserve/restore `GCP_PROJECT_ID` and `PRIME_ID` in the `command-runner.service` file upon package update.
  - **Skill Library Upgrade (v2026.06.18.4.0)**: Upgraded all 36 skills to meet or exceed Grade 3, with 5 workspace/fleet skills at Grade 5 (`workspace-drive`, `workspace-gmail`, `workspace-docs`, `fleet-fire`, `fleet-hire`) and 12 at Grade 4. Added procedures, error recovery tables, and worked examples where required. Validated skills integrity with 0 errors and 0 warnings under `validate-skills.mjs`.
  - **GitHub Coordinates & Version Upgrade Fix (v2026.06.18.3.3)**: Fixed Next.js route worker crashes by converting static module-level GitHub environment evaluations in `github.ts` into lazy runtime functions (`getGitHubOwner`, `getGitHubRepo`, `getGitHubRawBase`, `getGitHubApiBase`). Updated 8 API routes to use dynamic getters, and wrapped coordinates resolution in try/catch to return structured details instead of throwing unhandled 500 crashes. Added auto-detection from local git remote inside `install.sh` and propagated variables to Cloud Run env on deploy and upgrade.
  - **Final Gaps Decomposition (v2026.06.18.3.2)**: Decomposed the 986-line Processes routing page into subcomponents under `src/components/processes/` (types, StepEditor, ParamEditor, ProcessListView, ProcessDetailView, CreateProcessModal). Shared projects page components (`ProjectListView`, `ProjectDetailView`) by removing inline duplication in the 797-line global projects page. Extracted floating modals (deploy, delete confirmation, action required) from the 512-line Home page. Decoupled presentation mappings from the backend `brain-config` API route and defined maps on the client side.
  - **CI & Validation Fixes (v2026.06.18.3.1)**: Fixed syntax check failure due to a missing closing brace in `cascadeCancelChildren` inside `agent-brain.mjs`. Converted `validate-contracts` script to run relative to the repository root directory in `--repo` mode to prevent Node.js read path resolution errors on Windows. Fixed `read_contract` utility to robustly handle missing/undefined keys in `contracts.json`. Added `firebase-hosting-diagnostics` skill files to the `job-devops.txt` manifest.
  - **Second Audit Gap Resolution (v2026.06.18.3.0)**: Resolved all gaps from the second audit report. Fixed a potential crash site in `checkpoint-executor.mjs` by wrapping fallback accept_criteria description in `toStr()` (Gap 1), corrected `lib/github.ts` to fail closed in production runtime by throwing if vars are missing while allowing fallback coordinates for production build and local dev environment (Gap 3), and flipped `anthropic_prompt_caching` to `true` in `contracts.json` to activate system prompt caching for Claude models on Vertex AI (Gap 5). Passed all E2E tests and contracts validations with 100% success.
  - **Dashboard Audit Gaps Resolved (v2026.06.18.2.0)**: Resolved all remaining gaps from the Dashboard Upgrade audit. De-duplicated models scan routes into a unified `/api/models/scan?primeId=...` endpoint, deleting the legacy prime-scoped path. Decomposed the monolith 1066-line settings page into 5 clean tab components under `components/settings/`, restoring `DWDGuide` for the onboarding flow. Decomposed the 750-line projects page into modular subcomponents under `components/projects/`. Verified zero TypeScript compiler errors.
  - **Brain Overhaul Audit Implementation (v2026.06.18.1.0)**: Resolved all 7 critical/structural gaps from audit report. Wired motor failure detection check in `checkpoint-executor.mjs` (Gap 1), added `toStr` safety to task description and checkpoint instructions (Gap 2), unified state machine using exclusively `_swf_state` (Gap 3), wired `executeCheckpoints` into both `process-engine.mjs` and `agent-brain.mjs` (Gap 4), decomposed the remaining 4 large inline action blocks (`synthesize_with_failure`, `follow_process`, `delegate`, `checkpoint_plan`) into separate modules under `corekit/daemon/actions/` (Gap 5), wired prompt caching to read from `contracts.json` (Gap 6), and added `plan` schema to `CORTEX_SCHEMAS` in `vertex-text.mjs` to enforce schema validation on Prefrontal output (Gap 7).
  - **Dashboard Refactor (v2026.06.17.10)**: 6-phase overhaul for scalability and code cleanliness. Removed duplicate type declarations and consolidated types. Removed hardcoded owner/repo references with unified environment configuration fallback. Decomposed the home dashboard into modular components (`OnboardingFlow`, `PrimeGrid`, `FleetVisualization`, `HireModal`). Added `VerdictCard` and `InternalsPanel` for detailed cerebellum verification reporting and step-by-step processing introspection, aligned with the brain daemon's data structures. Added global APIs for approvals, telemetry (LLM token usage), and contracts. Unified MCP skill display with connection type, tool schema code blocks, and styled status badges.

### Skills / Body-Part Categorization
The Skills page categorizes tools by agent "body part". The introspect daemon (`agent-introspect.mjs`) assigns categories by filename pattern. When adding new tools, follow the naming conventions below so they auto-categorize correctly:

| Body Part | Icon | Pattern | What goes here |
|-----------|------|---------|----------------|
| **Ears** | 👂 | `agent-ears*`, `ears-*`, `chat-*`, `dwd-token`, `ws-token` | Input pipeline, polling, DWD auth, chat I/O |
| **Mouth** | 🗣️ | `agent-mouth*`, `mouth-*` | Output pipeline, response classification, delivery |
| **Brain** | 🧠 | `agent-brain*`, `brain-telemetry-*`, `assemble-persona`, `agent-introspect*` | Orchestration daemon, telemetry, persona assembly |
| **Cortex** | 🔮 | `web-search`, `agent-status` | Decision layer — reasoning tools the cortex agent uses |
| **Motor** | ⚡ | `responsibility-manage`, `project-manage`, `task-log-*`, `fleet-*`, `work-log-read`, `drive-*`, `gmail-*`, `calendar-*`, `docs-*`, `sheets-*` | Execution layer — all tools Motor uses to DO things |
| **Memory** | 💾 | `core-memory-*`, `update-deep-truths`, `session-summary` | Temporal-memory tools |
| **Config** | ⚙️ | `upgrade-*`, `validate-contracts`, `*.md`, `*.json`, `*.tmpl` | System config & base functions: brain/fleet infra |
| **Custom** | 🧩 | *(anything not matched above)* | Fallback for uncategorized / user-added tools |

Source of truth: categorization logic in `corekit/daemon/agent-introspect.mjs`, labels in `app/src/app/p/[id]/a/[agent]/skills/page.tsx`.

### Workspace Skill Manifests
Workspace tools (Google Drive/Gmail/Calendar/Docs/Sheets) are installed per job type, NOT globally. Manifest layering: `base.txt` → `role-{fleet|prime}.txt` → `job-{type}.txt`. Prime has ZERO workspace skills.

### Identity Lockdown
- `.identity-lock` file (chmod 444) written at bootstrap/upgrade with the agent's Workspace email
- `dwd-token` refuses to impersonate any email that doesn't match the lockfile
- `{{AGENT_USER_EMAIL}}` injected into IDENTITY.md templates at bootstrap/upgrade
- Task lifecycle records include agent email for full audit trail

### Agent State System (STATUS.json)
- `agent-status` tool reads/writes `workspace/STATUS.json` with current activity
- States: `idle → classifying → idle` (primary turn lifecycle via internal hooks)
- PreTurn hook sets `classifying`, PostTurn hook resets to `idle`
- Full cognitive execution state (claimed, active, waiting, complete, failed, needs_input) is managed dynamically by the `agent-brain` orchestrator daemon inside the Firestore `work` envelopes collection.

## Repository Structure
```
app/              Cloud Run dashboard (Next.js, 18 routes, 1health design system)
infra/            Bootstrap scripts, manifests, contracts.json
corekit/          Runtime tools installed on VMs (brain, fleet, gateway, chat, dashboard, memory)
brain/            Agent workspace files (SOUL.md, IDENTITY.md, MEMORY.md)
specialties/      Fleet agent specialty configs
skills/           Skill manifests
docs/             Architecture docs, Culture of Work primitives, authoring guides
```

## Development Discipline

### Versioning
- Version format: `v{YYYY}.{MM}.{DD}.{index}.{subindex}` (e.g. `v2026.04.28.1.0`)
- Every commit message: `v2026.04.28.1.0: description` (version it's building toward)
- Untagged commit = **unstable** (work in progress)
- `STABLE` tag = the single moving tag marking the last verified-good commit
- Dashboard always deploys from `main` HEAD; `STABLE` tag is a safety checkpoint
- CoreKit upgrade (`upgrade-corekit --apply main`) always pulls latest `main`
- To finalize a checkpoint: `/finalize-checkpoint` (updates docs + tags)

### Workflow
1. Edit → update manifests if adding files → update contracts.json if cross-cutting
2. `/update-git` — stage, commit (with version prefix), push
3. Dashboard upgrade button — deploys to VM
4. `/ssh-vm-access` — debug if needed
5. `/firestore-query` — verify state
6. `/finalize-checkpoint` when stable — updates docs, tags, pushes

### Mandatory Workflow Reference

**BEFORE performing any of these actions, you MUST open and follow the corresponding workflow file.** Do not ad-hoc commands from memory.

| Action | Workflow | When to use |
|--------|----------|-------------|
| SSH into any VM | `/ssh-vm-access` | Any debugging, inspection, or command execution on a running VM. Contains exact quoting patterns for `gcloud compute ssh` + `docker exec` that work in PowerShell. |
| Query Firestore | `/firestore-query` | Verifying daemon behavior, telemetry, task lifecycle, fleet status. Contains SSH-based credential path that works on GCE VMs. |
| Commit & push | `/update-git` | Staging, committing with version prefix, pushing. Contains tagging instructions. |
| Development flow | `/development-process` | Full checkpoint-driven dev cycle. Manifest-first, no-secrets discipline. |
| Finalize checkpoint | `/finalize-checkpoint` | After verifying a stable checkpoint. Updates MISSION_PLAN.md, README.md, project-context.md, then tags and pushes. |

### Key Paths on VM
- CoreKit root: `/opt/corekit`
- Config: `/opt/corekit/corekit/`
- CoreKit tools: `/opt/corekit/bin/`
- Workspace: `/opt/corekit/workspace/`

### Constraints
- No secrets in repo — runtime injection via env vars or GCP metadata
- Manifest-driven installs — `infra/manifests/` maps repo paths to VM destinations
- contracts.json — single source of truth for cross-cutting values
- Idempotent — every script safely re-runnable
- Public repo — curl-installable from `raw.githubusercontent.com`
