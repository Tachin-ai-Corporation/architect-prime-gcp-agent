# Dashboard Redesign Plan (v2)

**Repo:** `Tachin-ai-Corporation/architect-prime-gcp-agent`
**Baseline:** `v2026.06.06.4.0`
**Scope:** Route-based navigation, agent deep-dive, introspect expansion, Settings cleanup, Library namespace
**Design system:** 1health dark mode (preserved — Graphite/Charcoal, Network Teal/Signal Aqua, 8px grid, 16px radius cards)

---

## What's Wrong Today

The dashboard was built prime-outward with flat global pages. Every page (Brain, Skills, Work, Projects, Processes) uses a shared `FleetSelector` component with URL query params (`?prime=X&agent=Y`) to scope its content. This works but has real UX costs:

1. **No agent deep-dive.** Clicking an agent on the home page opens a chat panel. There's no way to inspect an agent's brain config, installed skills, memory, or responsibilities from a single place. The Brain page shows model slots and responsibilities, but only after you select a prime + agent via FleetSelector — and it's mixed in with the global model catalog.

2. **URL state is fragile.** Selection lives in query params. Navigating between pages requires every page to independently re-read `?prime=X&agent=Y`. Refreshing the page on `/work` loses your selection if the URL was shared without params. There's no shareable permalink like `/p/alpha/agent/stan/brain`.

3. **Breadcrumb exists but routes don't.** `Breadcrumb.tsx` handles `/p/[id]` and `/a/[agent]` patterns, but zero page routes exist under `/p/`. The breadcrumb is dead code — it renders on global pages where it has nothing useful to show.

4. **Model management is split.** The Brain page fetches live config from the VM via introspect AND serves as the model catalog scanner. The Settings/Models tab duplicates part of this. Neither is the canonical place for "what's running on this agent."

5. **Introspect is underexposed.** The introspect daemon on each VM already handles `skills`, `status`, `config`, `workspace`, `brain_config`, `set_model`, `responsibilities`, and `set_responsibility_enabled`. But the API route whitelist only allows 6 of 8 types. The dashboard only surfaces introspect data on the Brain page. Skills, memory, and responsibility data from the VM aren't shown anywhere else.

6. **Shell navigation is flat.** Seven top-level links (Home, Projects, Processes, Work, Brain, Skills, Agent Types) regardless of context. On a 50-agent deployment this is fine; but the lack of hierarchy means you can't bookmark "Stan's brain config" or "Alpha prime's work tree."

---

## Design Decisions

### Route-based scoping replaces query-param scoping

The core change: prime and agent selection moves from `?prime=X&agent=Y` to URL path segments. This gives every view a shareable, bookmarkable permalink.

**Route prefix:** `/p/[id]` (matches the existing Breadcrumb component's pattern). Agent routes nest under `/p/[id]/a/[agent]`.

**FleetSelector stays for cross-cutting pages.** The Library and Settings pages aren't scoped to a prime. FleetSelector continues to work there via query params. The new scoped pages read their prime/agent from the URL path.

### Existing pages migrate, not rewrite

Every current page has working data fetching, UI, and edge case handling. We move them into the new route tree and extract the prime/agent ID from the URL path instead of query params. No full rewrites — surgical edits to swap `useFleetSelection()` for `useParams()` where the URL provides the context.

### Introspect is the live data layer

All agent-specific views pull live data from the VM via the existing introspect bus (Firestore command → daemon polls → daemon writes result → dashboard reads result). No new transport needed. The API route whitelist gets expanded to match the daemon's full capability.

---

## New Information Architecture

### Route Hierarchy

```
/ ──────────────────────────────────────── Home
│                                          Prime cards, fleet network, deploy, hire.
│
├── /p/[id] ────────────────────────────── Prime Hub
│   │                                      Health banner, NavCards, fleet chip strip.
│   │
│   ├── /p/[id]/fleet ──────────────────── Fleet Overview
│   │                                      Agent cards with live status. Hire + fire.
│   │
│   ├── /p/[id]/work ───────────────────── Work Tree
│   │                                      R → M → C → T hierarchy, filterable by agent.
│   │                                      Project filter integrated (replaces /projects).
│   │
│   ├── /p/[id]/config ─────────────────── Prime Config
│   │                                      Brain defaults, gateway, dispatch settings.
│   │
│   ├── /p/[id]/chat ───────────────────── Prime Chat
│   │                                      Existing chat UI (unchanged).
│   │
│   └── /p/[id]/a/[agent] ─────────────── Agent Deep Dive  ← THE NEW PAGE
│       │                                  Tabbed: Overview | Brain | Skills |
│       │                                  Responsibilities | Memory | Work | Chat
│       │
│       └── (Tabs render inline, no sub-routes. URL hash for deep-linking.)
│
├── /library ───────────────────────────── Global Resource Library
│   ├── /library/skills ────────────────── Skill Kit Catalog (repo-sourced)
│   ├── /library/agent-types ───────────── Agent Type Explorer (RPG sheets)
│   └── /library/models ────────────────── Model Catalog + Vertex AI scan
│
└── /settings ──────────────────────────── Dashboard Settings
    ├── Integration ────────────────────── DWD, email domain, GCP project
    ├── Security ───────────────────────── Auth config
    └── System ─────────────────────────── Version, upgrade, contracts viewer
```

### Migration Map

| Current Route | Current Mechanism | New Route | New Mechanism |
|---|---|---|---|
| `/` Home | Local state | `/` Home | Unchanged — add agent card links to deep-dive |
| `/brain` | FleetSelector `?prime&agent` | `/p/[id]/a/[agent]` Brain tab | Path params from URL |
| `/skills` | FleetSelector `?prime` | `/library/skills` (catalog) + agent Skills tab (installed) | Split: catalog is global, installed is per-agent |
| `/agent-types` | Standalone fetch | `/library/agent-types` | Move, unchanged |
| `/work` | FleetSelector `?prime&agent` | `/p/[id]/work` | Path param `[id]`, optional `?agent=` filter |
| `/projects` | FleetSelector `?prime` | `/p/[id]/work` project filter | Merged into Work page as filter dropdown |
| `/processes` | FleetSelector `?prime` | `/p/[id]/a/[agent]` Responsibilities tab | Per-agent, processes become agent responsibilities |
| `/settings` (5 tabs) | Standalone | `/settings` (3 tabs) | Remove Models tab (→ Library). Remove General tab (merge into System). |

### Shell Navigation

Replace the flat `navItems` array in `Shell.tsx`:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [AP Logo]  Home / alpha / stan / Brain             [Library] [⚙] [Ops] │
└──────────────────────────────────────────────────────────────────────────┘
```

**Left:** Logo (home link) + Breadcrumb (already implemented — `Breadcrumb.tsx` handles `/p/[id]` and `/a/[agent]`)
**Right:** Library link, Settings gear, Operations badge (all existing)

The breadcrumb replaces the 7-link nav bar. On `/`, only "Home" shows. On `/p/alpha/a/stan`, it shows "Home › alpha › stan" with each segment clickable. The Breadcrumb component already handles this — it just needs routes to render on.

---

## Page Designs

### Home (`/`) — Surgical Edit

Keep the existing home page. Two changes:

1. **Agent card click → navigate** to `/p/{primeId}/a/{agentName}` instead of opening chat panel.
2. **Chat icon on card → opens chat panel** (existing slide-in behavior, triggered by a chat icon button instead of the card itself).

No other changes. The deploy flow, hire modal, network visualization, and SVG connection lines stay as-is.

### Prime Hub (`/p/[id]`) — New Page

Hub-and-spoke pattern using the existing `NavCard` component.

**Top section — Prime health banner:**
- Status indicator (online/offline/deploying), sourced from `primes/{id}` Firestore doc
- VM zone, uptime (from introspect `status` query to prime VM)
- Active work count (from work collection query)

**NavCard grid:**
- **Fleet** → `/p/[id]/fleet` — badge: agent count
- **Work** → `/p/[id]/work` — badge: active envelope count
- **Config** → `/p/[id]/config`
- **Chat** → `/p/[id]/chat`

**Fleet chip strip:** Horizontal scrollable row of `AgentChip` components (existing). Click navigates to `/p/[id]/a/[agent]`.

### Fleet Overview (`/p/[id]/fleet`) — Migrate Existing

Move the fleet section from the home page into its own page. Currently the home page renders fleet cards inline within the prime card — extract that into a dedicated page showing:

- Agent cards (name, status, specialty, email) with drill-through to agent deep-dive
- Hire button (existing modal)
- Fire button per agent (existing)
- Upgrade button per agent (existing)

Data source: `usePrime().sidebarFleet[primeId]` (already polled every 8s).

### Agent Deep Dive (`/p/[id]/a/[agent]`) — New Page

The core new addition. A single page with tabbed content. No sub-routes — tabs switch content, URL hash updates for deep-linking (`#brain`, `#skills`, etc.).

**Header** (always visible):
- Agent name (styled per convention — cold aqua for agents, warm amber for humans)
- Status badge, specialty tag, email address
- VM zone + uptime (from introspect `status`)
- Action buttons: Chat (opens slide-in), Restart, Upgrade

**Tabs:** Overview | Brain | Skills | Responsibilities | Memory | Work | Chat

#### Tab: Overview
- **Health card:** Gateway status, last heartbeat, latency, consecutive failures. Source: introspect `status`.
- **Identity card:** IDENTITY.md content from introspect `workspace` (which returns all workspace file contents). Read-only.
- **Activity feed:** Recent messages from `/api/primes/[id]/fleet/[agent]/messages` (last 10).

#### Tab: Brain
Migrated from the current `/brain` page, scoped to this agent. Key changes:

- **Current model:** Live from introspect `brain_config` → `default` field.
- **Sub-agent slots** (Prime only): Table of 6 sub-agents with their models. Each row has a model swap dropdown populated from `/api/primes/[id]/models` cache.
- **Daemon models:** Ears, Mouth, Brain daemon model assignments from `brain_config` → `daemonModels`.
- **SOUL.md viewer:** Live content from introspect `workspace`. Syntax-highlighted markdown. Read-only in dashboard.
- **Model swap saves** write through introspect `set_model` (existing flow from current Brain page).

This is NOT a rewrite of the Brain page. It's extracting the per-agent portion of the current Brain page (lines ~136–413 of `brain/page.tsx` — the `fetchLiveConfig` / `brain_config` introspect flow) into a reusable component.

#### Tab: Skills
Live skill inventory from introspect `skills`:

- Skill cards (name, version, category, description)
- Tool definitions per skill (what the LLM can call — name, description, parameter schema)
- "Compare with catalog" — highlight skills available in `/library/skills` but not installed on this agent

The introspect `skills` handler (`handleSkills()` in `agent-introspect.mjs`) already reads the local filesystem and returns skill manifests + tool definitions.

#### Tab: Responsibilities
Live responsibilities from introspect `responsibilities`:

- Responsibility cards: name, schedule (cron expression, humanized), enabled/disabled toggle
- For each responsibility, expand to show the full instruction text + process steps (the `context.process` array from `responsibilities.json`)
- Enable/disable toggle writes via introspect `set_responsibility_enabled`

**Requires:** API route whitelist expansion to include `responsibilities` and `set_responsibility_enabled` (Finding 6 from audit).

#### Tab: Memory
- **MEMORY.md content** from introspect `workspace` (workspace handler returns all workspace files including MEMORY.md)
- **Consolidation status:** Last run timestamp, next scheduled (derived from responsibilities cron)
- **Memory size:** Character count of MEMORY.md

#### Tab: Work
Filtered view of the prime's work tree. Same UI as `/p/[id]/work` but pre-filtered to `owner === agent`. Reuses the existing `WorkTree` and `WorkDetail` components.

#### Tab: Chat
The existing `ChatPanel` component rendered full-width inside the tab content area instead of as a slide-in panel. Source: `/api/primes/[id]/fleet/[agent]/messages`.

### Prime Config (`/p/[id]/config`) — New Page

Live config editor. Reads current values from the VM via introspect `brain_config` and `config`, presents as an editable form.

**Sections:**
- **Brain defaults:** Cortex model, cortex fallback, subagent model. Dropdowns from model scan cache.
- **Gateway:** Port, timeout, bind. Display-only (changing requires reboot).
- **Vertex:** Location, Anthropic location. Display-only.
- **Dispatch:** Poll interval, max iterations, stale cleanup hours. Editable.
- **Ears:** Poll intervals, preprocess model, dedup window. Editable.
- **Mouth:** LLM enabled, model, temperature, fallback. Editable.

Save writes to Firestore config → dispatches a `set_model` or future `set_config` introspect command → services restart with new config.

### Work Tree (`/p/[id]/work`) — Migrate Existing

Move `/work` page to `/p/[id]/work`. Read `[id]` from URL path instead of `?prime=` query param.

Enhancements over current:
- **Project filter integrated.** The current `/projects` page becomes a filter dropdown on the work page. No separate projects page needed.
- **Agent filter.** Dropdown pre-populated from fleet list. On agent deep-dive Work tab, this is pre-set to the agent name.

The existing `useWorkEnvelopes` hook, `WorkTree`, and `WorkDetail` components stay unchanged — they already accept `primeId` and `selectedAgent` as parameters.

### Library (`/library/...`) — New Namespace

Three pages under a shared layout:

#### `/library/skills` — Skill Kit Catalog
Migrated from current `/skills` page. No changes to data fetching (still uses `/api/skills` which fetches from GitHub). Display-only catalog of what's available in the repo.

#### `/library/agent-types` — Agent Type Explorer
Migrated from current `/agent-types` page. No changes.

#### `/library/models` — Model Catalog
Migrated from the Settings/Models tab. Shows:
- All Vertex AI models grouped by provider (existing UI from Settings)
- Availability status per model
- "Scan Now" button (triggers `/api/models/scan`)
- No assignment UI here — model assignment is on the agent Brain tab

### Settings — Streamline to 3 Tabs

Remove Models tab (→ `/library/models`). Merge General tab content into System or Integration as appropriate.

**Integration tab:** DWD config, DWD test, email domain, GCP project info. (Existing `IntegrationTab.tsx` unchanged.)

**Security tab:** Auth configuration. (Existing inline security section.)

**System tab:** Current version + update check, upgrade button, contracts.json viewer (read-only formatted JSON), environment info.

---

## API Changes

### Expand Introspect Whitelist (Required)

In `app/src/app/api/primes/[id]/fleet/[agent]/introspect/route.ts`:

```diff
- const VALID_TYPES = ["skills", "status", "config", "workspace", "brain_config", "set_model"];
+ const VALID_TYPES = ["skills", "status", "config", "workspace", "brain_config", "set_model", "responsibilities", "set_responsibility_enabled"];
```

No new API routes needed. The existing introspect pattern (POST to submit, GET to poll) handles all query types. The daemon already supports both commands.

### Add Agent Filter to Work API (Enhancement)

In `/api/primes/[id]/work/route.ts`, add optional `?agent=` query param to filter envelopes by `owner` field. Currently the client fetches all envelopes and filters in the browser — this should move server-side for large deployments.

### No New Routes for Agent Deep-Dive

The agent deep-dive page uses existing APIs:
- **Overview/Brain/Skills/Responsibilities/Memory:** All via `/api/primes/[id]/fleet/[agent]/introspect` (already exists)
- **Work:** Via `/api/primes/[id]/work` with agent filter
- **Chat:** Via `/api/primes/[id]/fleet/[agent]/messages` (already exists)
- **Models:** Via `/api/primes/[id]/models` (already exists)

---

## Component Architecture

### New Components

| Component | Purpose | Size Estimate |
|---|---|---|
| `AgentPage.tsx` | Agent deep-dive tabbed page | Large — shell + tab router |
| `AgentHeader.tsx` | Agent name + status + specialty + actions | Small — display only |
| `AgentTabs.tsx` | Hash-based tab switcher | Small — generic |
| `BrainInspector.tsx` | Per-agent brain config viewer + model swap | Medium — extracted from Brain page |
| `SkillInventory.tsx` | Installed skill cards + tool definitions | Medium |
| `ResponsibilityList.tsx` | Responsibility cards with enable/disable | Medium |
| `MemoryViewer.tsx` | Markdown content viewer (MEMORY.md, SOUL.md) | Small |
| `ConfigEditor.tsx` | Form-based config editor for prime config | Medium |
| `PrimeHub.tsx` | Prime hub page with NavCards | Small |
| `LiveIndicator.tsx` | Freshness indicator for introspect data | Tiny |

### Modified Components

| Component | Change |
|---|---|
| `Shell.tsx` | Replace `navItems` flat nav with Breadcrumb. Keep right-side icons (ops, settings, version). Add Library link. |
| `Breadcrumb.tsx` | Already handles `/p/[id]` and `/a/[agent]`. No changes needed — it starts rendering useful content once routes exist. |
| `NavCard.tsx` | Add optional `status` prop for health indicators. No structural change. |
| `ChatPanel.tsx` | Add a `fullWidth` prop so it can render inside a tab (agent deep-dive) vs. as a slide-in panel (home page). |
| `FleetSelector.tsx` | Keep for Library pages. On scoped pages (`/p/[id]/...`), prime/agent come from URL params instead. |

### Retired Pages (After Migration)

| Current Path | Replacement |
|---|---|
| `app/src/app/brain/page.tsx` | `/p/[id]/a/[agent]` Brain tab + `/library/models` |
| `app/src/app/skills/page.tsx` | `/library/skills` + agent Skills tab |
| `app/src/app/agent-types/page.tsx` | `/library/agent-types` |
| `app/src/app/work/page.tsx` | `/p/[id]/work` |
| `app/src/app/projects/page.tsx` | `/p/[id]/work` project filter |
| `app/src/app/processes/page.tsx` | `/p/[id]/a/[agent]` Responsibilities tab |

Don't delete these until all functionality is confirmed working in the new locations. During migration, add redirects from old paths to new.

---

## File System Route Map

```
app/src/app/
├── page.tsx                              → /                         Home (existing, minor edits)
├── p/
│   └── [id]/
│       ├── page.tsx                      → /p/{id}                   Prime Hub (new)
│       ├── fleet/page.tsx                → /p/{id}/fleet             Fleet Overview (new, extracted from home)
│       ├── work/page.tsx                 → /p/{id}/work              Work Tree (migrated from /work)
│       ├── config/page.tsx               → /p/{id}/config            Prime Config (new)
│       ├── chat/page.tsx                 → /p/{id}/chat              Prime Chat (migrated from home chat panel)
│       └── a/
│           └── [agent]/
│               └── page.tsx              → /p/{id}/a/{agent}         Agent Deep Dive (new)
├── library/
│   ├── page.tsx                          → /library                  Library Hub (new, minimal)
│   ├── skills/page.tsx                   → /library/skills           Skill Catalog (migrated from /skills)
│   ├── agent-types/page.tsx              → /library/agent-types      Agent Types (migrated from /agent-types)
│   └── models/page.tsx                   → /library/models           Model Catalog (migrated from Settings/Models)
├── settings/page.tsx                     → /settings                 Settings (existing, streamlined)
└── api/
    ├── primes/
    │   ├── route.ts                      (existing)
    │   └── [id]/
    │       ├── fleet/
    │       │   ├── route.ts              (existing)
    │       │   └── [agent]/
    │       │       ├── introspect/route.ts  (existing — expand whitelist)
    │       │       └── messages/route.ts    (existing)
    │       ├── messages/route.ts         (existing)
    │       ├── deploy/route.ts           (existing)
    │       ├── work/
    │       │   ├── route.ts              (existing — add ?agent= filter)
    │       │   └── [workId]/respond/route.ts  (existing)
    │       ├── ops/route.ts              (existing)
    │       ├── projects/route.ts         (existing)
    │       ├── processes/route.ts        (existing)
    │       ├── commands/route.ts         (existing)
    │       └── models/route.ts           (existing)
    ├── models/scan/route.ts              (existing)
    ├── agent-types/
    │   ├── route.ts                      (existing)
    │   └── details/route.ts              (existing)
    ├── skills/route.ts                   (existing)
    ├── setup/route.ts                    (existing)
    └── upgrade/route.ts                  (existing)
```

---

## Execution Plan

### Phase 1 — Foundation (Shell + Route Tree + Context)

**Goal:** Breadcrumb-based navigation works. New route directories exist with placeholder pages. Old pages still function.

1. **Create route directories:** `app/src/app/p/[id]/`, `app/src/app/p/[id]/a/[agent]/`, `app/src/app/library/`
2. **Shell.tsx:** Replace `navItems` flat nav with `<Breadcrumb />` (already imported in breadcrumb component). Add Library link to right side.
3. **Prime Hub placeholder:** `p/[id]/page.tsx` — NavCard grid linking to fleet/work/config/chat.
4. **Agent Deep Dive placeholder:** `p/[id]/a/[agent]/page.tsx` — tabbed shell with placeholder content per tab.
5. **Library Hub:** `/library/page.tsx` with NavCards to skills/agent-types/models.
6. **Home page edit:** Agent card click → navigate to `/p/{primeId}/a/{agentName}`. Chat icon → opens ChatPanel slide-in.
7. **Test:** Breadcrumb renders correctly at every route level. Navigation between pages works.

**Estimated effort:** 2–3 sessions. No data layer changes.

### Phase 2 — Agent Deep Dive (Core New Feature)

**Goal:** The agent page shows live data for all 7 tabs.

8. **Expand introspect API whitelist** to include `responsibilities` and `set_responsibility_enabled`.
9. **Build `BrainInspector.tsx`:** Extract the `fetchLiveConfig` + model slot UI + model swap flow from `brain/page.tsx` into a reusable component. This is the highest-risk extraction — the Brain page is ~600 lines with interleaved state.
10. **Build Overview tab:** Introspect `status` for health, introspect `workspace` for IDENTITY.md, `/fleet/[agent]/messages` for activity feed.
11. **Build Brain tab:** `BrainInspector` component + SOUL.md viewer from introspect `workspace`.
12. **Build Skills tab:** Introspect `skills` → SkillInventory component. Compare against `/api/skills` catalog.
13. **Build Responsibilities tab:** Introspect `responsibilities` → ResponsibilityList component with enable/disable toggles via `set_responsibility_enabled`.
14. **Build Memory tab:** Introspect `workspace` → MEMORY.md viewer + consolidation schedule from responsibilities data.
15. **Build Work tab:** Reuse `WorkTree` + `WorkDetail` with `owner` filter pre-set to agent name.
16. **Build Chat tab:** `ChatPanel` with `fullWidth` prop, sourced from `/fleet/[agent]/messages`.
17. **Test:** Every tab loads live data from a running agent VM. Model swap works end-to-end.

**Estimated effort:** 4–6 sessions. The `BrainInspector` extraction (step 9) is the riskiest piece.

### Phase 3 — Page Migrations

**Goal:** Global pages moved into scoped routes. Old paths redirect.

18. **Migrate `/work` → `/p/[id]/work`:** Swap `useFleetSelection()` for `useParams()`. Integrate project filter dropdown (replace standalone `/projects` page).
19. **Migrate `/skills` → `/library/skills`:** Remove FleetSelector dependency. Pure catalog view.
20. **Migrate `/agent-types` → `/library/agent-types`:** Move directory, update imports.
21. **Migrate Settings/Models tab → `/library/models`:** Extract model scan UI into standalone page.
22. **Build `/p/[id]/config`:** ConfigEditor form backed by introspect `brain_config` + `config`.
23. **Build `/p/[id]/fleet`:** Extract fleet grid from home page into dedicated page.
24. **Streamline Settings:** Remove Models tab, merge General into System.
25. **Add redirects:** `/brain` → `/`, `/skills` → `/library/skills`, `/agent-types` → `/library/agent-types`, `/work` → `/`, `/projects` → `/`, `/processes` → `/`.
26. **Test:** All old URLs redirect correctly. No broken links.

**Estimated effort:** 3–4 sessions. Mostly surgical routing changes.

### Phase 4 — Polish

27. **LiveIndicator component:** Show data freshness ("Updated 3s ago" / "Stale — agent offline").
28. **Loading skeletons:** For introspect data across all agent tabs.
29. **Error states:** Offline agents, failed introspect queries, timeout handling.
30. **Responsive layout:** Mobile breakpoints for agent page tabs.
31. **Update README.md:** Correct page count, endpoint count, route descriptions, brain model table.
32. **Delete retired pages:** Remove old `/brain`, `/skills`, `/agent-types`, `/work`, `/projects`, `/processes` page files once redirects have been in place for one release cycle.
33. **End-to-end testing:** Deploy to staging, verify with a live prime + fleet agent.

**Estimated effort:** 2–3 sessions.

---

## Risk Notes

**BrainInspector extraction is the hardest piece.** The current Brain page (`brain/page.tsx`) is a monolithic ~600 line component with interleaved state for: model catalog fetching, live config introspect polling, model swap submission, responsibility toggling, and UI rendering. Extracting the per-agent portion into a reusable `BrainInspector` without breaking the existing flow requires careful state boundary work. Plan to keep the old Brain page functional during extraction and only retire it after the agent Brain tab is confirmed working.

**FleetSelector deprecation is gradual.** Pages under `/p/[id]/...` read their prime from the URL. But the Library pages and any cross-cutting views still need FleetSelector. Don't rip it out — let it atrophy naturally as pages migrate to route-based scoping.

**Introspect latency.** The Firestore bus pattern (write command → daemon polls every 5s → writes result → dashboard polls for result) has ~10-15s latency for a round trip. Every tab on the agent deep-dive that loads introspect data needs a loading skeleton and a "stale" indicator. Consider batching: one `brain_config` call returns model config + responsibilities + daemon models — reuse that response across Brain + Responsibilities tabs instead of making separate introspect calls.
