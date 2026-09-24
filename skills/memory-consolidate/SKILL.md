# Skill: Memory Consolidation

## When to Use
Automatically triggered by nightly cron. Do not invoke manually. Performs nightly consolidation of working memory, Core Memory reconciliation, and Deep Truths lifecycle management.

## Commands

Temporal-Memory executes these directly — it is the memory authority and runs the memory tools itself; the consolidation mission is dispatched with tool access (B-3/B-16).

**The memory boundary.** Memory is exactly three layers — working memory (`MEMORY.md`), Core Memory and Deep Truths — and they are the only things this cycle writes. Processes, projects, skills and responsibilities are *definitions*: read them to reconcile, never write them. A lesson about one is recorded as memory, tagged to it. The tools enforce this: the consolidation toolset has no shell and no general file writer.

Run each CLI through the **`memoryCommand`** tool, passing the command line exactly as shown. It runs with no shell, so pipes, `;`, `&&`, redirects and `$(…)` are refused; put long free text in its `stdin` field.
- `core-memory-read [--query Q] [--category C] [--since 30d] [--limit N]` — read Core Memory (entries returned value/relevance-ranked). The default limit is small — pass `--limit 50` when surveying.
- `core-memory-write --fact "<fact>" --category <cat> [--tags "t1,t2"] [--importance <0..1>] [--supersedes <old-id>]` — promote or update a durable fact.
- `core-memory-retire --id <id> --reason "<why>"` — retire a stale/contradicted/duplicated entry.
- `update-deep-truths --list | --add "<truth>" | --remove "<text>"` — Deep Truths lifecycle.
- `session-summary --hours 24 [--exclude-intent memory_consolidation]` — recent sessions + compaction digests.
- `process-ops list` · `process-ops get <id>` · `project-manage list` · `project-manage get <id>` — **read-only** views of the playbooks and projects you reconcile against. Their write subcommands are refused.

Files: read with `readFile`; write `MEMORY.md` and `consolidation_report.md` with **`writeMemoryFile`** — the only files memory writes.

## Procedures

This is Temporal-Memory's "sleep cycle" — I process the day's experiences across all three memory layers, **running the tools myself** (I am the memory authority for the whole brain), and I weight what I keep by value so recall later surfaces the good stuff first.

### Nightly Consolidation Playbook
1. **Gather Working Memory:** Read `/opt/corekit/workspace/MEMORY.md` to see recent focus and open items.
2. **Retrieve Recent Conversations:** Run `session-summary --hours 24 --limit 20` to extract user interactions. Long missions include a `Digest:` section — compaction digests whose `learning:` lines carry pre-binned claims distilled in-flight; treat these as first-class promotion candidates (they already passed epistemic-bin validation).
3. **Scan Recent Work Ledger:** The brain daemon queries the agent's completed work envelopes from the last 7 days (via the same episodic retrieval used for recall). Use these to identify facts worth promoting — completed missions carry verified outcomes.
4. **Scan Recent Core Memory:** Run `core-memory-read --since 30d --limit 20` to scan recent long-term writes.
5. **Scan Full Category Archives:** Run `core-memory-read --category <cat> --limit 50` for categories: `architecture`, `operations`, `iam`, `decisions`, `patterns`, `errors`, `resources` — then `core-memory-read --limit 100` with **no** `--category`, to catch entries filed under any other name. **An empty read is almost always a bad filter, not an empty memory:** the tool now says when a read was filtered; never conclude memory is empty until an unfiltered read says so.
5b. **Promote and reconcile Resources (the name→id table):** Missions capture external identifiers — Drive folders, docs, chat spaces — onto their envelope as they resolve them. Promote the durable ones into the `resources` category so the *next* mission never has to search for them:
   - `core-memory-write --fact '<kind>: "<name>" = <id>' --category resources --tags "<kind>,<project>" --importance 0.8`
   - One entry per identifier, written in exactly that form so recall can parse it back. This is a **lookup table, not narrative memory** — no prose, no commentary.
   - **Record aliases as their own entries.** If a mission searched for "signed artifacts" and the folder is actually *Executed Advisory Agreements*, write **both** names pointing at the same id. The alias is the expensive knowledge: one real mission burned its entire dispatch budget re-running the same failed search six times because the name in the plan was not the name in Drive.
   - **Reconcile, don't accumulate.** When an id has changed, `--supersedes` the old entry. When a target no longer resolves, retire it in step 8 — a confidently wrong id is worse than no id, because it will be trusted.
   - The `resources` cap does not consume the step-9 promotion budget: identifiers are cheap, high-value, and self-limiting (one per real-world object).
5c. **Read the definitions (read-only):** `process-ops list` and `project-manage list` (then `get` for anything relevant) show the playbooks and projects this agent works with. A Core Memory fact that merely restates what a project or playbook declares — a resource id the project already carries, a playbook's own advice — is redundant: retire the *memory* copy in step 8. Never edit the definition; you cannot, and it is not memory. **And never copy a definition INTO memory** — a project's resources, team, canon or URLs, a playbook's advice: recall already reads them from the definition, and a memory copy goes stale. Definitions are here only so you can spot duplicates.
6. **Triage Working Memory:** Classify every entry in `MEMORY.md` into one of: `ACTIVE`, `COMPLETED`, `STALE`, or `PROMOTE`. A `lesson (project <id>)` / `lesson (playbook <id>)` line is the daemon's record of what a mission taught about that project or playbook — promote it as a lesson tagged with that id, or let it go.
7. **Identify Outdated Core Memories:** Compare recent work against the long-term archive to locate contradicted, redundant, duplicated or stale entries.
8. **Retire or Supersede:** Run `core-memory-retire --id <entry-id> --reason "<reason>"` for stale items, or `core-memory-write --fact "<fact>" --category <cat> --supersedes <old-id>` for updates. (Max 5 per run). Retire on evidence a fact is **wrong, stale or duplicated — never to rename it.** A fact whose value is still right keeps its name: other work (a responsibility, a resource lookup) recalls it by that name, and a "canonical" rename silently breaks it. For duplicates, keep the oldest entry and retire the copies.
9. **Promote Stable Facts:** Run `core-memory-write --fact "<fact>" --category <cat> --tags "<topic>" --importance <0..1>` for promoted items. (Max 5 per run). **Never write a fact that is already active** — steps 4-5 show what exists; skip it, or `--supersedes` the existing entry to change it. A second copy is not reinforcement, it is noise that the next pass has to clean up. Nor anything a project or playbook already declares (step 5c) — that is a copy, not a learning. **Weight by value (B-5):** set `--importance` high (→1.0) for a learning that recurred across sessions, led to a success, or is load-bearing; leave routine facts at the default. Always set `--tags` (topic) so retrieval can find high-value learnings by subject. This is how recall surfaces the good stuff first — the whole brain benefits from what I weight well. **Never promote a failure into a feasibility verdict.** A mission that failed promotes only as a forward *lesson* — "when `<situation>`, `<do X>`" — never as "`<task>` is infeasible / impossible / can't be done." Feasibility is decided at execution time against current tools; a durable "it can't be done" belief is self-fulfilling and outlives the conditions that produced it. If such a belief already exists and the tooling has since changed, retire it in step 8.
10. **Prune and Rewrite Working Memory:** Overwrite `MEMORY.md` with only active items via `writeMemoryFile`, using the template format (must be under 2,000 characters).
11. **Review and Update Deep Truths:** Run `update-deep-truths --list` and modify if needed using `--add` or `--remove`. (Max 2 changes per run).
12. **Generate Report:** Write a structured `consolidation_report.md` via `writeMemoryFile` (and echo it) with counts: working-memory triaged, retirements, promotions, Deep-Truth changes, final MEMORY.md char count. **This file is the mission's verifiable outcome** — cerebellum checks it; never leave the consolidation to be reconstructed after the fact.

---

## Architectural Details

### Three-Layer Memory Architecture

The work ledger (the root `work/` collection) serves as an episodic recall source — a retrieval mechanism over the system's own audit trail (B-23). It is not a fourth consolidated memory layer; facts from work history are promoted into Core Memory through the normal triage process (B-5 preserved). Likewise the conversation (deterministic context, B-32), and the process, project and skill definitions: all are read by memory, none is written by it.

| Layer | Storage | When Loaded | Lifespan | Your Job |
|---|---|---|---|---|
| **Working Memory** (`MEMORY.md`) | Local file | Every Cortex call (system prompt) | Hours–days | Prune completed/stale items, keep < 2,000 chars |
| **Core Memory** (Firestore) | `core_memory` collection | On-demand via recall | Weeks–months | Retire stale entries, promote stable new facts |
| ↳ **Resources** (`resources` category) | same collection | Recall Layer E, every mission | Until the target moves | Promote captured identifiers, record aliases, supersede on change |
| **Deep Truths** (`SOUL.md` § Deep Truths) | Local file | Every Cortex call (system prompt) | Months–permanent | Change only with strong multi-session evidence |

### Phase 5 MEMORY.md Template
```markdown
# MEMORY (<Specialty>)

## Current Focus
- What the agent is actively working on

## Active Context
- Operational state, environment notes, pending items

## Open Items
- Unresolved blockers or follow-ups
```

### Deep Truths Review Criteria
- **When to Add:** Evidence spans 3+ separate sessions, stable in Core Memory for 7+ days, cite 2+ Core Memory IDs as evidence, universally applicable, single sentence, shapes behaviour. **Never a bare incapacity claim** ("X can't be done") — those are not truths, they are stale conditions masquerading as truths.
- **When to Remove:** Contradicted by newer evidence, environment/tooling has changed, or redundant with other truths.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `core-memory-write` or `core-memory-retire` fails | Firestore connection timeout or rate limit | Retry the operation once. If it continues to fail, log the failure and defer the update to the next night's consolidation run. |
| Cannot write to `MEMORY.md` | File is locked or permission denied | Wait 5 seconds and retry the write operation. If it fails again, log a warning and proceed with the remaining steps. |
| Deep truths limit exceeded (10) | Attempting to add an 11th truth | Run `update-deep-truths --list`, identify and remove a less critical or redundant truth first, then add the new one. |
| `REFUSED (memory boundary)` from `memoryCommand` or `writeMemoryFile` | The command or path is outside memory — a definition write, a shell operator, or a non-memory file | Do not look for another route: memory writes only the three layers. Record what you wanted to capture as a Core Memory lesson tagged to the project or playbook instead. For a shell operator, run each CLI as its own `memoryCommand` call. |
