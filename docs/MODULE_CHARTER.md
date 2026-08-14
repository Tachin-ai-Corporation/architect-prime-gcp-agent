# Module Charter — What Goes Where

> The normative rule is **C-28** in [PRODUCT_CANON](PRODUCT_CANON.md). This document is the
> operational map it points to: the four content layers, what each holds, and — most usefully —
> what each must **never** hold, with the layer that content belongs in instead.

The product's authored content lives in four layers. Each answers exactly one question. They
stratify by **volatility**: organs are the frozen identity core; skills, projects, and processes
are the fluid layers that carry all iteration.

| Layer | Answers | Holds | Never holds → goes to | Volatility | Lives in |
|---|---|---|---|---|---|
| **Organ**<br>SOUL / IDENTITY | WHO the agent is + HOW it thinks | character, values, decision bias, epistemic discipline, output contract, *how to find skills* | tool syntax → **Skill** · work-path or process id → **Process** · project fact/taxonomy → **Project** · harness concept (AGENTS.md) → *nowhere* | **static — soft-locked** | `brain/**`, `specialties/*/brain/*/SOUL_APPEND.md` |
| **Skill**<br>SKILL.md + scripts | HOW to use a capability | tool commands, flags, per-tool multi-step procedure, error recovery, tool-usage examples | character → **Organ** · when/sequence work-path → **Process** · operator/project particular → **Project** | iterated as tools evolve | `skills/`, `specialties/*/skills/` |
| **Project**<br>Firestore `projects/{id}` | WHERE work happens (the working area) | 40,000-ft name/goal/description, `team`, durable resource references (`{kind,ref,summary}`), `standardProcesses[]` | mission particular/instance → **Artifact/Mission record** · history/failure-mode → *nowhere (or a Process learning)* · transient state → *nowhere* · process/task steps → **Process** | iterated as the area evolves | Firestore `projects/{id}` |
| **Process**<br>narrative playbook | WHAT has worked for a recurring kind of work | a contextual pattern **narrative** (prose), a one-line description, recall cues (`intent_keywords`); recalled into the agent's own plan as a prior | tool syntax → **Skill** · rigid steps / agent-per-step / checkpoint & approval gates → **the agent's own plan** · voice/emoji/character → **Organ/Mouth** · operator particular → **Project** or the Mission | agent-owned; captured & refined from good runs | Firestore `processes/` (global living library); seeds in `corekit/config/processes/`, `operator/processes/` |

## The two load-bearing lines

- **Organ vs Skill** (B-16/B-17): *SOULs teach cognitive patterns; skills teach procedures.* The
  SOUL says **what** to produce and how the agent should reason; the SKILL.md says **how** to drive
  the tools. Tool syntax lives *exclusively* in skills.
- **Skill vs Process** (09-SKILL.md): *A skill teaches HOW to drive a tool; a process narrates WHAT
  has worked for a recurring kind of work.* A skill is a reusable capability (drive Google Docs),
  carrying tool syntax. A process is a contextual pattern **narrative** (how a redlined legal doc has
  been finalized well before) — no tool syntax, no rigid sequence; the agent recalls it into its own
  plan and adapts it.

## The process ↔ memory boundary

A playbook is remembered know-how, so it must be told apart from the memory tiers it sits beside. (These
tiers are a separate axis from the four content layers: a Process is an authored content layer; the
memory tiers are the agent's living state.)

- **Process (playbook)** — a *named, shareable, reusable how-to narrative*: "how a recurring kind of
  work is done well." Lives in the one global `processes` library; every agent recalls and evolves it.
- **Working memory** (`MEMORY.md`) — the transient scratchpad, pruned relentlessly.
- **Core memory** — an atomic durable fact, actively retired and superseded.
- **Deep truth** (`SOUL`) — a behavioral constraint, changed rarely and only on multi-session evidence.

The test: if it is *a fact*, it is memory; if it is *a constraint on behavior*, it is a deep truth; if
it is *a named narrative of how a kind of work goes well*, it is a Process.

## Deciding where a thing goes

Ask, in order:
1. Is it **tool syntax** (a command, flag, API shape)? → **Skill**. Always. No exceptions in organs
   or processes.
2. Is it **who the agent is / how it reasons / its values**? → **Organ**.
3. Is it a **durable fact about a working area** (a repo, a Drive folder, a design-system doc, the
   team, the processes that apply)? → **Project** — as a resource reference, not a story.
4. Is it a **pattern of how a recurring kind of work is done well**, worth remembering as a narrative
   to adapt (not a rigid sequence to run)? → **Process**.
5. Is it a **one-off particular of this mission** (a specific doc id, a run's finding, a transient
   state)? → It belongs in the **Mission record / Artifact**, not in any of the four static layers.

## Anti-patterns (each seen in the repo before this charter)

- A `p-*` process id or a "9 improvement modules" taxonomy frozen into a SOUL → the SOUL should carry
  the *stance* ("recall a matching playbook and adapt it into your own plan"); the narrative lives in
  the Process library, the taxonomy in the Project.
- `AGENTS.md` in a motor's immutable-files list → a Claude-Code harness concept; no such file is
  deployed to an agent. Organs reference only the files actually installed (SOUL.md, IDENTITY.md).
- `legal_review_review_procedure` as a **project context key** → a work-path; it is a **Process**.
- A specific `document_id_…`, `…-repo-state`, `…-font-pairing` in project context → mission
  particulars / transient state / design decisions; none are 40,000-ft working-area facts.
- A `firebase deploy …` block inside a process narrative → tool syntax; the narrative names the kind
  of work ("deploy via the governing skill"), the skill holds the command.
- A "skill" with `scripts: []` that is really a narrative of how a kind of work is done → it governs no
  tools; it is a **Process** (a playbook narrative).

## Enforcement

`validate-contracts` (the CI `contracts` gate, C-19) carries the delineation checks: organ purity
(no tool flags / `p-*` ids / project tokens in organ bodies), the organ soft-lock (hash pin in
`brain/ORGAN_LOCK.json`, re-pinned by `update-organ-lock` with an `organ-change: intended` trailer),
project-context shape, and process purity. See PRODUCT_CANON **C-28**.
