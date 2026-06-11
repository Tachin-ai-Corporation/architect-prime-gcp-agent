# Improvement Loop Plan — Product Architect, Engineer, and the Self-Iteration Cycle

> **Audited against:** current `main`
> **Target location in repo:** `docs/plans/IMPROVEMENT_LOOP_PLAN.md`
> **Status:** Draft for approval

---

## 0. Delta Analysis — What Exists vs. What's Needed

Verified against live `main` before planning. The delta is smaller than the request implies — most of the loop's machinery already exists on `main`.

### Exists on `main` — build on, do not rebuild

| Requested | Actual repo state |
|---|---|
| "Engineer fleet agent with github workflow skill" | ✅ **Exists.** `infra/manifests/job-engineer.txt` installs `specialties/engineer/` bundle: workspace (SOUL/IDENTITY/MEMORY), brain SOUL_APPENDs (cortex/motor/cerebellum), and two skills with full content: `git-ops` (branching, conventional commits, pre-commit checks, PR template, conflict resolution, safety rules) and `code-review`. |
| "project create and manage skill" | ✅ **Mostly exists.** `project-manage`, `process-manage`, `responsibility-manage`, `skill-author` are base-manifest tools on every agent. Plans (`createPlan→approvePlan→stampPlan`), recursive Projects, and `p-plan` process all live. What's missing is a *procedural SKILL.md layer* teaching the Architect to wield them (cheap). |
| Waiting/resume for delegated work | ✅ **Exists.** Parent envelope goes `waiting`; `checkWaitingEnvelopes()` polls `children`, and when all delegated children are `complete`/`failed`, resumes the parent with `[DELEGATION RESULTS]` injected as `context_forward`. **This works unchanged with GChat transport** because all agents in a prime share one `primes/{id}/work` collection — the receiver just has to register its mission ID into the parent's `children`. |
| Deploy code to a test agent | ✅ **Mechanism exists.** `install.sh --upgrade <ref>` + `upgrade-corekit` accept arbitrary git refs. Deploying a feature branch to a test agent = `upgrade-corekit` against the branch ref. No new deploy machinery needed. |
| Watch & QA the test agent | ✅ **Tools exist.** `agent-introspect` (Firestore bus), `work-log-read`, `task-log-read`, `brain-telemetry-read`, `fleet-verify`, `agent-status`. |
| Iteration loop trigger | ✅ **Responsibility scheduler exists.** Cron + `min_spacing_minutes` + `processRef` deterministic execution + `context.prior_learnings` for loop memory. |
| Resume-by-message hooks | ✅ **Exists.** `handleAttach` resumes `needs_input`/`waiting` envelopes from inbound messages with an `attach_to` target — the delegation-result path reuses this resolution machinery deterministically. |

### The actual delta — 6 workstreams

| # | Gap | Resolution (decided) |
|---|---|---|
| **G1** | **No way for agents to hold credentials.** GitHub (or anything else) requires secrets; paradigm forbids keys in git/VM images. | **Dashboard Secret Store** (Phase 1): human stores secrets from the dashboard → GCP Secret Manager; shares access with individual agents via per-secret IAM bindings on the agent's SA; agents read at runtime over ADC via a new `secret-read` tool. GitHub auth = a fine-grained PAT stored as secret `github-token`, granted only to engineer agents. |
| **G2** | **Git infrastructure is nonexistent.** No `.github/workflows/`, no CODEOWNERS, no branch protection, no tests, no PR template (probed: all 404). | Phase 0 git bootstrap. "All tests pass" is undefined without it; merging agent-authored code into the codebase that *runs the agents* without CI is the one unrecoverable failure mode. |
| **G3** | **No cross-VM delegation transport.** `callAgent()` only dispatches to *local* gateway sub-agents; `delegation` step type tags metadata but has no inter-agent wire. | **GChat @-delegation protocol** (Phase 2, decided): agents delegate via Google Chat @-mention carrying the parent envelope ref ID + human-readable summary. Deterministic marker parse in Ears/brain — no LLM in the protocol path. |
| **G4** | **No Product Architect specialty.** `agent-types.json` has 8 types; none is an architect. No canon document exists. | Phase 3. |
| **G5** | **No loop processes.** No `p-repo-improve` / `p-implement-verify` in `corekit/config/processes/`. | Phase 4. |
| **G6** | **Doc/code discrepancy:** `AUTHORING_RESPONSIBILITIES.md` advertises `on_merge`/`on_deploy` triggers; `agent-brain.mjs` only fires `on_complete`/`on_failure` (call sites L1721/L1794/L1819). | Loop does **not** depend on `on_merge` — it's a delegation-chained Mission. Fix docs in Phase 0; defer webhook→event plumbing. |

### Pre-flight consistency checks (Phase 0, cheap)

- **C1 — specialty resolution:** `agent-types.json` has id `swe` → workspace `engineer`; the manifest is `job-engineer.txt`. Verify hiring `engineer` resolves and `fleet-deploy` passes `--job engineer`. README references `job-swe.txt`, which exists on `main` as an alias manifest installing the same engineer workspace files.
- **C2 — fleet SA discoverability:** Secret Store grants need agent-email → service-account resolution. Verify `primes/{id}/fleet/{agent}` docs carry the SA (fleet-hire creates per-agent SAs and preserves them across fire/re-hire); if absent, add the field during hire.

---

## 1. Architecture of the Loop

One **continuous responsibility** on the Architect drives everything. No new daemons, no webhooks — the loop is a delegation-chained Mission, fully inside the existing R→M→C→T paradigm, with GChat as the inter-agent wire.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ARCHITECT (product-architect agent)                                │
│                                                                     │
│  r-repo-improvement (cron, daily)                                   │
│    └─ processRef: p-repo-improve                                    │
│        CP1  Audit (read-only)  — repo scan vs PRODUCT_CANON.md      │
│        CP2  Propose            — Plan primitive (draft), Drive doc  │
│        CP3  ⛔ Approval gate    — human approves improvement scope  │
│        CP4  Delegate via GChat DM ─────────────────┐                │
│             "@engineer-agent [DELEGATION ref:w-xxxx] …"  │           │
│             parent task → waiting                  │                │
│        CP5  Resume on [DELEGATION-RESULT];         │                │
│             verify vs canon, trigger rollout,      │                │
│             record prior_learnings                 │                │
└────────────────────────────────────────────────────┼────────────────┘
                                                     ▼ GChat (DWD)
┌─────────────────────────────────────────────────────────────────────┐
│  ENGINEER (engineer agent)                                          │
│  Ears parses marker deterministically → mission with                │
│  source_meta.delegation_ref → registers own mission ID into         │
│  parent.children → runs p-implement-verify:                         │
│    CP1  Branch + implement      — git-ops, secret-read github-token │
│    CP2  Pre-commit gates        — lint, contracts, unit tests       │
│    CP3  Test deploy             — upgrade-corekit <branch-ref>      │
│         on TEST AGENT ──────────────────────────┐                   │
│    CP4  Exercise + QA via GChat jobs,           │                   │
│         introspect, work-log-read, iterate ←────┤                   │
│    CP5  Open PR (CI green) + GChat reply:       │                   │
│         "@architect-agent [DELEGATION-RESULT ref:w-xxxx] …"│        │
└─────────────────────────────────────────────────┼───────────────────┘
                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TEST AGENT — EPHEMERAL, hired/fired per cycle by                   │
│  p-implement-verify. e2-medium (same as fleet). Lives on branch     │
│  refs, receives canned test missions via GChat, torn down after QA. │
│  Side effect by design: every cycle QAs the hire/fire/bootstrap     │
│  path against the changing repo. Never serves real work.            │
└─────────────────────────────────────────────────────────────────────┘

  Merge: human approves PR (CI green + CODEOWNERS review) ──► main
  Rollout: Architect CP5 triggers fleet-upgrade (existing skill)
  Loop: next r-repo-improvement firing carries prior_learnings forward
```

**Design decisions, locked:**

1. **GChat @-delegation with envelope refs.** Human-readable in the same channel humans already watch; ref ID makes the protocol machine-deterministic. **Resume stays on the Firestore `children` path** — the GChat `[DELEGATION-RESULT]` reply is the human-visible record and summary source, never the resume signal. Full spec in §4.
2. **Exactly-once delegation, three layers.** (a) **Scheduler singleton** — `"singleton": true` on a responsibility: the scheduler skips firing if any non-terminal mission with that `responsibility_id` exists (one improvement cycle at a time, regardless of cadence). (b) **Sender idempotency** — the delegation step checks the parent envelope's `children` before sending; if a delegation for this ref is already registered and non-terminal, it does not re-send. (c) **Receiver dedup** — before creating a mission, the receiver queries `work` for an existing non-terminal mission with `source_meta.delegation_ref == ref`; if found, it replies with a status pointer instead of spawning a duplicate. No identical delegations can queue.
3. **Sequential delegation, not events.** The Architect's Mission goes `waiting` at CP4 and resumes via the existing `checkWaitingEnvelopes()` path. `on_merge` is not used (G6).
4. **Two human gates initially.** (a) Approval gate before delegation; (b) PR merge — human review + CI required by branch protection. Gates loosen in Phase 6, never before.
5. **No-drift is structural, not behavioral.** `PRODUCT_CANON.md` (Architect's reference + cerebellum check) **+** CODEOWNERS **+** CI scope-check job failing PRs that touch files outside the approved improvement's declared scope. The persona reinforces; the structure enforces.
6. **Secrets via dashboard Secret Store.** Secret material lives only in GCP Secret Manager; Firestore holds metadata + grants; access is per-secret, per-agent IAM on the agent's SA; agents read over ADC. Cloud Run SA gets **project-level `secretmanager.admin`** (confirmed — single-tenant paradigm). Capability fencing by IAM, not by trust — the Architect is simply never granted `github-token`.
7. **Test agent is ephemeral cattle.** The test agent (e2-medium, same as fleet) is **hired at the start of each verification cycle and fired at the end** by `p-implement-verify`. Deliberate side effect: every improvement cycle regression-tests the hire/fire/bootstrap path against the current repo — free QA coverage of the fleet lifecycle while the repo is under continuous change. SA/IAM persist across cycles, so hire is ~10 min.
8. **Architect runs the contracts cortex default** (per `contracts.vertex.models.cortex`) — strongest model for the audit/judgment role. No per-agent override needed; the architect agent inherits `contracts.vertex.models.cortex`.

---

## 2. Phase 0 — Git Bootstrap (the blocker, ~1 session, human-executed)

Nothing else proceeds until this is green. (Chicken-and-egg: agents can't push the infra that lets agents push.)

| Artifact | Content |
|---|---|
| `.github/workflows/ci.yml` | Jobs: (1) **lint** — `node --check` over all `.mjs`, JSON parse over all manifests/configs/processes; (2) **contracts** — run `validate-contracts` against rendered samples; (3) **manifest-integrity** — every path referenced in `infra/manifests/*.txt` exists in the tree (kills the split-commit deployment-break class permanently); (4) **unit** — `node --test test/` over `corekit/lib/*` and `corekit/brain/*` pure functions; (5) **scope-check** — if PR body contains a `Scope:` glob block (emitted by p-implement-verify), fail on any changed file outside it. |
| `test/` | Seed minimal real tests: `json-repair`, `scheduler` cron-matching, `process-engine` parameter substitution + checkpoint grouping, `contracts` regex assertions. Meaningful smoke coverage of the deterministic spine, not coverage theater. |
| `.github/CODEOWNERS` | Default owner: the designated human maintainer team (e.g. `* @{org}/maintainers`); explicit human ownership of `/corekit/daemon/`, `/infra/contracts.json`, and `/.github/` (agents can never own CI or contracts). |
| Branch protection on `main` | Require: CI green, 1 CODEOWNERS review, linear history, no force push (matching the git-ops safety rules — now enforced). |
| `.github/pull_request_template.md` | Lift from git-ops SKILL.md template + mandatory `Scope:` block + `Test-Agent-Evidence:` section (mission IDs on the test agent). |
| Doc fixes | `AUTHORING_RESPONSIBILITIES.md`: mark `on_merge`/`on_deploy` **not yet implemented** (G6). |

**Exit criteria:** CI green on main; a manual test branch opens a PR; merge blocked until review + checks.

---

## 3. Phase 1 — Dashboard Secret Store (~1–2 sessions)

A general-purpose secrets capability; GitHub auth is merely its first consumer.

### 3.1 Storage model

| Layer | Holds | Never holds |
|---|---|---|
| **GCP Secret Manager** | Secret payloads, as secret `aps-secret-{name}`, latest version = current value | — |
| **Firestore** `config/secrets/{name}` | Metadata: `{ name, description, secretManagerName, created_at, created_by, grants: [{agent_email, service_account, granted_at, granted_by}] }` | **Secret values. Ever.** |

Cloud Run SA gains **project-level `roles/secretmanager.admin`** (acceptable in the self-hosted single-tenant paradigm; everything runs in the operator's own project). Grant/revoke = `secretAccessor` binding added/removed **on the individual secret resource** for the target agent's SA (Secret Manager supports resource-level IAM natively).

### 3.2 Dashboard + API

| Piece | Detail |
|---|---|
| Route | `settings/secrets` (global namespace — secrets aren't prime-scoped; the grants picker enumerates fleet agents across primes from `primes/*/fleet/*`). Uses the dashboard's existing design system, consistent with existing Settings. |
| `POST /api/secrets` | Create: writes Secret Manager secret + version, then Firestore metadata. Value is write-only — no API ever returns it. |
| `PUT /api/secrets/[name]` | Rotate: adds a new version (agents pick it up on next `secret-read`; no agent restart). |
| `DELETE /api/secrets/[name]` | Destroys the Secret Manager secret + removes metadata + (implicitly) all grants. |
| `POST /api/secrets/[name]/grants` | Body: `{ agent_email }` → resolve agent's SA from fleet doc (C2) → add IAM binding → append to `grants`. |
| `DELETE /api/secrets/[name]/grants/[email]` | Remove binding + metadata entry. |
| UI | List with grant chips per secret; create dialog (name, value, description); per-secret grants panel with agent toggle list. Value field is one-way (write/rotate only). |

### 3.3 Agent-side tool

- **`corekit/system/secret-read <name>`** — resolves `aps-secret-{name}`, calls Secret Manager `:access` REST with the VM metadata ADC token, prints payload to stdout. ~50 LOC, deterministic, zero LLM. Goes in **`base.txt`** — the tool is universal and inert without an IAM grant; access control lives entirely in IAM. Exit code distinguishes `PERMISSION_DENIED` (not granted) from `NOT_FOUND`.
- **TOOLS.md hygiene note** (base): secrets are used via command substitution (`$(secret-read x)`), never echoed into responses, transcripts, MEMORY.md, or Drive artifacts.
- **Introspect:** later nice-to-have — surface "granted secrets" per agent on the Agent Deep Dive page (names only). Not blocking.

### 3.4 GitHub auth as first consumer

1. Human creates a **fine-grained PAT** on the repo: Contents R/W, Pull Requests R/W. Stores it as secret `github-token` via the dashboard. Grants to engineer agents only (the engineer agent, and the test agent if test flows ever need it — default no).
2. `infra/contracts.json` gains a *non-secret* coordinates block: `"github": { "owner": "{org}", "repo": "{repo}", "tokenSecret": "github-token" }` (coordinates set per deployment — contracts.json remains the single source for them).
3. New engineer-manifest script **`gh-api`** — thin REST wrapper: `gh-api POST /repos/{o}/{r}/pulls -d @body.json`, reading coords from contracts and the token via `secret-read`. No `gh` CLI dependency.
4. **git-ops SKILL.md update** — auth section: per-command header injection, never persisted into `.git/config`:
   `git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$(secret-read github-token)" | base64 -w0)" push -u origin BRANCH`
   plus the rule: *tokens never land in remote URLs, files, or transcripts*. Rotation is a dashboard action; agents pick it up next read.

**Exit criteria:** secret created/granted/rotated/revoked via UI round-trips correctly; granted agent `secret-read` succeeds, ungranted agent gets `PERMISSION_DENIED`; engineer VM pushes a branch and opens a PR via `gh-api`.

---

## 4. Phase 2 — GChat @-Delegation Protocol (~1 session)

Agents delegate via GChat @-mention with the **parent envelope ref ID + human-readable summary**. Markers are parsed deterministically — the protocol path never touches an LLM (deterministic/LLM boundary holds).

### 4.1 Wire format

```
@engineer-agent [DELEGATION ref:w-1a2b3c from:architect-agent@domain proj:proj-self-improvement]
Implement manifest-dedup refactor per approved plan.
Proposal: <Drive link> · Scope: infra/manifests/** · Run process p-implement-verify.
Report back with PR URL + test-agent mission IDs.
```

```
@architect-agent [DELEGATION-RESULT ref:w-1a2b3c status:complete mission:w-9z8y7x]
PR #41 open, CI green: <url>. 2 QA iterations on the test agent; all 3 canned missions pass.
```

Ref always points at the **delegator's parent task envelope**. Human-readable body rides along for the humans in the space — the machine path only needs the bracket header.

### 4.2 Mechanics (per side)

| Side | Change | Where |
|---|---|---|
| **Sender (brain)** | Delegation steps stop calling `callAgent()` locally. New path: resolve target agent email by `specialty` from `primes/{id}/fleet/*`, compose marker message, send via `chat-send` (DWD, deterministic), set the task envelope `waiting`. New lib: `corekit/lib/delegation.mjs` (compose/parse both markers — one module, both directions, unit-tested in `test/`). | `agent-brain.mjs` delegation branch (~L2164) + new lib |
| **Receiver (ears/brain)** | Ears detects `[DELEGATION ref:…]` → flags intake `source_meta.delegation_ref`. Brain: marker present ⇒ **skip LLM classify**, deterministically create the Mission, then write back: append own mission ID to parent envelope's `children`, set `source_meta.delegated_from`. From here, the delegator's existing `checkWaitingEnvelopes()` works **unchanged**. | `agent-ears.mjs` preprocess + `processIntake()` early branch |
| **Receiver (completion)** | On mission complete/fail where `source_meta.delegation_ref` is set: Mouth (or brain post-complete hook) sends the `[DELEGATION-RESULT …]` reply via `chat-send`. Belt-and-braces: the Firestore `children` mechanism alone already resumes the delegator; the GChat result message is the human-visible record + carries the summary that becomes `[DELEGATION RESULTS]` context. | completion path ~L1720 |
| **Resume (delegator)** | No change — `checkWaitingEnvelopes()` already polls children across owners in the shared `work` collection and injects results. Optionally enrich: prefer the result-message summary over raw `output` truncation. | none required |

### 4.3 Guard rails — exactly-once delegation, human-readable chat

- **Receiver dedup (hard guarantee):** before creating a mission, query `work` for any non-terminal mission with `source_meta.delegation_ref == ref`. If found, do **not** spawn a duplicate — reply in-thread with a status pointer (`Already in progress: mission w-…, status: active`). Layered on the existing Ears `(ref, sender)` dedup window for fast-path suppression of literal re-sends.
- **Sender idempotency:** the delegation step inspects the parent envelope's `children` before composing the DM; a registered non-terminal delegation for this ref means no re-send. Re-send is permitted only when the prior child terminated `failed`.
- **Scheduler singleton (new, `corekit/lib/scheduler.mjs`):** responsibility schema gains optional `"singleton": true`. Before firing, the scheduler queries for any non-terminal mission carrying `source_meta.responsibility_id == id`; if one exists, it logs `singleton guard: cycle in progress, sleeping` and skips — the responsibility simply goes back to sleep until the next cron tick. This makes an hourly cadence safe: at most one improvement cycle alive at any moment, and therefore at most one delegation in any agent's queue from this loop.
- **Resume path:** Firestore `children` registration is the **sole** resume mechanism (the existing `checkWaitingEnvelopes()` path); the GChat `[DELEGATION-RESULT]` reply exists for human readability and as the summary source for `[DELEGATION RESULTS]` context — agents keep talking to each other in chat where humans can watch, but the machine never depends on parsing the reply to resume.
- **Ref validation:** receiver verifies the parent envelope exists and `delegated_to` matches its own specialty before accepting; otherwise treat as normal chat (LLM classify path).
- **Loop guard:** an agent never accepts a delegation whose ref chain includes one of its own envelopes (walk `source_meta.delegated_from` upward, max depth 3).
- **Docs:** new `docs/guides/DELEGATION_PROTOCOL.md` + update CULTURE_OF_WORK delegation section + add `singleton` to `AUTHORING_RESPONSIBILITIES.md` schema table.

**Exit criteria:** human watches architect → engineer round-trip on a trivial read-only task: DM sent, mission created on the engineer agent, parent `waiting`, child registered, completion reply posted, the architect agent resumes with results. All marker parse/compose covered in `test/`.

---

## 5. Phase 3 — Product Architect Specialty (~1 session)

All files land in one PR (manifest + files together — manifest discipline).

### 5.1 File set

```
specialties/product-architect/
├── workspace/{SOUL,IDENTITY,MEMORY}.md
├── brain/cortex/SOUL_APPEND.md          # architectural judgment + delegation discipline
├── brain/cerebellum/SOUL_APPEND.md      # drift detection against canon
├── skills/project-ops/{SKILL.md,skill.json}   # procedures over project-manage/process-manage/plan tools
├── skills/repo-audit/{SKILL.md,skill.json}    # read-only repo analysis playbook (raw-URL fetch patterns, focus rotation)
└── responsibilities-product-architect.json    # r-repo-improvement (enabled Phase 5)

infra/manifests/job-product-architect.txt
docs/PRODUCT_CANON.md      # invariants — the walls (reject filter)
docs/BRAIN_CANON.md        # what better looks like — the gradient (ranking filter)
```

### 5.2 The persona (SOUL.md core)

1. **Product comprehension** — keeper of what Architect Prime *is*: agent factory not orchestrator; the 8 primitives; the deterministic/LLM boundary; contract supremacy; 6-module layout. SOUL points at `PRODUCT_CANON.md` (the walls) and `BRAIN_CANON.md` (the gradient) as Deep-Truth-adjacent firmware, both re-read at the start of every audit.
2. **Drift sentinel** — explicit rejection criteria: any proposal that adds a primitive, moves logic the wrong way across the deterministic/LLM boundary, introduces shared infrastructure, puts secrets anywhere but the Secret Store, bypasses contracts.json, or expands an agent's privileges is **not an improvement regardless of benefit claimed**. Improvements are: efficiency, structure, logic clarity, cleanness — within the canon.
3. **Delegator, never implementer** — reads everything; writes only plans/docs/Drive artifacts. It cannot push code because it is never granted `github-token` (IAM-enforced, not persona-enforced). All code changes flow through GChat delegation to engineer specialty with explicit scope globs and acceptance criteria.

### 5.3 `docs/PRODUCT_CANON.md`

~2 pages, **normative and testable**: each principle as an invariant with a "violation looks like" example. CODEOWNERS-owned by human maintainers; agents propose canon changes via PR like any code. This is what the Architect's cerebellum SOUL_APPEND checks proposals against, and the seed for future CI canon-lint jobs.

### 5.4 `agent-types.json` entry

```json
{
  "id": "product-architect",
  "title": "Product Architect",
  "specialty": "Product canon stewardship, repo architecture audit, improvement planning, engineering delegation, drift prevention",
  "emailPattern": "architect-agent-{name}",
  "workspace": "product-architect",
  "skills": ["agent-ask", "workspace-drive", "workspace-docs"],
  "brain": true,
  "capabilities": { "cortex": ["read", "write", "edit", "exec", "process"], "deny": ["web-search", "browser"] }
}
```

`write/edit` retained (plans, MEMORY.md, Drive staging); code-push capability absent via Secret Store grants, not capability flags.

`install.sh` needs **zero functional changes** (no job whitelist — it curls `job-${JOB}.txt`); update only `--help` text and header comment.

**Exit criteria:** `install.sh --role fleet --job product-architect` renders clean on a scratch VM; `validate-contracts` passes; Agent Type Explorer shows the type; `fleet-hire --specialty product-architect` resolves.

---

## 6. Phase 4 — Loop Processes (~1 session)

Two new process definitions in `corekit/config/processes/`, added to `base.txt` in the same commit.

### 6.1 `p-repo-improve` (Architect-side)

| CP | Steps | Notes |
|---|---|---|
| CP1 | Audit (×2 steps, `intent: research`, ⚠️ READ-ONLY prefix) | Re-read PRODUCT_CANON.md + BRAIN_CANON.md; pull repo tree + targeted files via raw URLs (repo-audit skill); review `prior_learnings` + Core Memory; produce findings on `${focus_area}` ranked by the BRAIN_CANON Part IV rubric (axis, measure, protected-properties check) (param; default rotation: corekit/brain → corekit/lib → corekit/daemon → infra). |
| CP2 | Propose | Create a Plan primitive (draft) for the single highest-value improvement: scope globs, M→C→T blueprint for the Engineer, acceptance criteria, risk notes, and the rubric claim (which axis improves, by what measure, why determinism/idempotency/observability/testability are untouched). Full proposal doc to Drive (Artifacts). |
| CP3 | `approval_gate` | `approval_message`: "🏗️ Improvement proposed: ${title}. Scope: ${scope}. Approve to delegate to engineering." |
| CP4 | Delegation step — `type: "delegation"`, `specialty: "engineer"` | Brain sends the `[DELEGATION ref:…]` GChat DM (Phase 2 path) embedding proposal Drive link, scope globs, acceptance criteria, directive to run `p-implement-verify`, and the report-back contract (PR URL + test-agent mission IDs + QA summary). Parent → `waiting`. |
| CP5 | Review + close | Verify results against acceptance criteria and both canons (including the rubric claim); if PR merged, trigger `fleet-upgrade` rollout (behind a second small approval gate initially); `core-memory-write` learnings; update the responsibility's `prior_learnings` via `responsibility-manage`. |

### 6.2 `p-implement-verify` (Engineer-side)

| CP | Steps | Tools |
|---|---|---|
| CP1 | Clone/fetch repo into mission workspace; create `refactor/IMP-<id>-<slug>`; implement strictly inside scope globs | git-ops, `secret-read github-token` header injection |
| CP2 | Pre-commit gates: lint, JSON parse, `validate-contracts`, `node --test`, manifest-integrity — the same checks CI runs, locally, fail fast | git-ops pre-commit section |
| CP3 | **Provision test agent:** `fleet-hire <test-agent>` (engineer job; SA/IAM persist from prior cycles so ~10 min); push branch; `upgrade-corekit --ref refactor/IMP-…` on the test agent; `fleet-verify <test-agent>` until green. Each cycle therefore regression-tests hire + bootstrap against the live repo — intentional. | fleet-hire, existing upgrade path |
| CP4 | Exercise: send 3 canned test missions to the test agent via GChat DM (simple Q&A · `p-investigate` on a stub topic · memory write/read round-trip). QA via `work-log-read`, `task-log-read`, introspect. Fail → fix → repush → re-upgrade → repeat (max 3 iterations, then report blocked). | introspect bus, telemetry |
| CP5 | Open PR via `gh-api` (template auto-filled: Scope block, Test-Agent-Evidence mission IDs); confirm CI green; **teardown: `fleet-fire <test-agent>`** (regression-tests the fire path; on a `blocked` outcome, fire anyway — never leave a branch-ref agent standing); send `[DELEGATION-RESULT …]` reply (completes the loop → Architect resumes) | gh-api, fleet-fire, delegation lib |

**Canned test missions** live as `specialties/engineer/skills/test-fleet/` (SKILL.md with the three mission texts + expected-signal checklist) — versioned, not improvised per run.

**Exit criteria:** both processes load at brain startup, appear in Firestore + dashboard Processes page, pass the authoring checklist; `p-implement-verify` dry-runs end-to-end human-invoked on a trivial change.

---

## 7. Phase 5 — Hire, Wire, First Cycle (~1 session)

1. **Hire:** an engineer agent and a product-architect agent. **No standing test agent** — `p-implement-verify` hires/fires it per cycle. Grant `github-token` to the engineer agent only.
2. **Verify the protocol live:** human asks the architect agent to delegate a trivial read-only task → full round-trip per Phase 2 exit criteria, including duplicate-send suppression (re-send the same delegation DM manually; confirm the receiver replies with a status pointer instead of a second mission).
3. **Create project** `proj-self-improvement` via `project-manage` — persistent context spine + Drive artifact home; all cycles accumulate context there.
4. **Enable the responsibility** on the architect agent — hourly cadence, singleton-guarded:

```json
{
  "id": "r-repo-improvement",
  "name": "Continuous Repo Improvement",
  "schedule": "0 * * * *",
  "enabled": true,
  "singleton": true,
  "min_spacing_minutes": 55,
  "instruction": "Run one full repo improvement cycle: audit the agent codebase against PRODUCT_CANON.md and BRAIN_CANON.md for efficiency, structure, logic, and cleanness improvements; propose the single highest-value change; on approval, delegate implementation to engineering and verify the result.",
  "processRef": "p-repo-improve",
  "processParameters": { "focus_area": "" },
  "project_id": "proj-self-improvement",
  "trigger": null
}
```

   Fires every hour; if a cycle is already in flight (including parked at an approval gate or `waiting` on delegation), the singleton guard logs and goes back to sleep. Effective behavior: a new cycle starts within ≤1 h of the previous one fully closing.

5. **Seed cycle #1** with a known-good small target staged in project context (e.g., the duplicate `motor` workspace entries visible in `role-fleet.txt` today) — cycle #1 validates the pipeline, not the Architect's judgment.
6. **Run one full cycle** humans-watching: hourly fire → audit → proposal → approve → GChat delegation → branch → hire test agent → test-deploy branch ref → QA → PR → CI → human merge → test agent fired → result reply → architect agent resumes → learnings recorded → singleton releases → next hourly tick starts cycle #2.

**Exit criteria:** one merged PR authored end-to-end by the loop; full R→M→C→T + delegation chain visible in the Work Tree; `prior_learnings` updated.

---

## 8. Phase 6 — Hardening (ongoing)

- **Cadence:** after 3 clean cycles, raise scope ceiling (multi-file refactors); after 10, consider auto-approving CP3 for `docs/`-only and comment-only scopes (CI scope-check makes this safe). **PR merge stays human** until a Warden-equivalent exists — Forge territory, out of scope here.
- **Failure paths:** delegation failure resumes the Architect with `[FAILED]` context → CP5 records the learning and closes. The existing `on_failure` trigger (one of the two real events) can later attach a `p-investigate` post-mortem responsibility.
- **Metrics:** cycles run / PRs merged / iterations-per-PR / CI failure rate — derivable from envelopes + telemetry; dashboard surface later.
- **Forge convergence:** this loop *is* the minimal Forge cell (Architect ≈ Product Owner+Innovator, Engineer, test agent ≈ QA target). The promotion-ladder/Sentinel/Warden RSI design layers onto exactly this substrate — nothing here needs rework for it.

---

## 9. Commit Sequence (manifest discipline enforced)

| PR | Contents | Tag |
|---|---|---|
| 1 | CI workflow, tests, CODEOWNERS, PR template, branch protection, doc fixes (G6, C1) | `v….1.0` |
| 2 | Secret Store: dashboard route + API routes + Firestore metadata model + IAM grant logic; `secret-read` (base.txt); contracts `github` coords block | `.2.0` |
| 3 | `gh-api` + git-ops auth section (job-engineer manifest, same commit) | `.3.0` |
| 4 | Delegation protocol: `corekit/lib/delegation.mjs` + ears/brain changes + **scheduler `singleton` support** (`corekit/lib/scheduler.mjs`) + tests + `DELEGATION_PROTOCOL.md` (base.txt lib entry, same commit) | `.4.0` |
| 5 | Product Architect bundle + manifest + agent-types entry + PRODUCT_CANON.md | `.5.0` |
| 6 | `p-repo-improve`, `p-implement-verify`, `test-fleet` skill (base.txt entries, same commit) | `.6.0` |
| 7 | `responsibilities-product-architect.json` enabled + `proj-self-improvement` seed | `.7.0` |

Each PR: green CI before the next begins. Phases 5–6 are operational, not commits. PRs 2–7 are themselves candidates for the loop once it exists — but bootstrap them human-first.

---

## 10. Locked Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Secret Store IAM scope | **Project-level `secretmanager.admin`** for the Cloud Run SA. |
| 2 | Delegation resume transport | **Firestore `children` is the sole resume mechanism.** GChat `[DELEGATION-RESULT]` reply kept for human-readable agent-to-agent chat. Exactly-once enforced via three layers: scheduler singleton, sender idempotency, receiver dedup-by-ref (§4.3). |
| 3 | Architect model | **Contracts cortex default** (per `contracts.vertex.models.cortex`). No override; the architect agent inherits `contracts.vertex.models.cortex`. |
| 4 | Cadence | **Hourly** (`0 * * * *`), with `singleton: true` — if a cycle is in flight, the firing goes back to sleep. |
| 5 | Test agent | **e2-medium (fleet-standard), ephemeral** — hired/fired per cycle by `p-implement-verify`, deliberately exercising the hire/fire/bootstrap path on every iteration. |
