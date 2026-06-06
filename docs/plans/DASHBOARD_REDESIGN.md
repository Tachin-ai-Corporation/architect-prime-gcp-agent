# Dashboard Redesign Plan

**Repo:** `Tachin-ai-Corporation/architect-prime-gcp-agent`
**Scope:** Full navigation restructure, agent-centric drill-down, live VM introspection, Settings cleanup
**Design system:** 1health dark mode (preserved — Graphite/Charcoal, Network Teal/Signal Aqua, 8px grid, 16px radius cards)

---

## What's Wrong Today

The current dashboard was built prime-outward: you deploy a prime, see its fleet, and manage global pages (Brain, Skills, Work). But the agent is the unit of work, and you can't inspect one. Clicking an agent gives you a chat panel — not its brain config, not its installed skills, not its running model, not its responsibilities.

Specific issues:

1. **Flat navigation.** Brain, Skills, Work, Processes, Projects are global pages unscoped to any prime or agent. You can't look at "motor's installed skills" or "stan's active work."
2. **No agent deep-dive.** The fleet view shows name/status/specialty as a card, with no drill-through to the agent's internals.
3. **Brain page is global model management.** Model scan + swap UI, but not a per-agent brain inspector showing what's actually running on the VM.
4. **Settings has hardcoded structure.** Five tabs (General, Integration, Security, Models, System) with the model catalog duplicated between Settings/Models and the Brain page.
5. **No live introspection.** The introspect daemon on each VM can report installed tools, running model, SOUL.md contents, and responsibilities — but the dashboard doesn't surface this except for model swap.
6. **Stale model table in README.** Cortex shows `gemini-3.1-pro-preview` but it's actually Claude Opus 4.6 per contracts. The dashboard should be the single source of truth for "what's actually running" — not a README table.

---

## New Information Architecture

### Navigation Hierarchy

```
/ ─────────────────────────────────────── Home
│                                         Prime cards, deploy, hire. Visual topology.
│
├── /prime/{id} ──────────────────────── Prime Hub
│   │                                    Health summary, fleet grid, prime defaults.
│   │
│   ├── /prime/{id}/fleet ────────────── Fleet Overview
│   │                                    Agent cards with live status. Hire + fire.
│   │
│   ├── /prime/{id}/work ─────────────── Work Tree
│   │                                    R → M → C → T hierarchy, filterable by agent.
│   │
│   ├── /prime/{id}/config ───────────── Prime Config
│   │                                    Brain defaults, gateway, vertex settings.
│   │                                    Editable. Writes to Firestore → pushed to VM.
│   │
│   └── /prime/{id}/chat ─────────────── Prime Chat
│                                         Existing chat UI (keep as-is).
│
├── /prime/{id}/agent/{name} ─────────── Agent Deep Dive
│   │                                    The core new addition.
│   │
│   ├── Overview tab ──────────────────  Status, specialty, VM, email, uptime, health.
│   │                                    Pulled live from introspect daemon.
│   │
│   ├── Brain tab ─────────────────────  Per-agent model config (live from VM).
│   │   ├── Running model (with swap UI)
│   │   ├── Sub-agents (for Prime: cortex, prefrontal, motor, cerebellum, temporal-*)
│   │   ├── SOUL.md viewer (live content from VM)
│   │   └── IDENTITY.md viewer
│   │
│   ├── Skills tab ────────────────────  Installed skills inventory (live from VM).
│   │   ├── Skill cards (name, description, version)
│   │   ├── Tool definitions (what the LLM can call)
│   │   └── SKILL.md viewer per skill
│   │
│   ├── Responsibilities tab ──────────  R/M/C/T duties (live from VM).
│   │   ├── Active responsibilities (with cron schedules)
│   │   ├── Mission/checkpoint tree
│   │   └── Enable/disable toggles (writes back to VM)
│   │
│   ├── Memory tab ────────────────────  Core + working memory (live from VM).
│   │   ├── MEMORY.md content viewer
│   │   └── Memory consolidation status
│   │
│   ├── Work tab ──────────────────────  Work envelopes assigned to this agent.
│   │   └── Filtered view of the prime's work tree.
│   │
│   └── Chat tab ──────────────────────  Direct chat with this agent.
│                                         Existing per-agent chat (keep as-is).
│
├── /library ─────────────────────────── Global Resource Library
│   ├── /library/skills ───────────────  Skill Kit catalog (repo-sourced)
│   ├── /library/agent-types ──────────  Agent Type explorer (RPG sheets)
│   └── /library/models ──────────────  Model catalog + Vertex AI availability
│
└── /settings ────────────────────────── Dashboard Settings
    ├── Integration ───────────────────  DWD, email domain, GCP project
    ├── Security ──────────────────────  Auth config
    └── System ────────────────────────  Version, upgrade, contracts viewer
```

### What Changed

| Current | New | Why |
|---|---|---|
| `/brain` (global) | `/prime/{id}/agent/{name}` Brain tab | Brain config is per-agent, not global |
| `/skills` (global) | `/library/skills` + per-agent Skills tab | Catalog is global, installed skills are per-agent |
| `/agent-types` (global) | `/library/agent-types` | Moved under Library namespace |
| `/work` (global) | `/prime/{id}/work` (filterable) | Work belongs to a prime, filterable by agent |
| `/projects` (global) | `/prime/{id}/work` (project filter) | Projects are metadata on work envelopes |
| `/processes` (global) | `/prime/{id}/agent/{name}` Responsibilities tab | Processes = responsibilities = per-agent |
| Settings/Models tab | `/library/models` | Model catalog is a reference, not a setting |
| No agent page | `/prime/{id}/agent/{name}` | Core new page |

### Shell Navigation (Top Bar)

Replace the current flat nav with a contextual breadcrumb + global shortcuts:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [AP Logo]  Home / alpha / Agent-Stan / Brain    [Library] [⚙] [Ops(2)] │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left:** Logo + breadcrumb (clickable at each level: Home → Prime → Agent → Tab)
- **Center:** Empty (clean)
- **Right:** Library link, Settings gear, Operations badge

The breadcrumb replaces the flat nav links. Context-aware: on the home page, just "Home". On an agent page, "Home / alpha / Agent-Stan / Brain". Each segment is clickable.

---

## Page Designs

### P1. Home (`/`)

**Keep most of what exists** — the prime cards with fleet agent network visualization. Improvements:

- Each agent card in the network view becomes a **link** to `/prime/{id}/agent/{name}` instead of just opening chat.
- Add a small "inspect" icon on hover that navigates to the agent deep-dive.
- Chat panel still slides in from the right (keep as-is) but is triggered by a chat icon, not the card click.
- Card click = navigate to agent. Chat icon = open chat panel.

### P2. Prime Hub (`/prime/{id}`)

Hub-and-spoke pattern with NavCards (existing component). Shows:

**Top section — Prime health banner:**
- Status indicator (online/offline/deploying)
- Uptime, last heartbeat, VM zone
- Brain gateway health (from introspect)
- Active work count

**NavCard grid:**
- **Fleet** → `/prime/{id}/fleet` — badge: agent count
- **Work** → `/prime/{id}/work` — badge: active envelope count
- **Config** → `/prime/{id}/config`
- **Chat** → `/prime/{id}/chat`

**Fleet preview:** Horizontal scrollable strip of agent chips (name + status dot). Click → agent deep-dive.

### P3. Agent Deep Dive (`/prime/{id}/agent/{name}`)

**The core new page.** Tabbed interface inside a single page (no sub-routes — tabs switch content, URL hash updates for deep-linking).

**Header:**
- Agent name (styled per convention: `Agent-{Name}` in cold aqua)
- Status badge (online/offline/deploying)
- Specialty tag
- Email address
- VM zone + uptime
- Action buttons: Chat, Restart, Upgrade

**Tabs:** Overview | Brain | Skills | Responsibilities | Memory | Work | Chat

#### Tab: Overview
- **Health card:** Gateway status, last heartbeat, latency, consecutive failures
- **Identity card:** IDENTITY.md content (live from VM via introspect)
- **Activity feed:** Recent messages/tool calls (last 10)

#### Tab: Brain
**Live model config** pulled from the introspect daemon:

- **Current model** — What's actually running (e.g., `vertex-anthropic/claude-opus-4-6`)
- **Fallback model** — What it falls back to
- **Sub-agents** (Prime only) — Table of all 6 sub-agents with their models. Each row has a model swap dropdown.
- **SOUL.md viewer** — Syntax-highlighted markdown, live from VM. Read-only in the dashboard (editable on VM).
- **Context budget** — Token budget from contracts, current usage estimate

**Model swap UI:** Reuse the existing Brain page's model picker but scoped to this agent. Available models come from the `/api/models/scan` cache. Saving writes through introspect → agent config.json → brain gateway reload.

#### Tab: Skills
**Live skill inventory** pulled from introspect daemon:

- **Installed skills grid** — Cards showing skill name, version, category, description
- **Click to expand** → shows SKILL.md content and tool definitions
- **Tool list** — For each skill, what tools does the brain's tool registry expose? Name, description, parameter schema.
- **Compare with library** — Highlight skills that are available in `/library/skills` but not installed on this agent

#### Tab: Responsibilities
**Live responsibilities** pulled from VM's `responsibilities.json`:

- **Responsibility cards** — Name, schedule (cron expression humanized), enabled/disabled toggle
- **Mission tree** — For each responsibility, expand to see active Missions → Checkpoints → Tasks
- **Enable/disable** — Toggle writes back to VM via introspect command
- **Add responsibility** — Button opens a form to add a new R with schedule

#### Tab: Memory
- **Core Memory** — MEMORY.md content viewer (live from VM)
- **Consolidation status** — When was last consolidation? Next scheduled?
- **Memory size** — Character/token count

#### Tab: Work
- Filtered view of the prime's work tree showing only envelopes where `owner === agentName`
- Same R → M → C → T tree UI as the prime work page, but pre-filtered

#### Tab: Chat
- Existing per-agent chat panel, rendered full-width inside the tab instead of as a slide-in panel

### P4. Prime Config (`/prime/{id}/config`)

**Live config editor.** Reads the current `contracts.json` values from the VM via introspect, presents them as an editable form, and writes changes back.

Sections:
- **Brain defaults** — Cortex model, cortex fallback, subagent model. Dropdowns populated from model scan cache.
- **Gateway** — Port, timeout, bind. Display-only (changing these requires reboot).
- **Vertex** — Location, Anthropic location. Display-only.
- **Dispatch** — Poll interval, max iterations, stale cleanup hours. Editable.
- **Ears** — Poll intervals, preprocess model, dedup window. Editable.
- **Mouth** — LLM enabled, model, temperature, fallback. Editable.

Save button writes to Firestore → triggers a config push to the VM → brain restarts with new config.

### P5. Work Tree (`/prime/{id}/work`)

**R/M/C/T hierarchy visualization.** This already exists but should be improved:

- **Tree view** with expand/collapse. R at the top, M nested, C nested within M, T as leaves.
- **Color coding** by status (active=teal, complete=green, failed=red, waiting=amber, needs_input=purple)
- **Agent filter** — Dropdown to show only work owned by a specific agent
- **Project filter** — Dropdown to filter by project
- **Click any node** → expands to show detail (instruction, accept criteria, output, history)
- **Human-in-the-loop** — For `needs_input` envelopes, show the response form inline

### P6. Library (`/library/...`)

Three sub-pages under a shared `/library` layout:

#### `/library/skills` — Skill Kit Catalog
What's available in the repo (sourced from GitHub, cached 5 min):
- Skill cards with name, description, version, category
- Click to expand → full SKILL.md, tool definitions, dependencies
- "Agent part" tag showing which sub-agent the skill targets

#### `/library/agent-types` — Agent Type Explorer
Keep the existing RPG-style class sheets. Already well-designed.

#### `/library/models` — Model Catalog
Move the model scan UI here from Settings. Shows:
- All Vertex AI models grouped by provider
- Availability status per model
- "Scan now" button
- No assignment UI here — that's on the agent's Brain tab

### P7. Settings

Streamline to three tabs (remove Models — moved to Library):

#### General
- Agent email domain (editable, writes to Firestore)
- Default zone for new VMs
- Dashboard display preferences

#### Integration
- DWD configuration (existing — keep as-is)
- DWD test button
- Google Workspace status

#### System
- Current version + update check
- Upgrade button
- Contracts.json viewer (read-only, formatted JSON)
- Environment info (project ID, region)

---

## New API Routes

The agent deep-dive needs live data from VMs. The introspect daemon already supports queries — we need dashboard API routes that proxy to it.

| Route | Method | Source | Purpose |
|---|---|---|---|
| `/api/primes/{id}/agent/{name}/introspect` | GET | Firestore bus → VM introspect | Live agent status, model, health |
| `/api/primes/{id}/agent/{name}/soul` | GET | Introspect → SOUL.md | Live SOUL.md content |
| `/api/primes/{id}/agent/{name}/identity` | GET | Introspect → IDENTITY.md | Live IDENTITY.md content |
| `/api/primes/{id}/agent/{name}/skills` | GET | Introspect → skill inventory | Installed skills + tool definitions |
| `/api/primes/{id}/agent/{name}/responsibilities` | GET | Introspect → responsibilities.json | Active responsibilities + schedules |
| `/api/primes/{id}/agent/{name}/memory` | GET | Introspect → MEMORY.md | Core memory content |
| `/api/primes/{id}/agent/{name}/config` | GET/PUT | Introspect → config.json | Read/write agent config |
| `/api/primes/{id}/config` | GET/PUT | Introspect → contracts.json | Read/write prime config |
| `/api/primes/{id}/work` | GET | Firestore | Work tree (existing, add agent filter param) |

The introspect bus already works via Firestore (dashboard writes a command doc → VM's introspect daemon polls → writes response → dashboard reads response). The new API routes follow this same pattern — no new transport needed.

---

## Introspect Daemon Extensions

The `agent-introspect.mjs` daemon needs new query handlers to serve the agent deep-dive:

| Command | Response |
|---|---|
| `get_soul {agentId}` | Contents of `brain/prime/{agentId}/SOUL.md` |
| `get_identity {agentId}` | Contents of `brain/prime/{agentId}/IDENTITY.md` |
| `get_skills` | Array of installed skills with SKILL.md + skill.json content |
| `get_responsibilities` | Contents of `responsibilities.json` with schedule parsing |
| `get_memory` | Contents of `workspace/MEMORY.md` |
| `set_responsibility {id} {enabled}` | Toggle a responsibility on/off |
| `get_config` | Full contracts.json + per-agent config.json |
| `set_config {key} {value}` | Update a config value, restart affected service |

Most of these are filesystem reads — trivial to implement. The existing `get_status`, `get_model`, `set_model` handlers stay as-is.

---

## Component Architecture

### New Components

| Component | Purpose |
|---|---|
| `Breadcrumb.tsx` | Context-aware breadcrumb replacing flat nav |
| `AgentHeader.tsx` | Agent name + status + specialty + actions (reusable) |
| `AgentTabs.tsx` | Tab switcher for agent deep-dive (hash-based) |
| `BrainInspector.tsx` | Per-agent brain config viewer + model swap |
| `SkillGrid.tsx` | Skill card grid (used in both agent tab and library) |
| `ResponsibilityTree.tsx` | R/M/C/T responsibility viewer with toggles |
| `MemoryViewer.tsx` | Markdown content viewer for MEMORY.md/SOUL.md |
| `WorkTree.tsx` | R→M→C→T hierarchical tree (refactored from existing) |
| `ConfigEditor.tsx` | Form-based config editor with save |
| `LiveBadge.tsx` | "Live" indicator showing data freshness |
| `ModelPicker.tsx` | Model dropdown (extracted from Brain page, reusable) |

### Modified Components

| Component | Change |
|---|---|
| `Shell.tsx` | Replace flat nav links with Breadcrumb component. Keep operations drawer + settings gear. |
| `NavCard.tsx` | Add `status` prop for health indicators. No structural change. |
| `PrimeContext.tsx` | Add `selectedAgent` state. Add `introspect()` method for on-demand VM queries. |
| `ChatPanel.tsx` | Extract into a standalone component usable both as slide-in (home) and as tab content (agent page). |

### Deleted Components/Pages

| Path | Reason |
|---|---|
| `app/src/app/brain/page.tsx` | Replaced by per-agent Brain tab + `/library/models` |
| `app/src/app/skills/page.tsx` | Replaced by per-agent Skills tab + `/library/skills` |
| `app/src/app/agent-types/page.tsx` | Moved to `/library/agent-types` |
| `app/src/app/work/page.tsx` | Moved to `/prime/{id}/work` |
| `app/src/app/projects/page.tsx` | Merged into Work page as a filter |
| `app/src/app/processes/page.tsx` | Merged into per-agent Responsibilities tab |

---

## Route Map (Final)

```
app/src/app/
├── page.tsx                              → /                    Home
├── prime/[id]/
│   ├── page.tsx                          → /prime/{id}          Prime Hub
│   ├── fleet/page.tsx                    → /prime/{id}/fleet    Fleet Overview
│   ├── work/page.tsx                     → /prime/{id}/work     Work Tree
│   ├── config/page.tsx                   → /prime/{id}/config   Prime Config
│   ├── chat/page.tsx                     → /prime/{id}/chat     Prime Chat
│   └── agent/[name]/
│       └── page.tsx                      → /prime/{id}/agent/{name}  Agent Deep Dive
├── library/
│   ├── page.tsx                          → /library             Library Hub
│   ├── skills/page.tsx                   → /library/skills      Skill Catalog
│   ├── agent-types/page.tsx              → /library/agent-types Agent Types
│   └── models/page.tsx                   → /library/models      Model Catalog
├── settings/page.tsx                     → /settings            Settings
└── api/
    ├── primes/                           (existing)
    ├── primes/[id]/agent/[name]/
    │   ├── introspect/route.ts           (new)
    │   ├── soul/route.ts                 (new)
    │   ├── skills/route.ts               (new)
    │   ├── responsibilities/route.ts     (new)
    │   ├── memory/route.ts               (new)
    │   └── config/route.ts               (new)
    ├── primes/[id]/config/route.ts       (new)
    ├── models/scan/route.ts              (existing, moved to library context)
    ├── agent-types/                      (existing)
    ├── setup/                            (existing)
    └── upgrade/                          (existing)
```

---

## Execution Plan

### Phase 1 — Foundation (Shell + Routing + Context)
1. Restructure route directories to match new hierarchy
2. Replace Shell flat nav with Breadcrumb component
3. Extend PrimeContext with `selectedAgent` and `introspect()` method
4. Create the `/prime/[id]` hub page with NavCards
5. Move existing pages to new paths (work → prime-scoped, skills/agent-types → library)

### Phase 2 — Agent Deep Dive
6. Create `/prime/[id]/agent/[name]/page.tsx` with tabbed layout
7. Build AgentHeader, AgentTabs components
8. Implement Overview tab (live introspect data)
9. Implement Brain tab (model inspector + swap, SOUL.md viewer)
10. Implement Skills tab (live inventory, tool definitions)

### Phase 3 — Config + Responsibilities + Memory
11. Implement Responsibilities tab (tree + toggles)
12. Implement Memory tab (MEMORY.md viewer)
13. Implement Work tab (filtered work tree)
14. Build `/prime/[id]/config` page (live config editor)
15. Build new introspect API routes

### Phase 4 — Library + Settings Cleanup
16. Create `/library` hub + move skills, agent-types, models
17. Streamline Settings (remove Models tab, clean General tab)
18. Delete deprecated global pages (brain, skills, processes, projects, agent-types at root)
19. Update all internal links

### Phase 5 — Polish
20. LiveBadge component (data freshness indicator)
21. Loading skeletons for introspect data
22. Error states for offline agents
23. Responsive layout (mobile breakpoints)
24. End-to-end testing
