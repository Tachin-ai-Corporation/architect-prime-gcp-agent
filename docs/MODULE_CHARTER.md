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
| **Process**<br>process def | The PROVEN PATH for a recurring situation | human-descriptive outcome steps, checkpoint/approval gates, `parameters`, references to skills-by-name + project/artifacts | tool syntax → **Skill** · voice/emoji/character → **Organ/Mouth** · operator particular → **Project** or step `parameters` | captured & refined from good runs | `corekit/config/processes/`, `operator/processes/`, Firestore `processes/` |

## The two load-bearing lines

- **Organ vs Skill** (B-16/B-17): *SOULs teach cognitive patterns; skills teach procedures.* The
  SOUL says **what** to produce and how the agent should reason; the SKILL.md says **how** to drive
  the tools. Tool syntax lives *exclusively* in skills.
- **Skill vs Process** (09-SKILL.md): *"The skill defines how; the process defines when and in what
  sequence."* A skill is a reusable capability (drive Google Docs). A process is a proven ordering
  of outcomes for a situation (finalize a redlined legal doc) that *references* skills by name.

## Deciding where a thing goes

Ask, in order:
1. Is it **tool syntax** (a command, flag, API shape)? → **Skill**. Always. No exceptions in organs
   or processes.
2. Is it **who the agent is / how it reasons / its values**? → **Organ**.
3. Is it a **durable fact about a working area** (a repo, a Drive folder, a design-system doc, the
   team, the processes that apply)? → **Project** — as a resource reference, not a story.
4. Is it a **repeatable ordering of outcomes for a recurring situation**? → **Process**.
5. Is it a **one-off particular of this mission** (a specific doc id, a run's finding, a transient
   state)? → It belongs in the **Mission record / Artifact**, not in any of the four static layers.

## Anti-patterns (each seen in the repo before this charter)

- A `p-*` process id or a "9 improvement modules" taxonomy frozen into a SOUL → the SOUL should carry
  the *stance* ("follow the matching process"); the id/taxonomy lives in the Process registry / Project.
- `AGENTS.md` in a motor's immutable-files list → a Claude-Code harness concept; no such file is
  deployed to an agent. Organs reference only the files actually installed (SOUL.md, IDENTITY.md).
- `legal_review_review_procedure` as a **project context key** → a work-path; it is a **Process**.
- A specific `document_id_…`, `…-repo-state`, `…-font-pairing` in project context → mission
  particulars / transient state / design decisions; none are 40,000-ft working-area facts.
- A `firebase deploy …` block inside a process step → tool syntax; the step says "deploy via the
  governing skill," the skill holds the command.
- A "skill" with `scripts: []` that is a 7-step methodology → it governs no tools; it is a **Process**.

## Enforcement

`validate-contracts` (the CI `contracts` gate, C-19) carries the delineation checks: organ purity
(no tool flags / `p-*` ids / project tokens in organ bodies), the organ soft-lock (hash pin in
`brain/ORGAN_LOCK.json`, re-pinned by `update-organ-lock` with an `organ-change: intended` trailer),
project-context shape, and process purity. See PRODUCT_CANON **C-28**.
