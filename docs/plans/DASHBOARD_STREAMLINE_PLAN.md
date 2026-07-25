# Dashboard Streamline & Polish Plan

> **Version:** 0.3
> **Status:** IN IMPLEMENTATION — **P1, P2, P5 shipped; Plans surface removed + P4 `DeepDiveShell`/`useHashTab` shipped (2026-07-25, build-verified)**. Remaining P3/P4: `lib/format.ts`, `<AsyncState>`/`<Modal>`/`<StatusBadge>`/`<Tabs>`/`<SettingRow>`, `<LibraryList>`, `<AgentItemList>`, and pruning the now-dead chrome CSS from the two deep-dive `page.module.css` files. Earlier baseline: (v2026.07.24.3.0–.7.0; 7 commits; full `next build` passes). Done: dead-code deletion + de-faking (P1); route collapse + config-as-tab + ApprovalQueue fix + projects-CSS dedup (P2); global `:focus-visible` + double-font-load fix (P5a) + the **313 exact hex→token sweep across 27 CSS modules** + BrainInspector token-leak fix (P5b). **Remaining: P3 shared primitives + P4 structural shells** — the two largest/most-visual refactors; plus minor P5 remainders (wrong-`var()`-fallback fixes, organ/work-status palette unification) and the deferred Run-now-rehome + OperationsFeed-retry. Not yet deployed to Cloud Run (dashboard deploy = one Cloud Build). Decisions locked (2026-07-24): **Cost tab REMOVED entirely** (not just the `$` — delete `CostDashboard` + its agent-hub tab); **IA = tabs-primary, standalone routes are drill-in detail only** (tab renders the canonical ListView; delete `/p/[id]/fleet`, collapse `/p/[id]/work`, merge the two `projects` routes); **full P1–P5** in one sustained pass. Theme stays dark-only (token sweep just makes a future light mode *possible*).
> **Scope:** `app/` (Next.js dashboard on Cloud Run, "1health" design system). Audited via three independent passes (structure/IA, data-reality, design-system) that cross-corroborated; load-bearing "delete/fake" claims verified by hand.
> **Goal:** hydrate everything from source (kill hardcoded), delete what isn't real, simplify + collapse duplicates, and make it slick, consistent, and accessible.

## Verdict on hydration: the data plane is REAL

Reassuring headline: **all 52 API routes read/write genuine sources** — Firestore (`getDb()`), the agent introspect channel, the command channel, GitHub raw/API, Secret Manager, Cloud Build, live GCP. **There is no mock backend.** "Properly hydrated" is *mostly true already*. The "not real" surface is narrow and specific — a handful of **fabricated metrics rendered as fact**, a few **hardcoded identity/config literals**, one **broken live panel**, and a **cluster of dead code**. Everything below is targeted at that surface, plus the large structural duplication.

---

## Part 1 — CUT: things that aren't real (remove)

### 1a. Fabricated data shown as fact → remove or make honest
| Item | File:line | Action |
|---|---|---|
| **Dollar costs** — invented Gemini-Flash rates (`INPUT_RATE=0.075…`) drive every `$` on the agent Cost tab. Token counts are real; the money is not. | `components/agent/CostDashboard.tsx:51-63` | **Drop the `$`**; rename tab **"Cost" → "Usage"**, show real tokens/calls/duration/cache-hit only. (Real billing is a separate build — see Open Decisions.) |
| **Progress bars** = `iteration × 10` as a fake percent ("real progress not in schema"). | `WorkDetail.tsx:176,369`, `WorkTree.tsx:229` | Replace the fake % bar with the **real iteration count + status** (no invented progress). |
| **Placeholder chatbot copy** — "I've been trained on our latest manuals…", generic "How can I help you today?", avatar "P". | `ChatPanel.tsx:116,119-133` | Replace with a real product empty-state (or nothing). |
| **Deploy "success" by wall-clock** — any deploy still running after 5 min is force-marked "completed successfully" with no build check; `prime_deploy` completes off `status==="online"`. | `api/primes/[id]/ops/route.ts:200-269` | Report the **real** Cloud Build result; if unknown, say "running/unknown" — never fabricate success. |
| **Per-step upgrade progress** inferred from elapsed time (Cloud Build v1 doesn't stream steps). | `api/upgrade/status/route.ts:117-163` | Show overall build status (real) honestly; drop or clearly label the estimated per-step states. |

### 1b. Hardcoded identity/config that should hydrate from source
| Item | File:line | Action |
|---|---|---|
| Hero **"Prime Agent" / 🧠 / `#22d3ee`** hardcoded for every prime (real `prime.name` ignored). | `app/p/[id]/page.tsx:156` | Hydrate from `prime.name` + the role glyph/accent from `agent-types.json` (already loaded elsewhere). |
| Synthetic **`prime-${id}@system`** email rendered as the address. | `app/p/[id]/page.tsx:60` | Use the real Workspace email, or omit if absent. |
| **DWD onboarding shows 2 OAuth scopes vs the real 14** — a live defect: new operators authorize an incomplete set. | `components/settings/IntegrationTab.tsx:158` vs `:80` | Single source of truth for the scope list (ideally from `contracts.json`); onboarding + settings share it. |
| Duplicated hardcoded GCP **zone lists**. | `DeployPrimeModal.tsx:7-9`, `OnboardingFlow.tsx:16-17` | One shared constant (or from source). |
| `approved_by: "operator"` literal; fallback owner `"chuck"`. | `plans/page.tsx:182`, `ProjectDetailView.tsx:64` | Use the signed-in user / real owner. |

### 1c. Dead code (0 references — delete outright)
Components: **`StatusStrip`, `LiveIndicator`, `FleetSelector`** (+`useFleetSelection`), **`agent/AgentHeader`, `agent/SkillInventory`, `agent/ResponsibilityList`**, the **`AgentChip` component** (keep its `formatAgentDisplayName` helper — used 3×). Hook **`useProjects.ts`**. CSS: **`library/stub.module.css`**, ~**500 orphan lines** in `agent-types/[specialty]/page.module.css:157-874`, dead `.resp*` block `BrainInspector.module.css:511-674`, dead `LoadingSkeleton` (`p/[id]/page.tsx:19`). Vestigial pass-through layouts `p/[id]/layout.tsx` + `library/layout.tsx` (repurpose the library one as the shared list shell — see 2c).

### 1d. Broken-but-real → fix the wiring (don't delete; it's a real feature)
- **ApprovalQueue** (live on the agent Approvals tab): buttons POST `{envelopeId}` but `/api/approvals` needs `approvalId` → **400 every click**; the card reads fields the route never returns → **blank cards**. Align the component to the route schema (`approvalId`, real fields). `ApprovalQueue.tsx:69,104-130` ↔ `api/approvals/route.ts:39-53,76`.
- **OperationsFeed Retry** is a no-op for `dashboard_deploy`/`prime_deploy` (missing from `cmdTypeMap`). Wire it or hide Retry for those types.

---

## Part 2 — SIMPLIFY: collapse duplicate routes & components

The core structural problem: **almost every domain exists twice** — an in-page hash-tab (a bespoke summary component) *and* a standalone route (a full ListView) — with parallel implementations, not shared code.

### 2a. Delete redundant routes
- **`/p/[id]/fleet`** — renders the exact same `<FleetPanel>` as the `#fleet` tab, linked from nowhere. **Delete** (route + its 278-line CSS).
- **`/p/[id]/work`** vs `AgentWorkPanel` (`#work`) — ~90% duplicate (same `useWorkEnvelopes`/`WorkTree`/`WorkDetail`, empty-states copied verbatim). **Collapse to one** (keep the 4-tab AgentWorkPanel + the project filter; route becomes a thin mount or is removed).
- **`/p/[id]/config`** — orphaned (no tab, no link), but the **only** viewer for dispatch/ears/mouth config. **Surface it as a tab** (don't delete a real feature; don't leave it hidden).

### 2b. Merge the two of everything
- **Two `projects` routes** — `app/projects` and `app/p/[id]/projects` wrap the same views; their CSS modules are **byte-identical, 1113 lines each**. **One route + one CSS** (parameterize prime vs global).
- **Two deep-dive pages** — `p/[id]/page.tsx` (prime) and `p/[id]/a/[agent]/page.tsx` (agent) are ~75% identical scaffolding (sidebar, hash-routing, hero, the same `marginTop:8` hack). **Extract `<DeepDiveShell tabs identity theme>`** + shared CSS; the two pages become tab-config + which-tabs.
- **Three `Agent{Projects,Plans,Processes}` tab components** (~220 lines each, shared CSS, same loading/filter/card machine) — and each is *also a second copy* of the corresponding `ListView`. **The tab should render the canonical `ListView`;** delete the parallel summary impl. Reconcile the divergent duplicate `ProjectSummary`/`Responsibility`/`Skill` type decls (2-3× each).

### 2c. Library: three near-identical list screens
`models`, `skills`, `agent-types` are each header→controls→card-grid→loading/empty with a bespoke CSS module. **Extract one `<LibraryList>` shell** (host it in `library/layout.tsx`, which is currently an empty pass-through) with a shared back-link + grid.

---

## Part 3 — COMBINE: shared primitives (kill the re-authoring)

A complete global primitive layer (`.btn/.card/.input/.badge/.chip/.dialog-*` in `globals.css`) already exists but is **inconsistently adopted** — features hand-roll their own. Extract/adopt:
- **`<Modal>`** — 10+ bespoke `overlay+modal` shells re-implement fixed-inset + backdrop + click-out + Escape (only `DialogProvider` does it right). One `<Modal>` over `.dialog-*`. (`FleetPanel` even re-implements the whole HireModal inline.)
- **`<StatusBadge>`** — ~5 parallel badge systems → one, from tokens.
- **`<AsyncState>`** (loading / error / empty triad) — `MemoryViewer`/`SkillInventory`/`ResponsibilityList` CSS are byte-identical; absorbs the **7× `@keyframes spin`, 5× `pulseAnim`, 5-6× `fadeIn`/`slideUp`** re-definitions.
- **`<Tabs>`** pill bar (3 copies), **`<SettingRow>`** (input+Save+"✓ Saved", 3× inline), **`<EmptyState>`**, **`<Pager>`**, **`<StatusDot>`**, section-header, expand/collapse chevron row (5 copies), toggle switch (pixel-identical 2×).
- **Shared utils** — `formatDuration`/`formatDate`/`elapsedSince`/`truncate`/`statusClass` are copy-pasted across 5+ files → one `lib/format.ts`.

---

## Part 4 — SLICK: design-system consistency, states, a11y

### 4a. Token sweep (the #1 consistency debt)
- **469 hardcoded hexes across 43 CSS modules** bypass the token set — most are literal dupes of a token (`#E6EBF0`=`--cloud`, etc.). Replace with `var()`.
- **Fix the wrong `var()` fallbacks** — `var(--charcoal,#2B3440)` (real `#313B47`), `var(--graphite,#1E252E)`, `var(--signal-aqua,#38bdf8)`, `var(--radius-xl,16px)` (real 24) — these encode a *foreign* palette, so any token miss silently shifts design systems. Bug class; fix all.
- **Unify the parallel color systems:** the **two divergent brain-organ maps** (`PersonaPanel.tsx:18-34` vs `CostDashboard.tsx:65-72` — different colors for the same organs) and the off-palette work-status colors → one tokenized organ/status palette.
- **Fonts:** Inter is double-loaded (blocking Google `@import` *and* `next/font`); drop the `@import`, load Inter + JetBrains Mono via `next/font`, use the `--font-*` vars. Kill "SF Mono"/"Fira Code" one-offs.

### 4b. States & accessibility (best practice)
- **`:focus-visible` = 0 matches in the entire app.** Add a global focus ring; convert `<div onClick>` clickables (WorkTree/VerdictCard/WorkDetail) to real buttons. **This is the biggest a11y+polish gap.**
- **Standardize loading** on one skeleton idiom (today: ~6 idioms, loading-rendered-as-empty-state in CostDashboard/ApprovalQueue). Use the `<AsyncState>` skeleton.
- **Consistent error states** — several fetches swallow failures → blank pages (`models`/`skills` libraries, `BrainInspector`); mutation failures silently ignored (`GeneralTab`, `SecretsTab`, `CreateProjectModal`). Toast on failure; show a retry.
- **Unify modal blur/overlay** (currently 4-20px blur, two overlay tints) to the system values.
- **Breakpoint tokens** — 7 magic breakpoints scatter; adopt `--bp-*` and fix the mobile-overflow rows (SecretsTab, settings input rows, the 600-char OAuth-scope string).

### 4c. Trim heavy decoration (optional)
The home page runs a per-frame `requestAnimationFrame` proximity-glow mouse tracker, and `FleetVisualization` does `getBoundingClientRect`+`ResizeObserver`+SVG `animateMotion` purely for decorative connector lines (the heaviest component in the app). Keep the vibe, cut the cost — or gate behind `prefers-reduced-motion`/idle.

---

## Part 5 — Phasing (each phase ships + is verifiable)

1. **P1 — Delete dead code + cut fabrications.** Remove the 1c dead files; strip the fake `$`/progress/chatbot-copy; fix the hardcoded identity/config (1b) + DWD-scope defect. Fast, high-signal, low-risk. *(No new components.)*
2. **P2 — Route collapse.** Delete `/p/[id]/fleet`; collapse `/p/[id]/work`; merge the two `projects` routes; surface `config` as a tab. Fix ApprovalQueue + OperationsFeed-retry wiring.
3. **P3 — Shared primitives.** Build `<Modal>`, `<StatusBadge>`, `<AsyncState>`, `<Tabs>`, `<SettingRow>`, `lib/format.ts`; adopt across features (kills the keyframe/util duplication).
4. **P4 — DeepDiveShell + AgentItemList + LibraryList.** Extract the three big structural components; delete the parallel impls + the byte-identical CSS.
5. **P5 — Token sweep + a11y.** Replace the 469 hexes, fix the wrong fallbacks, unify palettes/fonts, add `:focus-visible` globally, standardize states.

Deploy is one Cloud Build (`gcloud builds submit` / dashboard upgrade); verify each phase in the running app (Browser pane) — no agent-VM involvement.

## Open decisions (for you)
1. **Costs** — (a) drop `$`, show real usage only ("Usage" tab) [recommended, honest]; or (b) wire real GCP billing export (a build).
2. **IA model** — confirm **hub-with-tabs is primary, standalone routes are drill-in detail only** (collapse the duplicates that way), vs keep separate routes.
3. **Depth of this pass** — all five phases now, or P1-P2 (cut + collapse) first and P3-P5 (primitives + tokens) as a follow-up.
4. **Theme** — stay dark-only (current), or make the token sweep light-mode-ready while we're in there.
