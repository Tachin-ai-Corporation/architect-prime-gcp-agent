# Agent Design Framework

> **Status:** ASPIRATIONAL — Design framework for future multi-team fleet deployments
> **Written:** 2026-03-22
> **Last verified:** v2026.05.03.9.0

> **Design reference for building new fleet agent types.**
> Defines how to scope agent specialties, assign tools, and design delegation chains.
> Note: The current system uses OpenClaw multi-agent dispatch (`sessions_spawn`/`sessions_yield`),
> not MCP `--tools` flags. PM-led teams and Missions/Checkpoints/Tasks are planned, not yet implemented.

---

## Core Premise

An agent's reliability is inversely correlated with its tool count — not linearly, but as a cliff. Between 5–18 well-documented tools, an LLM selects correctly and consistently. Past ~25, misrouting, parameter hallucination, and tool "forgetting" increase sharply. Past 50, the agent becomes unreliable for production use.

Every design decision in this framework flows from one goal: **keep each agent in the reliable zone while ensuring it can complete its job without mid-task handoffs.**

---

## Roles

### Prime — Fleet Manager

Prime is **infrastructure, not orchestration**. Prime creates agents, upgrades them, monitors their health, manages costs, and tears them down. Prime never receives tasks, delegates work, or participates in task execution.

Think of Prime as the employee dashboard / IT admin — it provisions and maintains the workforce but doesn't assign or manage work.

### PM Agent — Team Coordinator

PM agents drive tasks, checkpoints, and missions forward within a team. A PM agent decomposes objectives into tasks, assigns them to specialists via Google Chat @-mentions, tracks progress, and reports status to humans.

PM agents coordinate — they do not execute specialist work.

### Specialist Agents — The Workforce

Specialist agents do the actual work. Each has a focused SOUL, a scoped set of tools, and awareness of teammates. Specialists receive tasks from humans or PM agents, execute end-to-end, and hand off to other specialists when the next step requires a different expertise.

### Humans — Task Originators and Escalation Targets

Humans assign work to agents directly via Google Chat. Humans are the escalation path when agents fail, when review loops don't converge, or when decisions exceed the agent's authority.

---

## Principles

### 1. Split by job function, not by service

Group tools by the *work product* the agent delivers, not by the underlying API or application. A presentation task requires Drive (find source files), Sheets (pull chart data), and Slides (build the deck). If those are three separate agents, every real task becomes a multi-agent orchestration problem before it even starts.

**Test:** Can the agent complete its assigned deliverable — start to finish — using only its own tools? If the answer is "yes, except it needs to ask another agent for one thing," that one thing should be in its toolset.

### 2. Self-contained execution

An agent should be able to complete its *assigned task* end-to-end using only its own tools. When it finishes, it delivers a result — an artifact, a link, a summary — back to whoever asked (human or agent). If a task genuinely requires a different specialty, the agent hands off to the appropriate teammate via Google Chat @-mention, passing the artifact and context needed for the next step.

**Important:** Prime is the fleet manager, not a task router. Prime hires, fires, upgrades, and monitors agents. It never receives work or delegates tasks. Humans and agents assign work to each other directly via Google Chat.

### 3. Tool budget: 8–20 per agent

This is the reliable operating range. Below 8, the agent is probably too narrow to complete a useful task. Above 20, accuracy starts degrading. Above 25 is a hard ceiling — restructure before crossing it.

When counting tools, include:
- MCP tools loaded via `--tools` flag (count per-service, not per-tier)
- CoreKit tools available via `exec` (chat-send, etc.)
- Any custom skills defined in the agent's TOOLS.md

**If a new capability would push an agent past 20 tools, that's the signal to split it into two agents** — not to add a 21st tool.

### 4. MCP service scoping

When an agent uses an MCP server (e.g., Google Workspace), load *only* the services it needs via the `--tools` flag. Never load a full tier when a subset will do.

```
# Good — scoped to job function
--tools slides docs drive

# Bad — loads everything because "it might need it"
--tool-tier complete
```

Each loaded service adds ~6–12 tools to the agent's context. Loading all 12 Workspace services dumps 100+ tools into context — far past the reliability cliff.

### 5. Narrower is better; split early

When in doubt, create two focused agents rather than one broad one. The cost of an additional agent type (one more workspace directory, one more entry in the type registry) is small. The cost of an unreliable agent that fails 20% of the time is enormous.

A good split boundary is when you find yourself writing conditional logic in a SOUL.md: "If the task is X, focus on these tools; if the task is Y, focus on those." That conditional is the seam where two agents should exist.

### 6. Handoff chains via Google Chat

Some tasks naturally require multiple specialties in sequence. Agents hand off to each other directly via Google Chat @-mentions, passing artifacts and context. A "create a polished sales deck" task might flow:

```
Human → @Data-Analyst (extract metrics, shares Sheet link)
  → @Document-Author (builds deck from metrics, shares Slides link)
    → @Design-Reviewer (polishes visuals, shares final link back to Human)
```

Each agent in the chain receives a specific artifact and context from the previous step. The handoff message should include: what was done, what artifact was produced, and what the next agent is expected to do.

**Design handoff chains explicitly.** If two agent types frequently hand off to each other, document that relationship in both agents' AGENTS.md files. The PM agent (see Teams below) formalizes these chains as part of mission planning.

### 7. SOUL.md carries the expertise; TOOLS.md carries the interface

The SOUL.md defines *what the agent knows and how it thinks* — formatting conventions, quality standards, domain expertise, behavioral guardrails. The TOOLS.md defines *what the agent can do* — available commands, MCP services, API tools.

When specializing an agent, most of the work is in SOUL.md. Two agents can share similar tool configurations but behave very differently based on their SOUL. A "Document Author" and a "Design Reviewer" might both have Slides access, but the Author's SOUL emphasizes content structure and narrative flow, while the Reviewer's SOUL emphasizes visual hierarchy, brand consistency, and layout critique.

---

## Defining a New Agent Type

### Step 1: Identify the work product

What deliverable does this agent produce? Be specific. Not "helps with documents" but "creates and edits Google Slides presentations and Google Docs reports." The work product determines which services and tools are necessary.

### Step 2: List the minimum tool surface

For each tool or MCP service, ask: "Does the agent need this to complete its deliverable without a mid-task handoff?" If no, exclude it. If it's needed for 5% of tasks, consider making that 5% a separate delegation chain rather than permanently expanding the tool surface.

### Step 3: Count and verify budget

Sum all tools (MCP + CoreKit + custom). If the count is 8–20, proceed. If under 8, the agent may be too narrow — consider whether it should be merged with a related agent. If over 20, identify the seam and split.

### Step 4: Write the workspace files

Create a new directory under `specialties/<specialty>/workspace/` with:

| File | Purpose | Guidance |
|------|---------|----------|
| `SOUL.md` | Identity, expertise, behavioral rules | Most important file. Define what the agent is an expert in, how it approaches tasks, quality standards, things it should never do. Use the `{{AGENT_NAME}}` and `{{SPECIALTY}}` template vars. |
| `TOOLS.md` | Available tools and usage instructions | List each tool with syntax and examples. Include MCP service configuration. State the tool budget explicitly. |
| `IDENTITY.md` | Name, role, project context | Lightweight. Template vars filled at deploy time. |
| `AGENTS.md` | Awareness of teammates and handoff patterns | Which agents this type commonly receives work from and hands off to. What artifacts to expect as input. What artifacts to produce as output. Required for any agent that participates in multi-agent workflows. |

Optional files (add as needed):
- `MEMORY.md` — persistent context, learned preferences, past decisions

### Step 5: Register the type

Add the new specialty to the agent type registry so `fleet-deploy --specialty <type>` resolves correctly. The registry maps specialty names to workspace directories and default VM configurations.

### Step 6: Document the handoff relationships

If this agent type participates in multi-agent workflows, document in its AGENTS.md:
- What artifacts it expects as input (and from which agent types)
- What artifacts it produces as output (and which agent types typically consume them)
- The @-mention convention for reaching this agent in Google Chat
- Whether this agent type belongs to a specific team (see Teams below)

---

## Tool Budget Reference

The following ranges are guidelines based on observed LLM tool-use reliability. Actual counts depend on tool complexity and documentation quality.

| Tool Count | Zone | Guidance |
|-----------|------|----------|
| 1–7 | Narrow | Agent may be too specialized. Consider merging with a related type unless the task is genuinely atomic. |
| 8–20 | Reliable | Target zone. Agent can complete meaningful tasks with consistent tool selection. |
| 21–25 | Degraded | Misrouting increases. Restructure by splitting the agent or removing rarely-used tools. |
| 26+ | Unreliable | Do not ship. Split into multiple agents immediately. |

### Counting MCP services

Approximate tool counts per Google Workspace MCP service (core tier):

| Service | Approximate Tool Count |
|---------|----------------------|
| Gmail | 6 |
| Drive | 5 |
| Calendar | 5 |
| Docs | 5 |
| Sheets | 8 |
| Slides | 6 |
| Chat | 3 |
| Forms | 4 |
| Tasks | 3 |
| Contacts | 3 |

These are approximate — actual counts vary by MCP server version and tier (core vs extended vs complete). Always verify with `--list-tools` after configuration.

---

## Teams

Fleet agents are organized into **teams** — small groups of specialists that work together on related objectives. Each team has a **PM agent** that coordinates work across the team.

### Team structure

A team consists of:
- **One PM agent** — drives tasks, checkpoints, and missions forward. Knows the team roster, each member's specialty, and the current state of work. Does not do specialist work itself.
- **2–6 specialist agents** — execute the actual work within their expertise. Each specialist knows about its teammates (via AGENTS.md) and can hand off directly when needed.

Teams are a logical grouping, not a technical boundary. Any agent can @-mention any other agent in Chat. Teams exist so that PM agents have a defined scope of coordination and specialists have a manageable awareness of who to hand off to.

### The PM agent role

The PM agent is a specialized agent type. Its job is coordination, not execution:
- **Task decomposition** — receives a high-level objective from a human, breaks it into tasks, and assigns each to the appropriate specialist via @-mention
- **Checkpoint tracking** — monitors progress, follows up with specialists who haven't reported back, and escalates blockers to humans
- **Mission sequencing** — knows which tasks depend on others and ensures handoffs happen in the right order with the right artifacts
- **Status reporting** — provides humans with consolidated status across the team's active work

The PM agent's tool surface is deliberately small: `chat-send`, `chat-read`, and access to a shared state store (Firestore or Sheets) for tracking task status. It does not need Workspace document tools, code execution, or any specialist tools. Its power comes from its SOUL.md — deep understanding of project management patterns, dependency logic, and when to escalate vs. when to let specialists self-organize.

### Missions, Checkpoints, and Tasks

This is the core coordination model for all agents, but especially PMs. Every piece of work maps to this three-level hierarchy:

**Mission** — the north star. A mission is a high-level objective with a clear definition of done. Missions are assigned by humans (or occasionally by other PMs coordinating across teams). A mission persists until it is completed, abandoned, or superseded.

> *Example: "Produce and distribute the Q3 investor update."*

**Checkpoints** — verifiable steps on the way to the north star. A checkpoint is a meaningful milestone with a concrete, testable completion condition — not a vague progress marker. Checkpoints are the natural points for review (by humans or review-loop agents) and for handoffs between specialists. When a checkpoint is reached, something observable has changed: a document exists, a dataset is validated, an email has been sent.

> *Example checkpoints for the above mission:*
> 1. *Q3 metrics extracted and validated (Sheet link exists, numbers reviewed)*
> 2. *Investor deck drafted (Slides link exists, content complete)*
> 3. *Deck design-reviewed and finalized (reviewer approved)*
> 4. *Update emailed to board (confirmation from Comms agent)*

Checkpoints should be codified in a **checkpoint schema** stored in the shared mission state (Firestore). At minimum, each checkpoint record should include:
- Checkpoint ID and description
- Status: `pending` | `in_progress` | `blocked` | `review` | `done`
- Assigned agent (who is currently responsible)
- Artifacts produced (links, file IDs)
- Blockers (if status is `blocked` — what's preventing progress)
- Completion evidence (how we know it's done)

**Tasks** — the work needed to reach a checkpoint. Tasks are fluid. A PM or human may define initial tasks when assigning a checkpoint, but the specialist agent working toward the checkpoint is expected to adapt — adding, reordering, or dropping tasks as the work evolves. Tasks are the agent's internal plan, not a rigid contract.

> *Example tasks under checkpoint 1:*
> - *Query the revenue Sheet for Q3 date range*
> - *Aggregate by region*
> - *Spot-check totals against the finance summary*
> - *Format as a summary table and share link*

The key distinction: **checkpoints are commitments tracked in the shared state; tasks are the agent's working plan to meet those commitments.** A PM tracks checkpoints. Individual agents manage their own tasks.

### Escalation

When an agent is unable to achieve a checkpoint, the system must escalate — not spin. The escalation pattern:

1. **Agent self-reports** — the stuck agent updates the checkpoint status to `blocked` with a clear description of what's preventing progress (missing input, permissions error, ambiguous requirements, etc.)
2. **PM detects the block** — via polling the shared mission state or receiving a direct @-mention from the blocked agent
3. **PM attempts to resolve** — if the block is a missing artifact from another agent, the PM follows up with that agent. If it's a dependency ordering issue, the PM re-sequences. If it's within the PM's coordination authority, it acts.
4. **PM escalates to human** — if the block requires a decision the PM can't make (scope change, unclear requirements, budget approval, access grants), the PM escalates to the human who owns the mission with a structured summary: what's blocked, why, what options exist, and what decision is needed.

Agents should never silently fail or loop on a blocked checkpoint. A clear escalation is always better than a degraded or incorrect result.

### Shared mission state

Missions, checkpoints, and their statuses are stored in a shared state visible to all team members and the Prime dashboard. The recommended store is Firestore, using a structure like:

```
/missions/{mission_id}
  - description, status, owner (human), assigned_pm, created_at
  /missions/{mission_id}/checkpoints/{checkpoint_id}
    - description, status, assigned_agent, artifacts[], blockers[], evidence
```

This state is the source of truth for coordination. PMs read and write it. Specialists update their checkpoint status in it. The Prime dashboard reads it for fleet-wide visibility (Prime can *observe* mission state without *participating* in task execution). Humans can view and override status at any time.

### Team sizing

Keep teams small. A PM agent coordinating 2–4 specialists is effective. A PM agent coordinating 10+ specialists will lose track of state and produce unreliable coordination. If the scope requires more specialists, create multiple teams with separate PMs, and have the PMs coordinate with each other or with a human program manager.

---

## Delegation Patterns

All delegation happens via Google Chat @-mentions. Prime is never part of a task delegation flow — Prime manages fleet infrastructure only (hire, fire, upgrade, monitor).

### Direct assignment

A human or PM agent assigns a task directly to a specialist.

```
Human → @Specialist (via Chat)
Specialist completes task → replies in Chat with result
```

This is the simplest and most common pattern. The specialist receives the request, executes using its own tools, and delivers the result in the same Chat thread. Use this whenever a single agent can complete the task.

### Sequential handoff

A task requires multiple specialties applied in order. Each agent completes its piece and hands off to the next via @-mention, passing the artifact.

```
Human → @Data-Analyst: "Pull Q3 revenue by region"
  Data-Analyst → @Document-Author: "Here's the data [Sheet link]. Build a deck with one slide per region."
    Document-Author → replies to Human: "Deck ready [Slides link]"
```

**Rules:**
- The handing-off agent includes: what it produced, a link/reference to the artifact, and a clear description of what the next agent should do
- Each specialist works within its own context — it does not inherit the full conversation history from the previous agent
- If any step fails, the failing agent reports the failure in Chat — humans or the PM agent decide how to proceed

### PM-coordinated mission

A PM agent receives a mission, decomposes it into checkpoints, assigns checkpoints to specialists, tracks progress through the shared state, and reports completion.

```
Human → @PM: "We need a Q3 investor update — data analysis, deck, and email to the board"

PM creates mission with checkpoints:
  Checkpoint 1: Q3 metrics extracted and validated
    → @Data-Analyst: "Extract Q3 metrics from [Sheet]. Produce a summary table."
  Checkpoint 2: Investor deck drafted (blocked by CP1)
    → (waits for CP1 done) → @Document-Author: "Build investor deck from these metrics [link]."
  Checkpoint 3: Deck reviewed and finalized (blocked by CP2)
    → (waits for CP2 done) → @Design-Reviewer: "Review and polish this deck [link]."
  Checkpoint 4: Update distributed (blocked by CP3)
    → (waits for CP3 done) → @Comms-Agent: "Email the final deck [link] to board@company.com"

PM → replies to Human: "Mission complete. Final deck [link]. Board notified."
```

**Rules:**
- The PM creates the mission record and checkpoint records in the shared state before assigning any work
- Each checkpoint has a clear status (`pending` → `in_progress` → `done` or `blocked`) visible to the team and the Prime dashboard
- The PM waits for dependent checkpoints to reach `done` before assigning the next — but independent checkpoints can be assigned in parallel (see parallel fan-out)
- Specialists own the *tasks* within their checkpoint — the PM does not micromanage how the work gets done, only whether the checkpoint is met
- If a checkpoint moves to `blocked`, the PM follows the escalation pattern (see Escalation above)
- Humans or PMs may assign individual checkpoints or tasks directly, including mission context so the agent understands the bigger picture

### Review loop

A creation agent produces output, then a review agent evaluates and provides feedback. The creation agent revises. Review loops happen naturally at checkpoint boundaries — they are how a checkpoint moves from `in_progress` to `done` (or back to `in_progress` with feedback).

```
@Document-Author creates draft → @Design-Reviewer: "Review this deck [link]"
  Design-Reviewer → @Document-Author: "Feedback: [structured notes]"
    Document-Author revises → @Design-Reviewer: "Updated. Please re-review [link]"
      Design-Reviewer → approves (checkpoint status → done)
```

**Rules:**
- Cap review loops at 2 iterations maximum — unbounded loops are a reliability risk and token sink
- The Reviewer produces structured feedback; it does not directly modify the artifact
- If the Reviewer approves, it signals completion and the artifact moves to the next step (or back to the human)
- The PM agent (if coordinating) decides whether to initiate a review loop based on task importance — not every task needs review

### Parallel fan-out

Multiple specialists work on independent sub-tasks simultaneously. A PM agent assigns them and collects results.

```
PM assigns in parallel:
  @Data-Analyst: "Pull revenue data"
  @SWE-Agent: "Generate API usage stats"
  @Comms-Agent: "Draft the email template"

PM collects all three results → @Document-Author: "Build the report from these inputs [links]"
```

**Rules:**
- Only use for genuinely independent sub-tasks — if Task B depends on Task A's output, they must be sequential
- The PM tracks which sub-tasks have completed and only proceeds when all are done
- Agents working in parallel do not need to be aware of each other

---

## Anti-Patterns

### The Swiss Army Agent

**Problem:** One agent with 40+ tools that "can do anything." Tool selection degrades, outputs become inconsistent, debugging is impossible because any tool might be called for any task.

**Fix:** Split by work product. If the agent's SOUL.md has sections like "When doing X..." and "When doing Y..." and X and Y use different tools, those are two agents.

### The Micro-Agent

**Problem:** An agent with 2–3 tools that can only do one atomic operation (e.g., "create a single Slides presentation from a JSON spec"). Every real task requires chaining 5+ micro-agents, making handoffs fragile and slow.

**Fix:** Expand the agent's scope to cover the full workflow for its work product. The agent should own the *thinking* and the *doing*, not just the doing.

### The PM That Does Everything

**Problem:** A PM agent that both coordinates work *and* executes specialist tasks. Its tool count balloons, its SOUL.md tries to cover coordination logic and domain expertise, and it becomes unreliable at both jobs.

**Fix:** The PM agent coordinates — it decomposes, assigns, tracks, and reports. It never creates a document, writes code, or manipulates data. If a PM is doing specialist work, a specialist agent is missing from the team.

### The Infinite Review Loop

**Problem:** A creator agent and reviewer agent bounce an artifact back and forth indefinitely, each making small changes. Token costs compound, quality improvements plateau after iteration 2, and the task never closes.

**Fix:** Cap review loops at 2 iterations. If the artifact isn't acceptable after two rounds of feedback, escalate to the human — the problem is likely in the brief, not the execution.

### The Invisible Dependency

**Problem:** Agent A works fine in isolation but silently assumes Agent B has already run (e.g., expects a file to exist in Drive that only Agent B creates). When Agent A is called without Agent B running first, it fails confusingly.

**Fix:** Make dependencies explicit. Agent A's AGENTS.md should declare its input requirements and which agent types produce them. The PM agent's coordination logic should enforce ordering. If an agent is called without its prerequisite artifacts, it should report the missing dependency clearly — not attempt the task and produce garbage.

### The Unsupervised Swarm

**Problem:** Multiple agents @-mention each other in a Chat space with no PM agent coordinating. Agents duplicate work, contradict each other, or create circular handoff loops (A hands to B, B hands to C, C hands back to A).

**Fix:** Multi-agent tasks need a PM. If more than two agents are involved in a workflow, assign a PM agent to coordinate. For simple two-agent handoffs (creator → reviewer), a PM isn't required, but the handoff pattern should still be documented in both agents' AGENTS.md files.

---

## MCP Server Deployment

Each fleet agent that uses MCP tools runs its own MCP server instance, scoped to its required services. This aligns with the existing fleet architecture where each agent has its own VM and isolated runtime.

### Configuration

MCP service scoping is configured per agent type. The workspace's TOOLS.md declares which services the agent requires. The bootstrap script reads this configuration and starts the MCP server with the appropriate `--tools` flag.

### Authentication

MCP tools that access Google Workspace authenticate via the same DWD (Domain-Wide Delegation) pattern used by existing fleet tools (`chat-send`, `chat-read`). The fleet agent's service account impersonates the agent's Workspace email using the shared DWD signer SA. No additional API keys or OAuth flows are required.

### Read-only vs. read-write

Some agent types should have read-only access to certain services. A "Data Analyst" might need to read Sheets but should never modify the source data. Use the MCP server's `--read-only` mode or service-level scoping to enforce this. Document the access level in TOOLS.md.

---

## Versioning This Document

This is a living framework. As the fleet evolves and new agent types are added, update this document to reflect:
- New patterns that emerge from production usage
- Tool budget adjustments based on observed reliability
- New anti-patterns discovered during development

Changes to this framework should be reviewed by whoever maintains the fleet architecture — it affects every agent type in the system.
