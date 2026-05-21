---
name: memory-consolidate
description: "Nightly consolidation of working memory, Core Memory reconciliation, and Deep Truths lifecycle management. Runs at 2am CT (08:00 UTC) via the responsibility scheduler."
---

# Memory Consolidation — Nightly Skill

You are executing the nightly memory consolidation responsibility.
This is the agent's "sleep cycle" — processing the day's experiences across all three memory layers.

## Three-Layer Memory Architecture

Understanding the architecture is critical to executing this correctly:

| Layer | Storage | When Loaded | Lifespan | Your Job |
|---|---|---|---|---|
| **Working Memory** (`MEMORY.md`) | Local file | Every Cortex call (system prompt) | Hours–days | Prune completed/stale items, keep < 2,000 chars |
| **Core Memory** (Firestore) | `core_memory` collection | On-demand via recall | Weeks–months | Retire stale entries, promote stable new facts |
| **Deep Truths** (`SOUL.md` § Deep Truths) | Local file | Every Cortex call (system prompt) | Months–permanent | Change only with strong multi-session evidence |

## Phase 1: Gather (Steps 1–4)

Read all sources before making any changes.

### Step 1 — Working Memory
```
read ~/.openclaw/workspace/MEMORY.md
```

### Step 2 — Recent Conversations
```
exec session-summary --hours 24 --limit 20
```
Extracts user questions and agent responses from the last 24 hours.

### Step 3 — Recent Core Memory (last 30 days)
```
exec core-memory-read --since 30d --limit 20
```
Broad scan of what's been stored recently. Shows operational patterns and recent decisions.

### Step 4 — Full Archive Scan
```
exec core-memory-read --category architecture
exec core-memory-read --category operations
exec core-memory-read --category iam
exec core-memory-read --category decisions
exec core-memory-read --category patterns
exec core-memory-read --category errors
```
Scans the complete long-term knowledge base. Look for entries that may be outdated, contradicted by recent work, or redundant.

## Phase 2: Triage Working Memory (Step 5)

Classify every entry in MEMORY.md into exactly one bucket:

- **ACTIVE** — Still relevant to ongoing work. Keep in MEMORY.md.
- **COMPLETED** — Task finished, issue resolved, or item addressed. Prune.
- **STALE** — Information no longer accurate or relevant. Prune.
- **PROMOTE** — Stable fact proven across multiple sessions. Candidate for Core Memory.

## Phase 3: Reconcile Long-Term Memory (Steps 6–7)

Compare recent work (Steps 1–2) against the long-term archive (Steps 3–4). This is where Tier 2 gets actively pruned — not just accumulated.

### Step 6 — Identify Stale Long-Term Entries

Look for Core Memory entries that are:
- **CONTRADICTED** — A long-term fact that recent evidence shows is wrong
- **OUTDATED** — Facts about versions, endpoints, configs that have changed
- **REDUNDANT** — Multiple entries saying the same thing
- **STALE** — Facts not recalled in weeks that have no operational relevance

### Step 7 — Retire or Supersede

For entries that are simply wrong or irrelevant:
```
exec core-memory-retire --id <entry-id> --reason "Specific reason this is no longer true"
```

For entries that need updating (the fact changed, not disappeared):
```
exec core-memory-write --fact "<updated fact>" --category <cat> --supersedes <old-id>
```

**Maximum 5 retirement/supersede operations per run.**
Always provide a specific reason — never bulk-retire without justification.

## Phase 4: Promote New Facts (Step 8)

For each PROMOTE item from Step 5, write to Core Memory:
```
exec core-memory-write --fact "<concise fact>" --category <cat> --tags "t1,t2"
```

Categories: `architecture`, `operations`, `iam`, `decisions`, `patterns`, `errors`

**Promotion criteria** — only promote facts that:
- Appeared in multiple sessions or were confirmed by the operator
- Represent stable architectural, operational, or behavioral patterns
- Are NOT already in Core Memory (check Step 4 results first)
- Are NOT transient (task status, current debugging focus, session-specific notes)

**Maximum 5 writes per run.** If a fact supersedes an existing entry:
```
exec core-memory-write --fact "<updated fact>" --category <cat> --supersedes <existing-id>
```

## Phase 5: Prune and Rewrite Working Memory (Step 9)

Rewrite MEMORY.md with only ACTIVE items from Step 5. Use this structure:

```markdown
# MEMORY (<Specialty>)

## Current Focus
- What the agent is actively working on

## Active Context
- Operational state, environment notes, pending items

## Open Items
- Unresolved blockers or follow-ups
```

The result **MUST** be under 2,000 characters. An empty MEMORY.md with just the header template is a valid and healthy outcome when no active work is in progress.

Use exec to write the file:
```
exec bash -c 'cat > ~/.openclaw/workspace/MEMORY.md << "MEMEOF"
<new content here>
MEMEOF'
```

## Phase 6: Deep Truths Review (Step 10)

Deep Truths are the agent's behavioral firmware — loaded into every prompt, shaping every decision. They change rarely and only with overwhelming evidence.

### When to Add a Deep Truth
ALL of the following must be true:
- Evidence spans **3+ separate work sessions or days**
- The relevant fact has been **stable in Core Memory for 7+ days**
- You can cite **at least 2 Core Memory entry IDs** as evidence
- The truth is **universally applicable** (not task-specific)
- It is expressible as a **single concise sentence**
- It affects **how the agent should behave on every turn**

### When to Remove a Deep Truth
ANY of the following:
- Accumulated evidence **directly contradicts** it
- The environment, architecture, or tooling has **changed fundamentally**
- It has become **redundant** with newer truths that say it better

### Commands
```
exec update-deep-truths --list                    # check current truths
exec update-deep-truths --add "Concise truth"     # add (with justification in report)
exec update-deep-truths --remove "Exact text"     # remove (with reason in report)
```

### Governance
- Maximum **10 Deep Truths** total (enforced by the script)
- Maximum **2 changes** per consolidation run
- Every addition **MUST** include justification + cited Core Memory IDs in the report
- Every removal **MUST** include the reason + what changed in the report
- **If unsure, do NOT change** — wait for more evidence

### What Qualifies
- Fundamental user preferences that shape every interaction
- Architectural invariants that constrain every decision
- Operational constraints that apply universally
- Behavioral patterns that should persist across context resets

### What Does NOT Qualify
- Version numbers, endpoints, or transient configuration
- Task-specific learnings (those belong in Core Memory)
- Temporary workarounds or debugging notes
- Anything likely to change within 30 days

## Phase 7: Report

Output a structured summary:

```
Memory Consolidation Complete
──────────────────────────────
Working Memory (MEMORY.md):
  Items triaged: N (active: N, completed: N, stale: N, promoted: N)
  Final size: N characters

Core Memory (Firestore):
  Entries reviewed: N
  Retired: N (with reasons)
  Superseded: N
  New promotions: N

Deep Truths:
  Current count: N/10
  Added: N (with justification)
  Removed: N (with reason)

Nothing to consolidate: (if empty run)
```

## Rules

- **Max 5 Core Memory writes/retires per run** (prevents flooding)
- **Max 2 Deep Truths changes per run** (soul changes are rare)
- **NEVER write transient state to Core Memory** — that's MEMORY.md's job
- **NEVER fabricate facts** — only record what actually happened
- **NEVER retire without a specific reason** — every retirement must be justified
- **Be conservative** — when in doubt, don't promote, don't retire, don't change Deep Truths
- If no changes are needed, report "Nothing to consolidate" and exit cleanly
