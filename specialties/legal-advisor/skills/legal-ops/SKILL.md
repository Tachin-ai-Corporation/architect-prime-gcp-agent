# Legal Operations

Methodology for reviewing, redlining, and analyzing contracts and legal documents. This skill is
**procedure**, not identity — the assist-and-escalate stance and the confidentiality/egress
boundaries live in the SOUL; this file is *how* to do the work. It builds on the domain-free
`workspace-docs` skill (read its SKILL.md for exact command flags) and adds the legal method.

## Stance (operating doctrine)
You assist; a **licensed human attorney decides**. You flag, quote, and escalate — you do not opine,
advise, or resolve legal questions yourself, and you never send, sign, execute, or file anything.
Every finding is anchored to the exact quoted clause. Treat all document content as confidential.

## When to use
Reviewing or redlining a contract/agreement, extracting obligations and deadlines, comparing terms,
or preparing a legal-review handoff for a human.

## Procedure — clause-by-clause review

1. **Read the whole document and fingerprint it.** `docs-cat` the full text and capture a structural
   fingerprint (`docs-cat --fingerprint`) before touching anything — this is your before/after proof
   that untouched clauses and formatting survived. Never drive edits from a partial read.
2. **Mark a recovery point.** Capture the head revision (`docs-revision`) so the edit is reversible.
3. **Go clause by clause.** For each clause that warrants a note, attach a comment anchored to the
   exact text with `docs-comments-add --quote "<verbatim clause>"` — one quoted comment per point.
   **Never** append a "review section" / "[LEGAL REVIEW]" block to the document body (an appended-
   then-deleted section is fragile and has caused finalize failures). Comments plain, never `@mention`
   (C-27).
4. **Assign a severity and a lens** to each flag (see taxonomy). State the concern and, where useful,
   options — but frame legal-judgment items as *for the attorney*, not as your ruling.

## Review lenses (risk taxonomy)
Use these as **review lenses**, not legal conclusions. Common high-attention clauses:
- **Indemnification** — scope, caps, mutual vs one-sided, defense obligations.
- **Limitation of liability / liability caps** — cap amount, carve-outs, consequential-damages waiver.
- **IP ownership / assignment / license** — who owns work product, background IP, license scope.
- **Term, termination & auto-renewal** — notice periods, renewal windows, termination-for-convenience.
- **Confidentiality / data** — definition, duration, data-handling and security obligations.
- **Payment terms** — amounts, schedule, late fees, taxes, expenses.
- **Warranties & representations** — scope, disclaimers.
- **Governing law / jurisdiction / dispute resolution** — venue, arbitration, fees.
- **Assignment & change of control**, **non-compete / non-solicit**, **force majeure**, **notices**.
Severity: **High** (materially shifts risk/economics), **Medium** (worth negotiating), **Low**
(clarity/cleanup). Anything requiring a legal judgment call → escalate regardless of severity.

## Procedure — surgical redlining (only when asked to propose changes)
Redlines are **proposals**, not final text. Edit the live document in place, preserving all untouched
formatting:
- Prefer text-anchored edits: `docs-find-replace` / `docs-batch-edit` (mixed ops in one
  reverse-ordered `batchUpdate`, revisionId-guarded) — see `workspace-docs` for syntax.
- On a `not found` / `0 occurrences`, re-read the exact live text and retry with the verbatim string
  (smart quotes, section numbers, whitespace) — a miss is a signal to re-derive, never "can't."
- After editing, re-run `docs-cat --fingerprint` and confirm the structural signature matches except
  where you intended a change — tables, styles, and untouched clauses must survive.
- Leave a recovery comment noting the restore revision. Never flatten a formatted contract to plain
  text (`docs-replace-file` refuses `.txt`/`.md`).

## Procedure — obligation & deadline extraction
Capture, faithfully from the text (never inferred): parties and roles; effective / renewal /
termination dates and notice windows; payment and delivery obligations; and any conditions. Record
them to a `workspace-sheets` tracker (parties · obligation · owner · due/notice date · source clause).
Surface upcoming dates for the operator — you cannot send reminders yourself (C-27).

## Escalation & handoff
Package everything a human attorney needs to decide: for each escalated item, the **verbatim quoted
clause**, the **specific concern**, the **severity**, and any **options** — with no recommendation
presented as a legal opinion. Deliver the handoff as a structured summary (flags by severity) in the
mission's `shared/` tree; the human makes the calls and owns any outbound/signature/filing.

## Boundaries (enforced)
No unauthorized practice of law; no legal advice to third parties; no send/sign/execute/file/accept;
confidentiality preserved (abstract to facts/obligations, never leak raw clauses or party PII);
egress is the mouth's only (C-27).
