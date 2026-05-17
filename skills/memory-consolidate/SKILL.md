---
name: memory-consolidate
description: "Nightly consolidation of conversation activity into Core Memory and SOUL.md Deep Truths. Runs at 2am CT via temporal-memory cron."
---

# Memory Consolidation — Nightly Skill

You are executing the nightly memory consolidation responsibility.
Review today's conversation activity and extract durable facts.

## Phase 1: Gather

Read these sources in order:

1. **Working memory** — Cortex's current state:
   ```
   read ~/.openclaw/workspace/MEMORY.md
   ```

2. **Recent conversations** — what happened in the last 24 hours:
   ```
   exec session-summary --hours 24 --limit 20
   ```
   This extracts user questions and agent responses from cortex's session transcripts.

3. **Current Core Memory** — what we already know:
   ```
   exec core-memory-read --category architecture
   exec core-memory-read --category decisions
   exec core-memory-read --category patterns
   exec core-memory-read --category operations
   exec core-memory-read --category errors
   ```

## Phase 2: Extract & Deduplicate

From the gathered sources, identify facts that are **durable** —
worth remembering permanently:

- Architecture decisions ("we chose X for Y because Z")
- User preferences and personality traits
- Error patterns and their resolutions
- Operational learnings ("fleet bootstrap takes ~15 min")
- IAM/security configurations

**Skip** anything that:
- Already exists in Core Memory (same meaning, even if different words)
- Is transient (task status, current focus — that's MEMORY.md's job)
- Is trivial (greetings, acknowledgments, small talk)

## Phase 3: Write to Core Memory

For each genuinely new durable fact (max **5 per run**):

```
exec core-memory-write --fact "<concise fact>" --category <cat> --tags "t1,t2"
```

Categories: `architecture`, `operations`, `iam`, `decisions`, `patterns`, `errors`

If a fact **supersedes** an existing entry (corrects or updates it):
```
exec core-memory-write --fact "<updated fact>" --category <cat> --supersedes <existing-id>
```

## Phase 4: Update Deep Truths

After writing to Core Memory, review if any facts are so fundamental
they belong in Cortex's soul — deep, unchanging truths about the user,
the system, or the operational environment.

**Criteria for Deep Truths** (must meet ALL):
- Appears in Core Memory with high confidence
- Unlikely to change (not a version number or current state)
- Affects how Cortex should behave on every turn
- Concise enough for a single bullet point

To add a deep truth:
```
exec update-deep-truths --add "Concise unchanging truth"
```

To check current deep truths:
```
exec update-deep-truths --list
```

To remove an outdated truth:
```
exec update-deep-truths --remove "Exact text of outdated truth"
```

**Constraints:**
- Maximum 10 deep truths total
- Each must be a single line (no paragraphs)
- `update-deep-truths` enforces immutability — it ONLY modifies
  the `## Deep Truths` section at the end of SOUL.md

## Phase 5: Report

Output a summary of what you did:

```
Memory Consolidation Complete
─────────────────────────────
Sources reviewed: N files
New Core Memory entries: N
Updated entries: N
Deep Truths added: N
Deep Truths removed: N
Nothing to consolidate: (if empty run)
```

## Rules

- Max 5 Core Memory writes per run (prevents flooding)
- Max 2 Deep Truths changes per run (soul changes are rare)
- NEVER write transient state to Core Memory
- NEVER fabricate facts — only record what actually happened
- If no new durable facts exist, report "Nothing to consolidate" and exit
- This skill runs as the `temporal-memory` agent via OpenClaw cron (registered at 2am CT America/Chicago in both Prime and fleet bootstraps)
