# Baseline Agent Role: Legal Advisor

> **Version:** 0.2
> **Status:** IN IMPLEMENTATION — decisions locked (2026-07-24): **scope = role + `legal-ops` skill only** (no `p-legal-review` process, no responsibility in v1); **title = "Legal Advisor"** (the assist-not-advise boundary is carried entirely by the SOUL + is therefore made load-bearing there); **repo-only** (no live agent hired this pass — deploy later via `fleet-deploy --specialty legal-advisor`). Phases 4 (process) and 6 (responsibility) are deferred.
> **Ownership:** Human maintainers via CODEOWNERS.
> **Canon alignment:** A new role is a **specialty bundle** — pure **C-28 layer separation** is the whole design: identity → SOUL appends, procedure → skill, workflow → process, a specific matter → project (runtime). Preserves **C-27** (mouth is the sole egress — the advisor reads and drafts, never sends/files), **B-17** (zero tool syntax in SOULs), organ soft-lock (**C-28**). Fulfils the reservation already written into the repo: *"the docs skill carries ZERO legal/domain knowledge (C-28 — redline flow belongs in a future prime-process + legal agent-personality)"* ([.agents/rules/project-context.md](../../.agents/rules/project-context.md)).

## Objective

Add **`legal-advisor`** as a baseline agent role: a **legal-operations assistant** (paralegal-style) that reviews contracts and legal documents, drafts surgical redlines, extracts obligations/dates/parties, flags risk clause-by-clause, and organizes matters — and **always escalates substantive legal judgment to a licensed human attorney**. It assists and surfaces; it never renders a binding legal opinion, practices law, or takes an irreversible legal action on its own.

This is the role the codebase was built toward: the doc tooling was deliberately kept domain-free (redline *mechanics* in `workspace-docs`, redline *flow* and *judgment* reserved for this role). Nothing legal ships in a generic skill — it all lands in the new bundle.

## The load-bearing design decision: assist, don't advise (human-in-the-loop)

A "legal advisor" agent must be framed responsibly, and that framing is baked into the SOUL + Deep Truths, not left implicit:

- **No unauthorized practice of law.** The agent is an *internal legal-ops tool for the operator*. It does not hold itself out as a lawyer, does not give legal advice to third parties, and does not present its output as a legal opinion. Substantive judgment (enforceability, "should we accept this term", legal risk calls) is **flagged for a licensed attorney**, never decided by the agent.
- **Human approves every consequential act.** Reviewing, drafting redlines, and summarizing are the agent's lane. Sending to a counterparty, signing, filing, or accepting terms are **not** — those route through the mouth/approval gates (C-27) and a human.
- **Confidentiality.** Legal documents are sensitive; the agent abstracts them to facts/obligations/risks in anything shared, never leaks raw clauses or party PII to other agents, and egress is the mouth only (mirrors the assistant's "mailbox contents are sensitive" Deep Truth).
- **Flag, don't foreclose (B-34).** A clause it cannot resolve is escalated with the exact quoted text and the specific concern — never "this contract is unacceptable" as a self-made verdict, and never a silent drop.

> **Naming note.** "Advisor" can imply giving legal advice. Recommend the *title* signal assist-not-advise even if the id stays `legal-advisor` — e.g. title **"Legal Operations"** or **"Contract Analyst"**. Open decision below.

## Verified foundations (how a role is defined — mapped, all paths real)

The factory is **data-driven by convention**: bootstrap, install, and the dashboard are generic per-specialty, so a new role needs **no** changes to `assemble-persona`, `install.sh`, `fleet-bootstrap.sh`, `fleet-deploy`, or any `app/` route.

| Fact | Where | Consequence |
|---|---|---|
| One role registry — a `types[]` array of role objects | `corekit/config/agent-types.json` (11 roles today; shipped to VM via `infra/manifests/base.txt`) | Add one object; it's the gate the dashboard + `fleet-hire` resolve against |
| A role = a `specialties/<id>/` bundle (kit.json, responsibilities, workspace/MEMORY.md, `brain/{cortex,motor,cerebellum}/SOUL_APPEND.md`, `skills/<skill>/`) | `specialties/assistant/**` (template) | Create the parallel `specialties/legal-advisor/` tree |
| Personas assemble generically: `assemble-persona` appends each `SOUL_APPEND.md` onto the base organ SOUL | `corekit/brain/assemble-persona` | No code edit — the append files ARE the work |
| Specialty append hashes are pinned in the organ soft-lock | `brain/ORGAN_LOCK.json` (count 53) + `corekit/system/update-organ-lock` | Re-pin after adding the 3 appends (→ 56), `organ-change: intended` trailer — else `validate-contracts` fails |
| Per-role install manifest, layered base → role-fleet → `job-<id>.txt` | `infra/manifests/job-assistant.txt` (template) | Create `job-legal-advisor.txt` |
| Deploy passes specialty as VM metadata; bootstrap reads it generically | `fleet-deploy --specialty <id>`, `fleet-bootstrap.sh` | Zero deploy-script edits — role works once the bundle is on `main` |
| Dashboard reads roles from GitHub raw, driven by `agent-types.json` (no hardcoded list) | `app/src/app/api/agent-types/**` | Role appears automatically; no app changes |
| **No** legal specialty/skill/process exists today; legal has only been a *test workload* | `Glob **/*legal*` → none; `p-legal-review`/`legal-processes` are owner **Firestore** data, not repo | Everything here is net-new — nothing to inherit/break |
| Redline *mechanics* already exist, domain-free and reusable | `skills/workspace-docs` — `docs-batch-edit`, `docs-comments-add --quote`, `docs-section-delete`, `docs-cat --fingerprint`, `docs-revision` (Safe Live-Edit) | `legal-ops` is *methodology over existing tools* — no new executables |

## Layer purity (C-28) — where each piece of "legal" lives

| Legal content | Layer | File |
|---|---|---|
| Who the advisor **is** — careful, precise, risk-aware, escalates judgment, cites the clause; the UPL/confidentiality/no-binding-action boundaries | **SOUL appends** (identity) | `specialties/legal-advisor/brain/{cortex,motor,cerebellum}/SOUL_APPEND.md` + Deep Truths |
| **How** to review a contract — clause-by-clause method, risk taxonomy, surgical-redline procedure (reusing `workspace-docs` tools), obligation/date/party extraction, escalation criteria | **Skill** (procedure) | `specialties/legal-advisor/skills/legal-ops/SKILL.md` |
| The repeatable **workflow** — read → clause review → risk-flag → redline draft → human-review handoff, checkpoint-verified | **Process** (workflow) | `corekit/config/processes/p-legal-review.json` (recommended) |
| A specific **matter** (e.g. "Acme MSA review") | **Project** (runtime) | Firestore — *not repo*; created per engagement |

No legal knowledge leaks into any generic organ or shared skill; `workspace-docs` stays domain-free.

## Phases

### Phase 1 — Role registry (`corekit/config/agent-types.json`)
Add one `types[]` entry, mirroring `assistant`:
```json
{
  "id": "legal-advisor",
  "aliases": ["legal", "counsel", "paralegal"],
  "title": "Legal Operations",
  "glyph": "⚖️",
  "accent": "#b45309",
  "specialty": "Contract & document review, clause-by-clause risk flagging, surgical redlining, obligation/deadline extraction, matter organization — assist-and-escalate, human attorney decides",
  "emailPattern": "legal-agent-{name}",
  "skills": ["web-search", "workspace-drive", "workspace-docs", "workspace-gmail", "workspace-sheets", "skill-introspect", "memory-consolidate", "legal-ops"],
  "brain": true
}
```
Skill rationale: **docs** (contracts are Google Docs — central), **drive** (find/organize matter files), **gmail** (read incoming contracts — read-only, C-27), **sheets** (obligation/deadline tracker), plus base introspect/memory + the specialty `legal-ops`.

### Phase 2 — Specialty bundle (`specialties/legal-advisor/`)
- `kit.json` — dashboard metadata (`base_skills`, `specialty_skills:["legal-ops"]`, `brain_appends:["cortex","motor","cerebellum"]`).
- `workspace/MEMORY.md` — 3-line seed.
- `responsibilities-legal-advisor.json` — **empty for v1** (`{"version":1,"responsibilities":[]}`); an optional periodic *deadline/renewal scan* responsibility is a fast-follow (Phase 6).
- `brain/cortex/SOUL_APPEND.md` — **Decision bias:** precision over speed; every review is clause-anchored; escalate substantive judgment to a human attorney with the quoted text and the specific concern; never accept/reject terms autonomously; outbound is the mouth's (read incoming, draft redlines, surface for delivery — never send/sign/file).
- `brain/motor/SOUL_APPEND.md` — **Operating character:** works surgically on the live document (preserve formatting; the Safe Live-Edit Protocol), comments carry the exact quoted clause, redlines are proposals not final text, always leaves a recovery point; no tool syntax (B-17).
- `brain/cerebellum/SOUL_APPEND.md` — **Verification bias:** a review must show each flagged clause quoted with its concern and severity; a redline must show the before/after with formatting preserved (`docs-cat --fingerprint`) and a recovery point; reject any "the contract is fine/unacceptable" verdict presented as legal conclusion rather than a flagged-for-human item; reject any claim of a sent/signed/filed document (not an agent capability).

### Phase 3 — `legal-ops` skill (`specialties/legal-advisor/skills/legal-ops/`)
Methodology over the existing `workspace-docs` tools (mirror `calendar-ops`: `scripts: []`, `agent_part:"motor"`, `origin:"specialty"`). `SKILL.md` codifies:
- **Clause-by-clause review** — one quoted comment per clause via `docs-comments-add --quote`, never an appended "review section" (the p-legal-review over-constraint lesson).
- **Risk taxonomy** — severity levels + common flags (indemnity, liability caps, IP assignment, termination, auto-renewal, governing law, confidentiality, payment terms) as *review lenses*, not legal conclusions.
- **Surgical redlining** — propose changes in-place with `docs-batch-edit` (reverse-ordered, revisionId-guarded), formatting preserved, verified with `docs-cat --fingerprint`, recovery comment left.
- **Obligation/deadline extraction** — parties, effective/renewal/termination dates, payment and delivery obligations → a `workspace-sheets` tracker.
- **Escalation criteria** — exactly which findings must be handed to a human attorney (anything requiring a legal judgment call), and how to package them (quoted text + concern + options, no recommendation-as-opinion).

### Phase 4 — `p-legal-review` process (`corekit/config/processes/p-legal-review.json`) — recommended
A first-class, checkpoint-verified redline workflow: (1) read the doc fully with a fingerprint; (2) clause-by-clause review → quoted comments + a risk register; (3) draft surgical redlines in-place; (4) extract obligations/deadlines to a tracker; (5) produce a **human-review handoff** summarizing flags by severity with quoted text. Learns from the prior over-constrained version: **flag-and-hand-off, never block**; the human attorney makes the calls. (+1 line in `infra/manifests/base.txt`.)

### Phase 5 — Manifest + soft-lock
- Create `infra/manifests/job-legal-advisor.txt` (mirror `job-assistant.txt`): responsibilities → `corekit/responsibilities-job.json`; the 3 SOUL appends → `corekit/specialties/legal-advisor/brain/<organ>/SOUL_APPEND.md`; the `legal-ops` skill files; and the workspace-docs/drive/gmail/sheets executables the role uses.
- Re-pin `brain/ORGAN_LOCK.json` via `corekit/system/update-organ-lock` (adds 3 hashes → count 56); commit with `organ-change: intended`.

### Phase 6 — (optional fast-follow) deadline/renewal responsibility
A cron/triggerable responsibility that scans active matters for upcoming contract deadlines/renewals and surfaces them (role-appropriate, mirrors the assistant's time-sensitivity focus). Deferred from v1.

### Phase 7 — Deploy + validate
Hire an instance: `fleet-deploy --name <n> --specialty legal-advisor`. Validate: persona assembles (3 legal appends present on the organ SOULs), the dashboard shows the role, and a **test contract-review mission** produces clause-anchored comments + a surgical redline with formatting preserved + a human-handoff summary — and correctly **escalates** a judgment-call clause instead of deciding it. Verify the boundary: no claim of sending/signing; confidentiality respected.

## Consolidated file surface

**CREATE:** `specialties/legal-advisor/{kit.json, workspace/MEMORY.md, responsibilities-legal-advisor.json, brain/cortex/SOUL_APPEND.md, brain/motor/SOUL_APPEND.md, brain/cerebellum/SOUL_APPEND.md, skills/legal-ops/SKILL.md, skills/legal-ops/skill.json}`; `infra/manifests/job-legal-advisor.txt`; (recommended) `corekit/config/processes/p-legal-review.json`.
**EDIT:** `corekit/config/agent-types.json` (+role); `brain/ORGAN_LOCK.json` (re-pin); (if process) `infra/manifests/base.txt` (+1 line).
**NO EDITS:** `assemble-persona`, `install.sh`, `fleet-bootstrap.sh`, `fleet-deploy`, `fleet-hire`, all `app/` — generic/data-driven.

## Open decisions (for you)
1. **Scope of v1** — (a) role + `legal-ops` skill only; (b) **recommended:** + `p-legal-review` process; (c) + the deadline responsibility too.
2. **Title/framing** — keep id `legal-advisor` but pick a title: "Legal Operations" / "Contract Analyst" / "Legal Advisor". (Recommend a non-"advisor" title to signal assist-not-advise.)
3. **Deploy an instance now?** Land the repo role only, or also hire + validate a live legal-advisor agent this pass.
4. **Skill set** — confirm docs+drive+gmail+sheets (drop any you don't want; add none that carry no legal need).

## Rollout & measurement
Each phase: author → `validate-contracts --repo` clean (organ-purity, organ-lock, layer-purity) → version-prefixed commit(s) → deploy a canary legal-advisor → the validation mission above → note. Acceptance: a real contract review runs end-to-end producing clause-anchored redlines with formatting intact and a human-review handoff, and the agent escalates (not decides) a legal judgment call. Fully reversible (delete the bundle + registry entry + manifest; revert the lock).
