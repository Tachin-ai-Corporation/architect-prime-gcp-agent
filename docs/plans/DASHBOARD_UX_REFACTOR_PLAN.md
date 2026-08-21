# Dashboard UX Refactor Plan — organize around the three jobs

> **Version:** 1.0 (APPROVED 2026-08-21 — all decisions locked; full four-phase pass authorized)
> **Scope:** `app/` (Next.js dashboard on Cloud Run, "1health" design system). No agent-VM/runtime involvement; deploy = one Cloud Build.
> **Builds on:** [`DASHBOARD_STREAMLINE_PLAN.md`](DASHBOARD_STREAMLINE_PLAN.md) (v0.5, MOSTLY SHIPPED v2026.07.25). That pass was **code hygiene** — dedup, de-faking, the 313-hex→token sweep, global `:focus-visible`, a first route-collapse. It explicitly deferred the **structural/UX reorganization** (its P3/P4 tail + the "IA model" open decision). *This* plan is that follow-up, reframed around what the dashboard is actually *for*.
> **Method:** four independent read-only passes (top-level IA, library/settings, prime-interaction/observability, and a focused root-cause of the work-history bug) that cross-corroborated. Load-bearing claims cite `file:line`.

## The problem in one paragraph

The dashboard has **three jobs** — (1) library & settings, (2) prime-agent interaction, (3) agent config & observability across prime *and* fleet. Only job #1 has a clear home (the 📚/⚙️ top-bar icons). Jobs #2 and #3 are **buried and scattered**: interaction is the *last* of nine hash-tabs inside a prime, and observability/config is smeared across Prime tabs, a *different* set of Agent tabs, an **orphaned** Fleet Studio that no link reaches, and `/library/models` — with **no fleet-wide view anywhere**. Three different "tabbed hub" patterns coexist and only one is honest to the URL/breadcrumb. And the single most-used observability drill-down — expanding a mission into its checkpoints and tasks — is **actively broken** (children vanish on the next poll). The fix is not more screens; it's mapping every surface to exactly one job, deleting the duplicates, surfacing the two things a real operator needs at a glance (fleet health + pending approvals), and repairing the work tree.

## Locked decisions (operator, 2026-08-21)

1. **Fleet Studio → absorb into a fleet-wide observability *Home*** — and render it in the **node-graph / "nodes in space" aesthetic** (prime & agents as nodes, animated connector lines + moving dots) that exists today in `FleetVisualization`. That decorative layer is now a **feature to keep and elevate**, not cut — gated behind `prefers-reduced-motion` for a11y. Studio's release/provenance/drift data becomes views within this Home.
2. **Hub pattern → converge on real nested routes** (Library's pattern — the only breadcrumb- and deep-link-honest one). Remove the hash-tab (`useHashTab`) and Settings `?tab=`+useState patterns.
3. **Approvals → promote to a global badged surface AND fix the implementation** (it is under-built today; relocation + repair together).
4. **Depth → all four phases, one sustained pass.**
5. **Individual fleet-agent chat → retire entirely** (delete the surface, not demote it). Chat is **prime-only**. Separately, **rebuild the prime chat to feel real-time and modern** (ChatGPT/Anthropic-grade web chat).

---

## P0 — Fix the work-history vanishing bug (ship first, standalone)

**Symptom (operator):** expand a mission → its checkpoints appear, then vanish "almost as soon as I look at them"; same for checkpoints → tasks.

**Root cause (confirmed, high confidence):** `app/src/components/work/useWorkEnvelopes.ts` has two paths that disagree about the envelope array.
- Lazy expand *merges*: `loadTree` GETs the full subtree from `/work/{id}/tree` and does `setEnvelopes([...prev, ...newOnes])` (`useWorkEnvelopes.ts:239-243`).
- The poller *replaces*: `fetchWork` does `setEnvelopes(data.envelopes)` (`useWorkEnvelopes.ts:141`) on a 15 s interval (`:159`) **and immediately on tab refocus** (`visibilitychange`, `:160-161`).
- `/api/primes/[id]/work` deliberately returns **completed** missions **root-only** (`complete` ∉ `ACTIVE_STATUSES`). So the next poll overwrites the array with a shallow payload and the merged checkpoints/tasks are gone.
- Rows are keyed by stable id (`WorkTree.tsx:252,223`), so the chevron stays `expanded` while `node.children` is now `[]` → the open container renders nothing. The `loadedTreesRef` guard (`:232`) then makes re-clicking a no-op until the panel remounts.

The "as soon as I look" timing **is** the refocus refetch — glancing at another window and back triggers an instant wipe.

**Fix (small, safe):** make the poll *merge* instead of *replace*. Track descendants that `loadTree` fetched (a `useRef<Map<id, WorkEnvelope>>`), and in `fetchWork` retain any previously-loaded descendants the shallow payload omits, fresh payload winning on id collision:
```ts
const freshIds = new Set(data.envelopes.map(e => e.id));
const retained = [...loadedEnvelopesRef.current.values()].filter(e => !freshIds.has(e.id));
setEnvelopes([...data.envelopes, ...retained]);
```
Terminal history is immutable, so retaining it is always correct; active trees already come back fully hydrated and win on collision. **Isolated to completed / "Recent Work" trees;** In-Progress hydrates descendants already, and Archived is a flat list — both unaffected.

---

## The IA reframe — three jobs, three homes

**Today (everything is "drill into a Prime → 9 hash-tabs"):**
```
Top bar:  [logo/Home]  [Ops drawer]  📚 Library  ⚙️ Settings  [version]
Home   →  vertical list of Primes → each expands a decorative fleet viz
Prime  →  Persona* · Work · Models · Fleet · Projects · Processes · Config · Memory · Chat     (*default; Chat is last)
Agent  →  Persona* · Work · Models · Contracts · Approvals · Projects · Processes · Memory · Comms(read-only)
Orphans:  /p/[id]/studio (fleet release/observability — unreachable) ,  /projects (global — unreachable)
```
Three "hub" patterns: deep-dive = hash-tabs (`#work`), Settings = `?tab=`+useState, Library = real routes. Only Library is breadcrumb- and deep-link-honest.

**Approved target — each surface maps to exactly one job; nested routes throughout:**
```
Top bar:  [logo/Home]  ✅ Approvals(badge)  ⚡ Operations(badge)  📚 Library  ⚙️ Settings

JOB 3 — OBSERVABILITY (fleet-wide) = HOME, rendered as the node-graph/space view
  /              →  the "nodes in space" fleet map: prime + agents as animated nodes/connectors,
                    each node carrying live status/presence, drift vs release, pending-approval &
                    active-op counts. Click a node → drill into that prime/agent. Absorbs Fleet
                    Studio's Releases & Drift as views here. (Studio route retired.)

JOB 2 — INTERACTION
  /p/[id]/chat   →  the prime chat — real-time, modern rebuild, with the live MissionPresence strip.
                    (Fleet-agent chat is GONE — prime-only.)

JOB 3 — CONFIG & OBSERVABILITY (per entity, drill-in nested routes)
  /p/[id]/...            →  chat · work · config(read) · brain(edit) · fleet · memory
  /p/[id]/a/[agent]/...  →  work · config(read) · brain(edit) · contracts · approvals · memory
                            (Projects/Processes are drill-in detail routes, not top-level tabs)

JOB 1 — LIBRARY & SETTINGS (already clean; tidy only)
  /library   →  skills · roles · models   (read-only catalog)
  /settings  →  general · security · secrets · system   (Integration folds into onboarding)
```

Two operator-centric outcomes fall out and directly answer "what users will need":
- **Approvals become a global, always-visible badged surface** (like Operations) — *and* get fixed — instead of being buried inside each agent's tab set. Governance is time-sensitive; the recent approval-loop pain is the symptom of approvals being hard to find and act on.
- **Fleet health *is* the Home** (the node-graph), so the daily question — "is anything working / stuck / awaiting me / drifted?" — is answered on login, in the visual the operator already likes.

---

## CUT — remove or make honest

| # | Item | Where | Action |
|---|---|---|---|
| C1 | **Orphaned top-level `/projects`** — reachable only as a self-referential fallback | `app/projects/page.tsx` | Delete; the prime-scoped route is the real one |
| C2 | **Individual fleet-agent chat — retire entirely** (live chat moved to Google Chat; the tab is a read-only "Dashboard Chat Retired" archive) | `FleetCommsReadOnly.tsx`, agent route, home 💬-to-agent path | **Delete** the surface and its links; chat is prime-only |
| C3 | **Dead responsibility-toggle remnants** — empty stubs + unused types for a ripped-out feature | `BrainInspector.tsx:132-133,375-377,36-45` | Delete |
| C4 | **Dead API payloads** — `workspaceFiles` + `brainAppends` fetched & typed but never rendered | `agent-types/[specialty]/route.ts:326-335,372-375` + detail page:80 | Stop fetching/returning |
| C5 | **Over-promising copy** — Library says skills are "available for installation" and models are "Scan and manage"; neither installs nor assigns | `library/page.tsx:20,32` | Reword to reference-catalog language |
| C6 | **Misplaced "Project Info" status block** — read-only GCP project / DWD signer / prime+fleet counts inside Settings→General | `GeneralTab.tsx:65-83` | Move to Home as node/fleet status; Settings is for *settings* |
| C7 | **Home proximity-glow rAF tracker** — per-frame mouse glow, decorative | `page.tsx:55-91` | Drop (the node-graph is the intended visual; keep *that*, gate on `prefers-reduced-motion`) |
| C8 | **Stale breadcrumb labels** — `work/fleet/chat/config/brain` are hash-tabs, `deploy/setup` are API-only; none are path segments | `Breadcrumb.tsx:10-27` | Rebuild for the nested-route structure (R6) |
| C9 | Lint-dead `useEffect` imports; the no-op `library/layout.tsx` passthrough | `GeneralTab.tsx:3`, `SystemTab.tsx:3`, `library/layout.tsx` | Delete (or repurpose the layout as the shared list shell) |

**Note:** the **FleetVisualization node-graph (connectors + moving dots) is KEPT and elevated** to the Home (locked decision 1) — the opposite of a cut. Only the separate proximity-glow tracker (C7) goes.

---

## REARRANGE — the structural moves, by job

**R1 · Home = the fleet-wide node-graph observability view (biggest single win).** Elevate `FleetVisualization`'s node/connector/moving-dot aesthetic from a home-list decoration to *the* Home. Nodes are the prime and its agents; each carries live status + `MissionPresence` + drift-vs-release + pending-approval/active-op counts. Absorb Fleet Studio's seven post-release answers (what changed / why / who / where active / how it performed / what approval / how to undo) and the per-agent coordinates+drift table as **Releases** and **Drift** views reachable from the map. Retire `/p/[id]/studio`. Keep Studio's honesty principle ("an unknown must not look like good news" — render "unknown + why", never a blank). Gate animation behind `prefers-reduced-motion`.

**R2 · Collapse the config/observability viewer sprawl.** Three viewers overlap — `ConfigViewer` (Prime, live `brain_config`), `ContractsViewer` (Agent, repo `contracts.json`), `BrainInspector` (both, editable model slots). "What model is cortex on?" has three answers from two sources with nothing reconciling them. **Converge on:** one **Config (read)** route — reconciling live-vs-repo, flagging drift — and one **Brain (edit)** route (the model slots). **Rename the editable tab "Models" → "Brain"** and reserve "Models" for the library catalog, killing the 3-way name collision.

**R3 · One fleet grid, not two.** `FleetVisualization` (home, chat+upgrade+hire) and `FleetPanel` (tab, hire+upgrade+fire) are parallel hand-rolled grids with two hire-modal impls. The node-graph Home (R1) is the fleet-wide view; the per-prime **Fleet** drill-in reuses the *same* node/card components with the full action set (chat · upgrade · hire · fire). One implementation, one hire modal.

**R4 · Finish the route-vs-tab collapse.** "Projects" exists **three** ways, "Processes" **two**, and entering via a *tab* but exiting a detail via the *standalone list* silently swaps list implementations mid-flow. **Rule: one canonical `ListView` per domain, reached as a nested route; details are child routes.** Delete the parallel `AgentProjects`/`AgentProcesses` summary impls. Fix the latent dead filter: the Prime page hands `AgentProjects` the synthetic `prime-${id}@system` email (`p/[id]/page.tsx:50`) so "My Projects" never matches.

**R5 · Interaction is the front door.** Opening a Prime lands on **Chat** (today `overview`=Persona, Chat last). Persona/Memory become reference routes.

**R6 · Nested routes everywhere (the consistency spine).** Replace `useHashTab` (deep-dive) and `?tab=`+useState (Settings) with real nested routes so every surface is linkable and the breadcrumb tells the truth. Rebuild `Breadcrumb` from the real path (prime name → section → detail). This is what makes the whole reorg navigable; do it last (P4) so it lands over a settled screen set.

**R7 · Real-time, modern prime chat (new — locked decision 5).** Rebuild `ChatPanel` to feel like a current web agent chat: streaming-in of the reply as it arrives (the transport is async via the agent mouth, so stream the text on arrival rather than popping a block), an "agent is thinking/working" indicator wired to `MissionPresence`, smooth auto-scroll with a scroll-to-bottom affordance, multiline composer (Enter to send, Shift+Enter newline), stop/regenerate affordances where meaningful, tightened message bubbles/avatars/markdown, and snappier polling/optimistic UI. Keep the existing `/api/primes/{id}/messages` transport; upgrade the *experience*.

---

## Phasing (each phase ships + verifies in the Browser pane; deploy = one Cloud Build)

1. **P0 — Work-tree fix.** One file (`useWorkEnvelopes.ts`). Independent; ship immediately.
2. **P1 — Purpose-legibility quick wins (low risk).** Rename Models→Brain + fix collision (R2 naming) · Chat-first ordering (R5) · **delete** fleet-agent chat (C2) · move Project-Info to Home status (C6) · CUT C3–C5, C7, C9. No new architecture yet.
3. **P2 — Consolidation.** Unify the fleet grid/components (R3) · converge the three config viewers into Config-read + Brain-edit (R2) · finish projects/processes collapse (R4) · fix + promote **Approvals** to a global badged surface (locked 3).
4. **P3 — Node-graph observability Home.** Build the Home as the fleet-wide node/space map (R1), absorbing Studio's Releases/Drift; retire `/p/[id]/studio`. Largest visual piece.
5. **P4 — Nested-route migration + breadcrumb + chat rebuild.** Convert deep-dive & Settings to nested routes and rebuild the breadcrumb (R6); rebuild the prime chat experience (R7). Do last so routing lands over a settled screen set.

Everything is authorized; proceed P0 → P4, committing each phase with the `v{YYYY}.{MM}.{DD}.{i}.{s}` prefix and verifying in the running app.
