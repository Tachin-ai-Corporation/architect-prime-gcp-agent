# Google Workspace Skills — Architecture

> **Owner:** bundle/skills/workspace/
> **Auth:** DWD via `ws-token` (no API keys, no OAuth tokens, no keyring)
> **Pattern:** CoreKit bash scripts → Google REST APIs → JSON output

---

## Design Principles

1. **DWD-native.** Every tool authenticates via Domain-Wide Delegation using
   the existing `dwd-token` script. No external CLIs, no OAuth token files,
   no 1Password. The agent's Workspace email IS the identity.

2. **Brain-agent scoped.** No single brain agent sees all 33 tools. Each tool
   is assigned to a specific brain sub-agent based on cognitive function:
   read tools → temporal-memory, write tools → motor, verify tools → cerebellum.

3. **Fleet-template pre-baked.** Each fleet specialty (PM, SWE, DevOps, Support,
   Legal) declares which tool groups it needs. Prime never has to decide —
   the template wires everything at deploy time.

4. **Tool fatigue prevention.** Max ~8 tools per brain agent. If a category
   has more tools than that, split read vs. write across agents.

---

## Tool Catalog (31 tools, 6 categories)

### Gmail (5 tools)
| Tool | Verb | Brain Agent | Description |
|------|------|-------------|-------------|
| `gmail-search` | READ | temporal-memory | Search threads by Gmail query syntax |
| `gmail-get` | READ | temporal-memory | Get a specific message by ID |
| `gmail-send` | WRITE | motor | Send an email (plain or HTML) |
| `gmail-draft-create` | WRITE | motor | Create a draft |
| `gmail-draft-send` | WRITE | motor | Send an existing draft |

### Calendar (5 tools)
| Tool | Verb | Brain Agent | Description |
|------|------|-------------|-------------|
| `calendar-events` | READ | temporal-memory | List events in a date range |
| `calendar-search` | READ | temporal-memory | Search events by text query |
| `calendar-create` | WRITE | motor | Create an event |
| `calendar-update` | WRITE | motor | Update an existing event |
| `calendar-delete` | WRITE | motor | Delete an event |

### Drive (9 tools)
| Tool | Verb | Brain Agent | Description |
|------|------|-------------|-------------|
| `drive-ls` | READ | temporal-memory | List files in a folder |
| `drive-search` | READ | temporal-memory | Search files by query |
| `drive-download` | READ | temporal-memory | Download a file's content |
| `drive-upload` | WRITE | motor | Upload a file |
| `drive-mkdir` | WRITE | motor | Create a folder |
| `drive-rename` | WRITE | motor | Rename a file/folder |
| `drive-delete` | WRITE | motor | Trash a file |
| `drive-move` | WRITE | motor | Move a file to another folder |
| `drive-share` | WRITE | motor | Share a file (anyone/user/domain) |

### Docs (8 tools)
| Tool | Verb | Brain Agent | Description |
|------|------|-------------|-------------|
| `docs-cat` | READ | temporal-memory | Read a document's full text |
| `docs-create` | WRITE | motor | Create a new Google Doc |
| `docs-write` | WRITE | motor | Replace/append body text |
| `docs-find-replace` | WRITE | motor | Find and replace text |
| `docs-comments-list` | READ | cerebellum | List comments on a doc |
| `docs-comments-add` | WRITE | cerebellum | Add a review comment |
| `docs-comments-reply` | WRITE | cerebellum | Reply to a comment |
| `docs-comments-resolve` | WRITE | cerebellum | Resolve a comment |

### Sheets (3 tools)
| Tool | Verb | Brain Agent | Description |
|------|------|-------------|-------------|
| `sheets-get` | READ | temporal-memory | Read a cell range |
| `sheets-update` | WRITE | motor | Write values to a range |
| `sheets-append` | WRITE | motor | Append rows |

### Contacts (1 tool)
| Tool | Verb | Brain Agent | Description |
|------|------|-------------|-------------|
| `contacts-list` | READ | temporal-memory | List contacts |

---

## Brain Agent Tool Budgets

| Brain Agent | Role | Max Tools | Workspace Tools | Rationale |
|-------------|------|-----------|-----------------|-----------|
| **cortex** | Orchestrator | 0 ws tools | _(none)_ | Dispatches to sub-agents, never calls Workspace directly |
| **temporal-research** | Web Search | 0 ws tools | _(none)_ | Only uses `agent-ask` for web grounding |
| **temporal-memory** | Recall | ≤8 | READ tools: gmail-search, gmail-get, calendar-events, calendar-search, drive-ls, drive-search, drive-download, docs-cat, sheets-get, contacts-list | Gathers information from Workspace |
| **prefrontal** | Planning | 0 ws tools | _(none)_ | Read-only planning from context, no API calls |
| **motor** | Execution | ≤12 | WRITE tools: gmail-send, gmail-draft-*, calendar-create/update/delete, drive-upload/mkdir/rename/delete/move/share, docs-create/write/find-replace, sheets-update/append | Executes all mutations |
| **cerebellum** | Verification | ≤4 | docs-comments-* | Reviews work, adds/resolves comments |

**Key insight:** temporal-memory handles ALL reads, motor handles ALL writes,
cerebellum handles review/comments. This means Cortex can dispatch:
- "What's on the calendar?" → temporal-memory
- "Send that email" → motor
- "Review the doc and add comments" → cerebellum

---

## Fleet Agent Templates

Each template declares which tool GROUPS it needs. At deploy time,
`fleet-bootstrap.sh` installs only those groups and wires them to the
correct brain agents via TOOLS.md.

### Template: PM (Project Manager)
```
groups: [gmail, calendar, drive, docs, sheets, contacts]
use_case: Full Workspace access for project coordination
```
**Total tools:** 27 (all groups, excluding docs-comments — PM doesn't review code)
**Brain load:** temporal-memory: 10, motor: 17, cerebellum: 0

### Template: SWE (Software Engineer)
```
groups: [drive]
use_case: Works locally with .md and .csv, delivers to Drive. Other agents format.
```
**Total tools:** 9
**Brain load:** temporal-memory: 3, motor: 6, cerebellum: 0

### Template: DevOps
```
groups: [drive]
use_case: Works locally with configs and scripts, delivers to Drive. Keep it lean.
```
**Total tools:** 9
**Brain load:** temporal-memory: 3, motor: 6, cerebellum: 0

### Template: Support
```
groups: [gmail, sheets, contacts, docs]
use_case: Inbox triage, ticket tracking, KB articles
```
**Total tools:** 17
**Brain load:** temporal-memory: 5, motor: 8, cerebellum: 4

### Template: Legal
```
groups: [gmail, drive, docs]
use_case: Contract review, renewals, compliance register. PM handles calendar.
```
**Total tools:** 22
**Brain load:** temporal-memory: 6, motor: 12, cerebellum: 4

### Template: Data
```
groups: [drive, sheets]
use_case: Datasets and reports. Delivers raw data. Other agents handle doc formatting.
```
**Total tools:** 12
**Brain load:** temporal-memory: 4, motor: 8, cerebellum: 0

---

## Auth: ws-token

All tools call `ws-token` to get a scoped DWD access token. `ws-token`
is a thin wrapper around the existing `dwd-token` that adds Workspace-
specific scopes:

```
ws-token --scope gmail    → gmail.readonly + gmail.send + gmail.compose
ws-token --scope calendar → calendar + calendar.events
ws-token --scope drive    → drive + drive.file
ws-token --scope docs     → documents + drive.file
ws-token --scope sheets   → spreadsheets + drive.file
ws-token --scope contacts → contacts.readonly
```

---

## File Layout

```
bundle/skills/workspace/
├── SKILL.md                          ← this file
├── ws-token                          ← shared auth helper
├── fleet-workspace-templates.json    ← template → tool group mapping
├── gmail/
│   ├── SKILL.md
│   ├── gmail-search
│   ├── gmail-get
│   ├── gmail-send
│   ├── gmail-draft-create
│   └── gmail-draft-send
├── calendar/
│   ├── SKILL.md
│   ├── calendar-events
│   ├── calendar-search
│   ├── calendar-create
│   ├── calendar-update
│   └── calendar-delete
├── drive/
│   ├── SKILL.md
│   ├── drive-ls
│   ├── drive-search
│   ├── drive-download
│   ├── drive-upload
│   ├── drive-mkdir
│   ├── drive-rename
│   ├── drive-delete
│   ├── drive-move
│   └── drive-share
├── docs/
│   ├── SKILL.md
│   ├── docs-cat
│   ├── docs-create
│   ├── docs-write
│   ├── docs-find-replace
│   ├── docs-comments-list
│   ├── docs-comments-add
│   ├── docs-comments-reply
│   └── docs-comments-resolve
├── sheets/
│   ├── SKILL.md
│   ├── sheets-get
│   ├── sheets-update
│   └── sheets-append
└── contacts/
    ├── SKILL.md
    └── contacts-list
```

---

## Known Limitations (from gog-mcp research)

1. **Docs comment anchoring** — Google API does NOT support creating
   comments anchored to specific text positions. Comments created via
   API appear as document-level comments. The `kix.*` element IDs
   required for anchoring are internal and never exposed by any API.

2. **Docs image insertion** — The Docs API `InsertInlineImage` requires
   a URL that Google's servers can fetch. Pipeline: `drive-upload` →
   `drive-share` (anyone:reader) → `docs-find-replace` with image URL.
   Local file paths do not work.

3. **Sheets formatting** — The Sheets API v4 supports cell formatting
   but requires `batchUpdate` with `repeatCell` requests. Initial
   implementation covers values only; formatting tools are a future add.

4. **Calendar attendees** — Adding attendees sends invitation emails.
   Fleet agents should use calendar-create with attendees only when
   explicitly instructed by a human or mission checkpoint.
