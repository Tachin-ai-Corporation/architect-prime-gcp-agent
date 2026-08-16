# Improvement Policy — What We Optimise, Where, and What Counts as Done

> **Scope.** This governs changes to the *core framework*: `platform/`, `corekit/`, `infra/`,
> `skills/`, `specialties/`, `test/`, `tests/`, `app/`. It sits under [PRODUCT_CANON](PRODUCT_CANON.md)
> (the walls) and [BRAIN_CANON](BRAIN_CANON.md) (the gradient), and beside
> [MODULE_CHARTER](MODULE_CHARTER.md) (what goes where). Those three say what the system *is*.
> This one says **where to spend effort and how a change earns its way in**.

Everything below was learned the expensive way. Each rule names the defect that produced it, because
a rule without its incident gets deleted by the next person who finds it inconvenient.

---

## 1. The ordering principle

> **Optimise where a defect is invisible, not where the code is ugly.**

`platform/runtime/agent-brain.mjs` is 5,614 lines and openly in tension with **B-18** (thin
orchestrator spine over single-purpose libraries). It is also the most exercised file in the repo:
every mission runs through it, and it is covered by hundreds of tests plus a live canary fleet. A
defect there announces itself within one mission.

`corekit/system/identity-scan.mjs` was 100 lines and scanned four of twelve trees. It reported OK for
months while `platform/`, `skills/`, `specialties/`, `docs/` and both test trees were never read at
all. When the scope was widened it immediately found a dozen real operator addresses.

Length is not risk. **Silence is risk.** Rank work by how long a defect could live undetected:

| Rank | Class | Why it comes first | Example |
|---|---|---|---|
| 1 | **Checks that can pass vacuously** | A broken check reads as proof. Nothing downstream can catch it. | scan scoped to an allow-list; a suite that matched zero files |
| 2 | **Paths only a fresh deploy exercises** | Upgrades never run them, so a break hides until the next hire | bootstrap ordering; `skill-setup`; install.sh sweeps |
| 3 | **Instructions shipped to agents** | Wrong the *first* time they run, and the agent's recovery costs iterations | `SKILL.md`, organ SOULs, tool `--help` text |
| 4 | **Terminal-state handling** | Produces a confident wrong answer rather than an error | false-complete, unarticulated `blocked` |
| 5 | **Hot runtime code** | Loud, well-covered, canary-proven | the daemons, the executor |
| 6 | **Structure and naming** | Costs churn, buys legibility | directory moves |

A ranked-6 improvement is not forbidden. It is simply never the answer to "what should we do next".

---

## 2. Rules, and the incidents behind them

### R-1. A scope is a deny-list, never an allow-list

An allow-list of directories does not report reduced coverage — **it reports success**. Every tree
added after the list was written is silently outside it.

This repo has been bitten five separate times: `contract-liveness`, `primitive-contracts`, CI's `.mjs`
syntax job, the depth-shaped `.gitattributes` rules, and `identity-scan`. In each case the check was
green while covering a fraction of what it named.

**Do:** scan everything, exclude by explicit pattern with a written reason.
**Never:** exclude a whole tree to spare one file. `test/identity-scan.test.mjs` must contain
rejectable addresses to prove rejection, so *that one file* is exempt — not `test/`.

### R-2. A check that matches nothing fails

Silence must never read as proof. Every scanner returns `ok: false` when its file list comes up empty,
and every suite over a discovered set asserts a floor on the size of that set.

> The dead secret-scanner passed every logic test it had. It was scanning zero files.

### R-3. Presence is not sufficiency

`validate-contracts` checks that every declared command *appears* in its `SKILL.md`. It does not check
that the documented invocation is *complete*. A live mission ran `docs-create-branded --title … --content …`,
got `Need --folder`, and had to recover — the flag is in the skill, just not marked required.

When adding a check, ask what the weaker version of it would let through, and say in the check's own
comment which of the two it is.

### R-4. Verification is re-derivation, not recognition (B-28)

An agent reporting success is evidence about the agent, not about the artifact. Every QA claim in this
repo is made by fetching the thing: read the doc back, read the sheet back, `curl` the URL.

> Millie reported a doc created with three checklist items. `docs-cat` on the id confirmed it. The
> report was true — but the confirmation is what makes it a fact.

Corollary: **a verification window shorter than the thing being measured reports a regression that is
not there.** A correct fix was nearly reverted because a 9-second API call was watched for 6 seconds.

### R-5. Finish the migration or gate the half of it you did

`docs/`, `github-pr/` and `secrets/` tools moved to per-run `mktemp` scratch dirs. Twenty tools in
`calendar/`, `drive/`, `gmail/`, `sheets/` and `slides/` did not. Nothing checked, so it stayed
half-done — until a fixed `/tmp/sheets-response.json` owned by root made `sheets-get` exit 23 and
print *nothing at all*, because `set -euo pipefail` killed it before `die()` could speak.

A partially-applied pattern is a defect with a countdown. Either finish it in the same change, or land
a gate that fails on the remainder so the countdown is visible.

### R-6. Prefer the enforced boundary to the expressive directory

Moving `skills/`, `specialties/` and the config catalogs under `catalog/` would make the layer
boundary visible in the tree. That boundary is *already* stated in [MODULE_CHARTER](MODULE_CHARTER.md)
and *already* enforced by `test/boundaries.test.mjs`. The move costs 494 manifest lines across four
destination roots, five runtime readers, and a C-28-governed organ edit — and its failure mode is an
agent that boots healthy with **no capabilities**, the quietest failure this system can produce.

**A directory name is a weaker version of a test that already passes.** When structure and enforcement
disagree, strengthen the enforcement. When they agree, leave the structure alone.

*(This is the standing decision on the `catalog/` move: scoped out, not forgotten. Revisit only if the
boundary starts being violated in ways `boundaries.test.mjs` cannot see.)*

### R-7. Terminal states carry their handoff information

A `blocked` or `needs_input` exists to hand a problem to a human. A handback with no information is a
dead end that looks like a result.

> A mission discovered there was no tool to create a spreadsheet, said so precisely
> — "Provide the motor agent with a functional tool or command to create Google Sheets" —
> and terminated with output "Blocked on external dependency." and blocker "Unknown blocker".
> The diagnosis was generated and then discarded by an eight-deep fallback chain ending in a constant.

**Never end a fallback chain in a constant.** End it in evidence, or in an honest statement that there
is none — which is itself information, and reads differently from a reason.

### R-8. Deterministic first (C-4/C-5)

The LLM thinks in structured JSON; the daemon moves the data. If information already exists on the
envelope, recover it — do not ask an organ to describe it again. Every guard added in this program is
a pure function in `platform/work/` with unit tests, called from a thin handler.

Where an LLM decision has a required field, something must enforce it. Cortex correctly concluded it
could not send email and put that conclusion in prose while the `blocker` field stayed empty; nothing
rejected the decision.

### R-9. Blanket text replacement is a defect generator

Three separate incidents: prose explaining the *old* layout rewritten to describe the new one and
thereby made false; a test fixture where the input was renamed and the expected output was not
(`slugifyProjectId('acme Website')` → `'acme-www'`, which is not what slugify does); a `followLinks`
assertion made to expect a value its own table could not produce.

When rewriting across files, maintain an explicit exclusion set for **files whose content is about the
thing being renamed**, and re-run the suite before believing the diff.

### R-10. Every guard is negative-tested in the commit that adds it

Not "the tests pass". **Break it on purpose and watch it fail at the right line**, then restore. A
guard that has never failed is a guard nobody has seen work.

Recorded proofs from this program: a planted dead path in `skills/delegation/SKILL.md` failing
`doc-paths`; a planted address in `platform/organ-firmware/` failing the widened identity scan; an
organ SOUL body edit failing the C-28 soft-lock — *after* a first attempt that edited the deliberately
mutable deep-truths tail and correctly stayed green.

---

## 3. Where the modules stand

Read with §1. "Attention" is where effort earns the most, not where the code is worst.

| Module | Role | Attention | Notes |
|---|---|---|---|
| `platform/contracts/` | schemas, digests, ids, state machines | **High** | Everything downstream trusts these. Pure, cheap to test exhaustively. |
| `platform/work/` | envelopes, spine, delegation, finalization | **High** | Where terminal-state correctness lives (R-7). Pure cores belong here, not in the daemon. |
| `platform/runtime/` | the daemons + action handlers | Medium | Large but loud and canary-covered. Extract pure logic *when touching it anyway* — never as a standalone refactor. |
| `platform/security/`, `persistence/`, `providers/` | auth, storage, egress | **High** on boundaries | Change here is rare; a mistake is not recoverable by a retry. |
| `corekit/system/` | the gates (`validate-contracts`, scanners, compilers) | **Highest** | Rank-1 by §1. These are the things that can lie. |
| `infra/` | install.sh, manifests, bootstraps | **High** | Rank-2: only a fresh deploy proves them. |
| `skills/`, `specialties/` | instructions agents execute | **High** | Rank-3. Wrong on first run. Required flags, error-recovery rows, and one complete example per command. |
| `platform/organ-firmware/` | SOUL / IDENTITY | Low volume, **high ceremony** | C-28 soft-locked. Every edit re-pins the lock and carries `organ-change: intended`. |
| `test/`, `tests/` | the gates themselves | **Highest** | A weak test is worse than none. |
| `app/` | control plane | Medium | Lint gate is green (0 errors); keep it there. Never put runtime logic here. |

### Standing debts, recorded not hidden

- `agent-brain.mjs` at 5,614 lines is in tension with B-18. **Policy: opportunistic extraction only** —
  when a change touches a region, lift its pure logic into `platform/work/` with tests. A dedicated
  decomposition is rank-5 work with rank-1 risk.
- Nothing enforces that a `blocked` decision carries a blocker (R-8). Belongs in decision validation.
- `docs-anchor-insert` does not insert a paragraph break; motor self-heals in three extra tool calls.
- `validate-contracts` checks command presence, not invocation completeness (R-3).

---

## 4. What a change must show

Before merge, in the commit itself:

1. **The incident or the measurement.** What was observed, or what was counted. Not "improve X".
2. **The proof.** Suites green *and* the negative test (R-10) where a guard is involved.
3. **Re-derived evidence** for anything claimed about live behaviour (R-4) — the artifact fetched, not
   the report believed.
4. **The gate**, if the class of defect can recur. A fix without a gate is a fix with a countdown (R-5).
5. **What was left undone**, named. Scope may be reduced; it may not be silently reduced.

Commit messages carry the reasoning, not just the change. They are the only place the *why* survives —
`git log` is the incident record this policy is built from.

### The verification ladder

Use the weakest rung that actually settles the question, and say which one you used:

1. `node --test` — pure logic
2. `validate-contracts --repo` — cross-cutting consistency
3. **Negative test** — the guard fails when it should
4. **Canary upgrade** (candicejr / millie) — the change survives a real mission
5. **Fresh deploy** — bootstrap, `skill-setup` and the install sweeps; the only rung that proves rank-2

Rungs 1–3 are free and belong in every change. Rung 4 is required for anything a running agent
executes. **Rung 5 is required whenever an install destination path changes** — that is the ladder's
whole reason for existing, and skipping it is how a C-19 gate sat at the wrong bootstrap step for a
month, breaking every fresh deploy, while every upgrade stayed green.
