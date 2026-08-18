# Prime as Fleet Author — the correctness program, scoped to the deployed layer

> **Operator constraint, and the axis this whole plan turns on:**
> *Prime never upgrades the repo. Prime becomes excellent at safe, iterative improvement of agent
> skills, souls, responsibilities and configurable items at the deployed layer. Repo code stays tight
> and minimal; the catalog of skills/roles/souls grows without limit.*
>
> Supersedes the Prime half of [PRIME_SELF_IMPROVEMENT_PLAN](PRIME_SELF_IMPROVEMENT_PLAN.md), which
> assumed a Repo Maintainer bridge the operator has now ruled out. Built on the 2026-08-17
> implementation audit, with its findings re-verified against the live tree rather than accepted.

---

## 1. What the constraint changes

The audit's central complaint is *"Prime is too weak at safe Fleet Definition changes and too powerful
at unsafe Foundation changes."* The operator's rule resolves the second half by decree: Prime has **no
Foundation authority at all, and no ambition to**. That is not a limitation to work around — it
**deletes a large branch of the audit's plan**.

**Removed from scope entirely:**

| Audit item | Why it goes |
|---|---|
| Platform Finding as a rich, evidence-carrying bridge into repo engineering | A finding is a note for a human. `fleet-config finding` already exists. Do not grow it. |
| Negotiating Prime's Foundation authority matrix (P0-14) | There is nothing to negotiate. The matrix is one row: none. |
| Separate platform-upgrader identity, brokered privileged shell, syscall profiles (most of P0-10) | Built to let Prime safely do substrate work. Prime does no substrate work. |
| Registry-backed dynamic hire generating signed provisioning manifests (P0-12 in full) | See §3 — replaced by a much cheaper split. |

**What survives, and why it survives harder than the audit argued:** every finding about whether a
release *means* anything. If Prime authors a skill improvement and the fleet can receive different
bytes than the ones approved, then Prime is not iterating — it is guessing, with a version number
attached. Those defects are not architectural tidiness; they are the difference between "Prime
improved the fleet" and "something changed."

---

## 2. Findings, re-verified against the live tree

Not accepted from the snapshot. Checked:

| # | Finding | Verified | Why it blocks *this* goal |
|---|---|---|---|
| **A** | Daemon compiles mutable `main`, stamps it with the pinned release id | ✅ `agent-content-sync.mjs:172` calls `readDefinitions()` with no ref; result stamped `desired_release` at `:206/:285` | **Prime's improvements are not reproducible.** Approve skill v5, main moves, an agent assigned to v5 gets v6 labelled v5. |
| **B** | Evaluation compares the candidate to itself | ✅ `fleet-config:443` — `compareRuns(candidateRun.results, candidateRun.results)` | **"Safe improvement" is unmeasurable.** A regression cannot fail the gate. |
| **C** | No authoring verb | ✅ `COMMANDS` has import/list/get/diff/validate/release/assign/rollback/compile/status/observe/evaluate/finding — no create/update/deprecate | **The one thing Prime is for is the one verb missing.** It can *release* content it cannot *write*. |
| **D** | Retired content never removed | ✅ `currentDigests(Object.keys(files))` hashes only desired paths, so `plan.remove` is structurally empty | **A deprecated skill never leaves the VM.** Prime can add but not subtract. |
| **E** | CI red on a stale contracts digest | ❌ **already fixed** — regenerated 2026-08-17, `contract-planes` 12/12 | Audit Phase 0 item, done. |

Also taken on the audit's word, unverified here, and worth confirming before the phase that touches
each: rollback digest semantics (P0-2), merge-failure-as-release (P0-3), apply atomicity (P0-6),
Firestore errors as empty state (P0-7), responsibility schema/scheduler drift (P0-8), dual process
authority (P0-9), and the unauthenticated setup path (P0-15).

---

## 3. The dividing line that keeps the repo small

The audit wants registry Roles to become hireable, which means generating and validating provisioning
plans, capability closures, package inventories and signed install manifests. That is a large,
permanently-growing body of repo code — exactly what the operator ruled out.

**Split the concept instead:**

| | What it is | Who changes it | Where it lives |
|---|---|---|---|
| **Composition** | which skills, which soul overlays, which responsibilities, which processes, what model policy, what prompts | **Prime**, freely and often | Fleet Definition — grows without limit |
| **Capability** | which tools exist, which IAM roles, which egress, which OS packages, which secrets a role *may* be granted | **Human, via repo release** | Foundation — grows rarely, reviewed |

A role is then **a composition over a fixed capability set**. Prime can invent "legal-reviewer" from
existing capabilities today and iterate its soul weekly. Prime *cannot* invent a role that needs a
tool nobody wrote — that is a repo change, made by a human, and the honest failure is *"no capability
set provides `X`"*.

This buys almost all of the audit's Goal-2 value at a fraction of the code, and it is the natural
shape of the operator's rule: **Prime composes; the repo supplies the parts.**

---

## 4. The code budget

"Keep code tight" is only real if it is a constraint with a number attached — and the number is only
real if there is one agreed way to take it.

> **Rule: the repo's authored line count must not grow across this program.** Every module added is
> paid for by a deletion. Where that is impossible, the growth is named and justified in the commit.

**The measurement is [`scripts/line-budget.sh`](../../scripts/line-budget.sh), and its baseline is
`474d7fd` — the commit that wrote this rule.** It counts tracked lines excluding gitignored dev
tooling (`.claude/`), generated lockfiles, and binary or vendored assets. Fixing the definition in a
script is not ceremony: the first two figures quoted for this budget disagreed by roughly 1,400 lines
purely because one included `package-lock.json` and measured from a different starting point. A
budget whose value depends on who took it cannot fail — and this program has now named that failure
mode often enough to have a rule for it ([R-11](../IMPROVEMENT_POLICY.md)).

### Standing balance

| commit | delta | what bought it |
|---|---|---|
| `5f3a0e8` | +338 | setup gate — a live internet-facing hole (Phase C item 9, pulled forward) |
| `75f2726` | +576 | `readReleaseDefinitions` — Finding A, the blocker every later phase rests on |
| `5b3916e` | +582 | that read proven against live data |
| `9488f11` | **+733** | retired content retires — Finding D |

**+733 and rising, as designed.** Phase A is all addition: it is the four defects that make a release
mean one thing, and not one of them replaces an existing authority. The debt is paid in Phase D, where
seeding a Fleet release retires `agent-types.json`, static `kit.json` persona assembly, the
composition half of `job-*.txt`, local process JSON, the legacy responsibility tools and the
dashboard's GitHub-catalog readers — all listed below. Carrying visible debt through A–C is the plan.
Carrying it unmeasured was not.

That balance is achievable because the biggest wins here are *removals* — retiring a competing
authority deletes more than the service replacing it adds.

### Delete now — advertised surface with no consumer

These cost nothing to remove and are currently lies about what the system does:

- `policy`, `projectTemplate`, `evalSuite` as authorable kinds — advertised, no complete
  import/compile/activation path. Remove from the surface until something consumes them.
- ~~`platform/deployment/packages.mjs`~~ — **the audit was wrong and so was this list.** It is 76
  live lines consumed by `importer.mjs` and a test, and it is the natural home for the capability-set
  concept in §3. Copied from the audit without checking; corrected on the way to using it.
- Dashboard `501` endpoints — dead compatibility stubs.
- Migration scripts importing deleted `corekit/lib` paths — broken, outside CI, and mistakable for
  supported tooling. Archive or delete.
- `corekit/brain/skill-author` — writes an incompatible `skill.json` and ends at a nonexistent
  "submit via Firestore skill-registry" step. Deleted by the change service, not alongside it.

### Delete after parity — competing authorities

Seed a release from each, prove parity, switch readers, freeze writes, then remove:

`corekit/config/agent-types.json` · `specialties/*/kit.json` static persona assembly ·
`infra/manifests/job-*.txt` (composition half only — the capability half stays) · local process JSON +
top-level Firestore process definitions · legacy responsibility tools · dashboard GitHub-catalog
readers.

**Not deleted:** the `catalog/` physical move, and any decomposition of `agent-brain.mjs`. Both are
legibility work the [IMPROVEMENT_POLICY](../IMPROVEMENT_POLICY.md) already ranks last (R-6, and the
standing-debt note), and the audit independently reached the same conclusion.

---

## 5. Phases

Ordered so that each phase makes the next one *provable*. Nothing here builds Prime a repo path.

### Phase A — Make a release mean one thing (blocking, ~1 week)

Without this, every later phase produces unfalsifiable results.

1. **`readReleaseDefinitions(releaseId)`** — resolve `content_ref.commit` as an immutable commit,
   check out that exact tree, verify the release digest and every referenced revision, compile only
   from it, fail closed on anything missing. Every compile, eval, sync, rollback and diff uses it.
   *(Finding A.)*
2. **Retired paths actually retire** — persist the full managed path→digest manifest, inventory the
   union of previous and desired, assert no managed extras survive. *(Finding D.)*
3. **Atomic generation switch** — stage a complete generation, verify it, switch one pointer. A crash
   leaves complete A or complete B, never a mix. *(P0-6.)*
4. **Typed storage errors** — a 404 is not an outage; an outage is not an empty world. Lifecycle reads
   and writes fail closed. *(P0-7 — and note this repo has already been bitten twice by a query
   against the wrong store reading as an empty result.)*

**Exit:** the same release id produces byte-identical content twice, a dropped skill is gone from the
VM and the runtime index, and crash injection cannot produce a mixed generation.

### Phase B — Give Prime the missing verb (~1 week)

5. **One typed change service**, exposed identically to CLI, dashboard and Prime chat:
   `fleet-config change create|update|deprecate --stdin`. The service derives the revision id,
   validates schema, computes the semantic diff, and persists an immutable change. **Prime's shell
   never writes a definition.** *(Finding C.)*
6. **Real baseline-vs-candidate evaluation** — resolve two exact commits, compile both under identical
   firmware/model/suite, run both, compare. A planted regression must fail the gate. *(Finding B.)*
7. **A minimal lifecycle**: `draft → validated → evaluated → approved → released → canary → promoted |
   rolled_back`. Idempotent, CAS-protected, schema-valid. **Canary is one agent** — no cohorts, no
   observation windows, no rollout scheduler. Those are Phase D *if the simple version proves
   insufficient*, which is the only honest reason to build them.

**Exit:** from dashboard chat, Prime turns a stated need into a typed proposal with a semantic diff,
evaluates it against a real baseline, canaries it on one agent, and promotes or rolls back — touching
no repo file.

### Phase C — Bound the blast radius (parallel with A/B, ~3 days)

The minimal, cheap version of the audit's P0-10 — sized to the operator's rule rather than to a
general security program:

8. **Motor cannot write Foundation.** Deny writes to `/opt/corekit/platform`, `bin/`, and systemd
   units; allow the workspace and content root. A negative test on a live VM proves the denial and
   proves an allowed write still succeeds.
9. **Lock the unauthenticated setup path** *(P0-15)* — a missing OAuth config must lock the app, not
   open a public administrative mode. This is a genuine internet-facing hole and is independent of
   everything else in this plan; it is here because it is P0 and nothing else will pick it up.

**Exit:** a skill-authoring mistake cannot damage the substrate, and an unclaimed dashboard cannot be
taken over.

### Phase D — Migrate the authorities, delete the old ones (~2 weeks)

10. Responsibility schema ↔ scheduler convergence *(P0-8)*; process definitions resolved from the
    pinned release only *(P0-9)*. Both are configurable items the operator explicitly wants Prime to
    own, and both currently have two authorities.
11. Seed an initial Fleet release from the legacy sources, assign every deployed agent, **prove
    parity**, switch readers, freeze legacy writes, **delete them** (§4).
12. Deliver Prime's own role/skill/soul overlays through the same release path — Prime is a normal
    registry role with protected organ firmware, not a special case.

**Exit:** every deployed behaviour answers *"which release produced this?"*, and the repo is smaller
than when the program started.

---

## 6. What I would do first

**Finding A, alone, before anything else.** It is the cheapest of the blockers and it is the one that
makes every other result trustworthy: while the daemon compiles mutable content and labels it with a
pinned release id, no evaluation, canary or rollback in this system means what it says — including the
ones used to validate the rest of this plan.

Then B (real evaluation) and C (the authoring verb), in that order: the verb is worth little until
"is this better?" can be answered honestly.

Phase C item 9 (the setup hole) should be lifted out and done immediately regardless of sequencing —
it is a live internet-facing exposure with no dependency on any of this.

---

## 7. "Is this better?" — the exemplar rubric

Operator direction: *Prime should ask for an optional example file of what better looks like for a
specific purpose, genericize it, and QA against it during iteration. If none is given, Prime derives
one from grounded web search.*

This is **not** the audit's P0-4. Two different questions, both needed:

| | question | how | cost |
|---|---|---|---|
| **Regression guard** (P0-4, existing `evalSuite`) | *did I break something?* | structural assertions over the compiled spec and its files — `file_present`, `max_chars`. No LLM, no mission. | cheap |
| **Exemplar rubric** (this section) | *is the output any good?* | a durable standard for a *purpose*, applied by cerebellum to a deliverable a real mission produced | expensive |

### Why this matters more here than it looks

Twice today a mission failed because a criterion was **invented on the spot**: prefrontal wrote
*"Deployment uses a non-deprecated authentication method"* against a tool that always warns, and
*"Cortex re-evaluates the mission's flawed premise"* — which cerebellum passed honestly while the
deliverable did not exist. Both were fixed by *rules about what a criterion may say*
(`plan-structuring` v7 and v12).

Rules constrain invention. **An exemplar removes the need to invent.** A durable, purpose-scoped
rubric gives cerebellum a standard it did not have to make up per mission — which is the actual cure
for that whole defect family, not another rule.

### The mechanism

1. **Ask, don't require.** When Prime takes on a recurring deliverable it has no rubric for, it asks
   the operator for one example of good. Optional — a missing rubric degrades to today's behaviour,
   never blocks.
2. **Genericize on ingest, and store only the generalisation.** The example file is read once,
   properties are extracted, and **the properties are what persist** — the file is not kept as a
   target.
   - **Extract:** required sections and their order, tone register, length band, evidence
     requirements, formatting conventions, what must never appear.
   - **Strip:** company and operator names, project specifics, real people, real figures, real dates.
   - *An exemplar used as a thing to match produces plagiarism and overfits the skill to one case. An
     exemplar used to derive properties produces a standard.* That distinction is the whole value of
     the genericization step, and it is the same guardrail as
     `.claude/skills/skill-improvement-loop`: never fit the skill to the test case.
3. **Provenance decides authority (B-29).**
   - `source: operator` — authoritative. May gate a promotion.
   - `source: derived` — Prime built it from grounded web search. Carries its sources, and **must be
     confirmed by the operator before it can gate anything.** It may inform freely; it may not
     silently judge.
   - **The reason is R-11.** A derived rubric that gates its own author's work is *a report authoring
     its own subject* in a new costume: Prime would invent the definition of better, then grade itself
     against it, and every result would agree with itself. An unconfirmed derived rubric is a
     hypothesis, and it is labelled as one.
4. **Home: extend `evalSuite`, do not add a kind.** `evalSuite` is on the §4 delete list precisely
   because it has no complete consumer. Giving it output-cases is **code-negative** against inventing
   a parallel rubric kind, and it keeps "how do we know this is better" in one place instead of two.

### Tests that must exist before it gates anything

- A rubric derived from an exemplar about a named company **contains none of that company's
  identifiers** — the genericization is asserted, not trusted.
- An unconfirmed `derived` rubric **cannot** gate a promotion; an `operator` one can.
- A missing rubric degrades to current behaviour and never blocks a mission.
- The same exemplar ingested twice yields the same rubric digest — the extraction is deterministic
  enough to be attributable.
- A deliverable that satisfies the rubric while being verbatim-similar to the exemplar is **flagged**,
  not passed: matching the example is the failure mode this design exists to avoid.
