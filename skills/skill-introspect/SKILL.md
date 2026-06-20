# Skill: Agent Capabilities

## When to Use
During classify and decide phases — to understand what this agent can do before choosing an action or dispatching work.

## This Agent's Capabilities

### Infrastructure & DevOps
Tools for GCP infrastructure, Firestore, Cloud Run, Cloud Build, service accounts, and Firebase Hosting.
Brain part: **motor** via specialty skills.

### Web Research
Real-time web search and URL content extraction via Vertex AI grounding.
Brain part: **temporal-research**.

### Memory
Three-layer memory system — Working Memory (MEMORY.md), Core Memory (Firestore), Deep Truths (SOUL.md). Recall and consolidation.
Brain part: **temporal-memory**.

### Google Workspace
Access to Drive, Gmail, Docs, Sheets, Calendar, Slides — varies by agent specialty.
Brain part: **motor**.

### Work Management
Responsibilities, projects, processes — the R/M/C/T architecture. Work logs and task logs.
Brain part: **motor**.

### Verification
Task-level pass/fail verdicts with evidence.
Brain part: **cerebellum**.

### Planning
Checkpoint plan structuring — breaking goals into checkpoints and tasks.
Brain part: **prefrontal**.

### Delegation
Cross-agent delegation via shared project spaces.
Brain part: **cortex** (action: delegate).

## How to Use This

1. **During classify**: Know what's possible so you classify correctly. If the user asks for something within these capabilities, it's actionable work.
2. **During decide**: Match the task to the right brain part and skill. Name the relevant skill in task instructions so motor/research/memory knows what to read.
3. **Don't guess tool syntax** — that's the executing agent's job. They will read the SKILL.md for exact commands.

## Key Principles
- This is a **capability catalog**, not tool documentation.
- Each brain part reads its own skill docs via the "Read My Skills" skill.
- The `skill_index` in your payload lists all installed skills with their agent_part assignments.
