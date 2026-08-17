# Fleet Rollout and Migration Assessment — 2026-08-16

> **Question asked:** can the corekit updates be rolled to the rest of the fleet and still work, and
> does any production data or instance need migrating?
>
> **Answer:** yes to the first, with one real unknown named below. **No data migration is required.**
> Six state defects exist and are recorded here; none of them block a rollout, and one of them makes
> the control plane report a ref that is not installed.

Method: read every VM's `STATE.json` and service state directly, diff the deployed contract against
HEAD, diff the Firestore collection surface, and audit the registry. Nothing here is inferred from
the dashboard, because [defect S-1](#s-1) is that the dashboard is currently wrong.

---

## 1. What is deployed

**Final state — the rollout is complete. All eight agents are on one ref, `d75f58e`.**

| VM | role / job | ref | layout | services | skills |
|---|---|---|---|---|---|
| prime-candicejr | prime | `d75f58e` | post-move | 5/5 | 23 |
| prime-chuck | prime | `d75f58e` | post-move | 5/5 | 23 |
| fleet-archie | product-architect + operator | `d75f58e` | post-move | 5/5 | 16 |
| fleet-bobby | engineer | `d75f58e` | post-move | 5/5 | 15 |
| fleet-dot | designer | `d75f58e` | post-move | 5/5 | 17 |
| fleet-millie | assistant | `d75f58e` | post-move | 5/5 | 19 |
| fleet-stan | devops + operator | `d75f58e` | post-move | 5/5 | 17 |
| fleet-tom | web-master | `d75f58e` | post-move | 5/5 | 21 |
| architect-prime | — | — | pre-move, idle | 0/5 | — |

Every one passed the §4 gate at 12/12, and the registry reports the installed ref for all eight. The
fleet was rolled twice: first to `dea5673` to close the `platform/` split, then to `d75f58e` to carry
the S-2 and S-7 fixes, which is what a routine rollout looks like once the procedure is proven.

**S-7 verified on the agent that exhibited it.** A read-only mission on tom after the second roll
rendered `[verified]` twice and `[undefined]` zero times.

> **A wrong call during the second roll, corrected.** An ad-hoc check with
> `pgrep -f upgrade-corekit` reported an upgrade running on two agents at once, which a sequential
> batch cannot do. That part was a genuine false positive — `pgrep -f` matches full command lines and
> the SSH wrapper running the check contained the pattern, so the check matched itself.
>
> The conclusion drawn from it was wrong. `ps` showed no process and the roll logs were an hour old,
> and that was read as *the batch has stalled*. It had not — it was slow, its output buffered until
> each agent's full cycle finished, and it went on to roll both agents successfully. So stan and tom
> were each rolled twice: once directly, once by the batch. The timestamps show the two passes were
> **sequential, not concurrent** (direct brains up at 02:25:35 / 02:29:21, the batch's at 02:29:23 /
> 02:33:16), so nothing interleaved, and both agents re-gate 12/12 afterwards.
>
> Recorded because "no output yet" and "not running" are different states, and only one of them was
> checked. The right check would have been the agent's own `STATE.json` timestamp, which is what the
> gate reads and what settled it in the end.

<details><summary>The starting state this document was written against</summary>

| VM | ref | installed | layout |
|---|---|---|---|
| prime-candicejr | `7bcaa1c` | 08-16 | post-move |
| fleet-millie | `0a2b78d` | 08-16 | post-move |
| chuck, archie, bobby, dot, stan, tom | `13be751` | 08-14 | **pre-move** |

"Pre-move" means the VM still held `corekit/lib/` and the `/opt/corekit/lib` symlink. Six production
agents were on the far side of the `platform/` restructure from the two canaries, and `13be751` → HEAD
was **73 commits** in which every runtime module's install destination changed.

</details>

---

## 2. Rollout risk

### Proven

**The layout crossing works.** On all three upgraded VMs — one prime, one fleet agent, both role
shapes — every pre-move tree is **absent**, the symlink is gone, the `platform/` packages are present
and populated, and the daemons load from `platform/runtime`. The STATE.json-keyed prune in
`install.sh` §4.5 removes what the previous manifest owned and the new one dropped, and the previous
manifest owned all four old trees. Nothing is left behind.

**Contracts are backward-compatible.** Deployed vs HEAD, ignoring comment keys:

```
ADDED   (3): dispatch.transition_guard, fleet_config.sync_interval_ms, fleet_config.sync_enabled
REMOVED (0): none
```

Additive only. No contract migration, and no ordering constraint between the contract and the code.

**The new Firestore collections are opt-in.** HEAD touches six collections the deployed ref does not:
`fleet_definitions`, `fleet_releases`, `fleet_assignments`, `fleet_rollouts`, `fleet_changes`,
`fleet_evaluations`. An agent with no assignment record is not partially migrated — it is skipped:

```js
const assignment = await db.read(`fleet_assignments/${agent}`);
if (!assignment) { log('INFO', `no assignment for '${agent}' — nothing to reconcile`); return { action: 'skip' }; }
```

Only millie is assigned. The other agents will behave exactly as they do now.

### The unknown

**Five of six job manifests have never crossed the boundary.** Proven: `prime` (candicejr) and
`assistant` (millie). Unproven: `product-architect`, `engineer`, `designer`, `devops`, `web-master`,
plus the two operator job layers (`tachin-website`, on archie and stan).

The risk is manifest-shaped, not layout-shaped: a job layer that names a path the restructure moved
fails for that job alone, and the layout evidence above says nothing about it.

The clean mitigation was a throwaway hire per job — build it, prove it, tear it down, which also
exercises the fresh-deploy path. **That was scoped out by the operator.** The rollout gate in §4 is
therefore the only thing between an untested job manifest and a production agent, which is why it
checks more than health, and why the first agent also proves the rollback.

---

## 3. State defects

None block the rollout. All were found by direct audit.

> **Resolution status.** S-1 closed by the rollout (every agent reports its ref). S-2 and S-7 were
> real defects and are fixed in code. **S-3 and S-5 were errors in this audit, not in the system** —
> both are struck through below with what was actually true. S-4 and S-6 remain operator decisions.

<a id="s-1"></a>
### S-1 · The registry reports a ref that is not installed — *the important one*

| agent | registry says | actually installed |
|---|---|---|
| chuck, archie, bobby, dot, stan | `3ee2763` (Aug 4) | `13be751` (Aug 14) |
| tom | `UNSET` | `13be751` |
| candicejr, millie | correct | correct |

The control plane is currently reporting a ten-day-old ref as live for five agents. Nothing was
maintaining `coreRef` until the write-back added in `ab6a378`. Until an agent is rolled, `STATE.json`
on the VM is the only trustworthy source — this document was built that way.

> **Correction (proven on bobby).** An earlier draft of this document said every agent self-heals
> the moment it is rolled. **It does not heal on the first roll.** `upgrade-corekit` execs the
> version *currently installed*, so an agent upgrading away from a pre-write-back ref runs the OLD
> tool, which does not report — bobby went to `28d11f8` on disk while the registry stayed at
> `13be751`. Rolling it BACK reported correctly (that run used the new tool, installed by the first),
> which is what made the asymmetry visible.
>
> **So every agent in this rollout is upgraded TWICE at the same ref.** The second run is a no-op
> for content (C-18) and executes the newly installed tool, which reports. Verified on bobby:
> `Reported coreRef 28d11f82f43f to primes/chuck/fleet/bobby`.

**Three sources disagree about the same fact**, which is worse than one being stale:

| source | says | correct |
|---|---|---|
| `corekit/STATE.json` on the VM | `13be751` | ✅ |
| Firestore `primes/chuck/fleet/*` | `3ee2763` / `UNSET` | ✗ |
| `corekit/fleet-registry.json` on the Prime | `3ee2763`, `status: deploying` | ✗ |

millie is `online` at `0a2b78d`; the Prime's local registry file still calls her `deploying` at
`3ee2763`.

**This is what made the Prime lie.** Asked to compare installed refs against registered refs, the
canary Prime had no tool that could read an installed ref — `fleet-status` and `fleet-verify` did not
mention `coreRef` anywhere. Motor said so and `report_fail`ed correctly; the mission then synthesised
a table with both columns from one source, found no disagreement, and reported **"zero drift"** across
a fleet where every agent had drifted. Fixed in `3f73233`: `fleet-status --probe` reads
`installedRef` from the VM and sets `refDrift`, `reportedRef` is named for the question it actually
answers, and no single "version" column exists to be compared against itself. A failed probe reports
UNKNOWN rather than falling back to the registry.

**Reproved on the canary** (`3f73233`, same mission text, same Prime). The agent reached for
`fleet-status --probe --json` unprompted, cross-checked with `gcloud compute instances list`, and
returned: millie `0a2b78d57dc7` reported / `0a2b78d57dc7` installed, no drift; mvprobe `UNREPORTED` /
`UNKNOWN`, **flagged as a disagreement** with the reason that its VM no longer exists. It claimed no
agents outside this Prime's registry — the first run had invented five — and its `[verified]` bins
name only things it actually observed. The checkpoint that previously passed on a process criterion
now **failed** and forced a re-plan, converging on a correct answer at iteration 3.

### S-2 · A prime is registered online with no VM — *fixed, `d75f58e`*

`prime-chucknorris` — `status: online`, no instance. Not a decommissioned prime that kept its record:
it held **exactly one field**, where every real prime carries seven to nine, and its id is shaped like
a **VM name** (`prime-` prefix), not a prime id.

`agent-ears` heartbeats status with a Firestore PATCH plus an updateMask, and **a PATCH with an
updateMask upserts**. A VM whose `PRIME_ID` had been set to its own VM name therefore did not fail —
it *created a prime*, carrying the single field the heartbeat wrote, and the dashboard has listed it
as online ever since. The surrounding `catch {}` guaranteed nobody would find out.

Now written with `currentDocument.exists=true`: the heartbeat updates or it fails, and the failure is
logged with which of the two causes it is. **A report may not author its own subject** — the same
shape as the fleet-status column compared against itself (S-1) and the blocked handler whose fallback
chain ended in a constant.

The phantom document itself is left in place: removing tenant data is the operator's call, and the
fix means it cannot come back. `primes/prime-chucknorris` can be deleted whenever convenient.

### ~~S-3 · Releases exist with no definitions behind them~~ — *this audit was wrong*

The claim was `fleet_definitions: 0` against two releases. **Definitions are not stored in a Firestore
collection**; `readDefinitions()` clones them from the git-store. This audit queried a collection that
was never the storage and read the empty result as missing content. `fleet-config list` returns the
definitions, with revisions, exactly as expected.

A real defect did sit underneath it, found only because the retraction was checked rather than
assumed. `fleet-config list` failed with `400 Invalid resource field value in the request` — git-store
resolves its bucket and Firestore base from the **environment** and caches that on first use, so
passing `projectId` to `createRegistry` never reaches it. Absent the variable it builds a `projects//`
URL. That is **every fleet-config command, `rollback` included**, whenever `GCP_PROJECT_ID` is unset —
the normal case, since `/opt/corekit` is root-owned and the tool runs under `sudo`, which drops it.
`agent-content-sync` hit this exact trap, fixed it for itself, and wrote the reason down; this caller
was left behind and nothing checked ([IMPROVEMENT_POLICY](../IMPROVEMENT_POLICY.md) R-5). Fixed in
`336ea4f` and proven under `sudo` with no environment.

### S-4 · `fr-6a524ab97fd1` has a null `parent_release`

Known and previously reported. `previousLiveReleaseId()` fixed the code path; the existing record was
never edited, and no tenant data was changed to make this document tidier. **Operator action.**

### ~~S-5 · Two removed primes carry `coreRef: "main"`~~ — *not an issue*

`mhive2` and `pdf-to-cqd-team` are correctly recorded: `status: removed`, `removedAt` set, no fleet
between them but one already-removed agent. Their `coreRef: "main"` is the documented initial value
that never resolved to a commit, because both were removed before any deploy resolved one. `coreRef`
holds two kinds of thing by design — a floating branch name before, a pinned commit after — and these
records simply never left the first state. Nothing acts on a removed prime. Editing them would be
tidying a record that is already true.

### S-7 · Epistemic bins rendered as `[undefined]` on one agent — *fixed, `336ea4f`*

tom's post-roll report closed with five claims tagged `[undefined]` where every other agent this
session rendered `[verified]` / `[inferred]` — millie, bobby and candicejr all labelled correctly, at
three different refs. The claims themselves were true (the 1health `live` channel was independently
confirmed HTTP 200 with the exact reported title, from a different VM). So this is a **labelling**
defect, not a truthfulness one — but B-29 exists so a reader can tell an observation from an
inference, and `[undefined]` silently removes that distinction on every claim at once.

Cause: `` `• [${a.status}]` `` interpolated whatever cortex returned. The **sort** on the line above
had always tolerated a missing status (`order[a.status] ?? 3`); only the render had not — the two
disagreed about the vocabulary and only one of them said so. An unlabelled claim now falls to
`assumed`, the most cautious bin, because a claim not shown to be checked has not been shown to be
checked. Downgrading is safe; anything else invents a warrant the agent never gave, and `[undefined]`
gives the reader none at all while looking like a bug rather than a caveat — the reading most likely
to be waved past. Entries carrying no claim text are dropped rather than printing a bin over the word
"undefined".

### S-6 · An idle VM — *operator decision, now specific*

`architect-prime`: `e2-standard-2`, created 2026-03-31, **up 138 days**, **zero `agent-*` services**.

It does hold `/opt/corekit`, but a pre-move one (`bin/` + `lib/`, no readable `STATE.json`), so it is
a March-era install that no rollout has touched. It also carries `/opt/openclaw`, which belongs to
nothing in this architecture.

So it is the original bootstrap/control instance, running continuously for four and a half months
without running an agent. That is a standing `e2-standard-2` bill for no current function.

**Not touched, and deliberately.** Deleting an instance is irreversible, and this is the operator's
oldest box — it may hold state, keys or notes that exist nowhere else. If the goal is to stop paying
for it while keeping everything on the disk, `gcloud compute instances stop architect-prime` is the
reversible half of the decision and can be undone with `start`. Deletion should follow only after
someone has looked at what `/opt/openclaw` is.

---

## 4. The rollout gate

Run on each agent after upgrading, before moving to the next. Exits non-zero on the first failure so
that a rollout stops rather than continuing into a second broken agent.

1. **Installed ref matches the requested ref** — from `STATE.json`, not from the registry (S-1).
2. **Pre-move trees removed** — a leftover `corekit/lib/` is not inert; it is a second copy of the
   modules that a stray relative import can still resolve against.
3. **`lib` symlink gone.**
4. **`platform/` packages present and non-empty.**
5. **5/5 services active, sampled twice 20s apart** — systemd reports `active` between a crash and
   its restart, so one sample cannot distinguish a running daemon from a crash-looping one.
6. **`validate-contracts --runtime` passes**, as the VM itself sees it (C-19).
7. **No `Cannot find module` / `ERR_MODULE_NOT_FOUND` / `SyntaxError` in the last three minutes**, and
   the brain printed its startup banner. This is the check that catches a moved module path: a failed
   import leaves the unit `active` while the process restarts forever, which step 5 alone would call
   healthy.
8. **Skills installed** — the quiet failure is an agent that boots healthy with no capabilities.

Then, off-VM: **one real mission run to a terminal state with its artifact verified by re-derivation**
(B-28), and **`fleet-status --probe` shows `refDrift: false`** for the agent just rolled.

The gate reads `STATE.json` on the VM directly rather than asking the Prime, which is deliberate: at
the time this was written the Prime could not answer the question at all, and the tool that now lets
it (§3, S-1) is younger than the fleet it will be used on.

> The gate's own first draft failed a healthy agent. Run as a positive control against millie —
> already at HEAD, plainly fine — it failed her on "brain reached startup", because the check used a
> fixed three-minute window and her startup banner was hours old. A gate that fails good agents
> mid-rollout either halts a working rollout or teaches its operator to ignore it. It now anchors the
> journal window on `installedAt` and asserts the assertion actually wanted: *the brain came up on
> this content*, whenever the gate happens to run. **Run a gate against a known-good subject before
> depending on it against an unknown one.**

### Order — as executed

`bobby → dot → stan → archie → chuck → tom`

Ascending blast radius, with **tom last** at the operator's direction: he holds the 1health
production website, so he gets every other agent's evidence before anyone touches him.

| agent | job | gate | note |
|---|---|---|---|
| bobby | engineer | **PASS 12/12** | forward → back → forward; rollback proven here |
| dot | designer | **FAIL, then PASS 12/12** | the crash-loop ceiling bug, below |
| stan | devops + operator layer | **PASS 12/12** | first proof of the double-upgrade: pass 1 silent, pass 2 reported |
| archie | product-architect + operator layer | **PASS 12/12** | |
| chuck | **prime** | **PASS 12/12** | `NRestarts 20005`, stable — would have been blocked |
| tom | web-master | **PASS 12/12** | 1health `live` verified HTTP 200 from a *different* VM |

All five previously-unproven job manifests crossed the boundary. No data migration was needed at any
step, as predicted in §2.

### The gate stopped the rollout once, correctly

`dot` failed, and the install itself refused: *"Contract validation failed. Refusing to complete an
install whose contracts do not hold (C-19)"* — over `agent-brain is crash-looping (16016 restarts)`.

dot's brain was not crash-looping. Same PID throughout its journal, continuously active for two days.
**`NRestarts` is a lifetime counter that never resets**, and the check compared it to a fixed ceiling
of 5. Any agent that had ever looped would fail forever, and because C-19 fails closed, the check
written to catch a broken agent made healthy ones **un-upgradeable**.

Blast radius, measured before fixing: dot `16016` and chuck `20005` — two of the five remaining, one
of them the Prime. Everyone else `0`. Fixed in `dea5673` to measure a **rate**: sample, wait 10s,
sample again. A delta carries no history and is right in both directions — a unit looping every few
seconds climbs inside the window, while a unit that restarted four seconds ago as part of *this*
install does not. A bare uptime threshold was the obvious fix and would have failed every fresh
deploy instead.

That is the third gate corrected the same way in one session: a fixed journal window, four checks of
which three could never fail, and now a lifetime counter used as a health signal. **A threshold is
only as good as the quantity it is applied to.**

dot was left mid-install between the failure and the fix — new tree on disk, old brain process still
running, services never restarted because the install aborted at the gate. That mixed state is
exactly what the gate exists to surface.

### Rollback — exercised, not assumed

`upgrade-corekit --apply 13be751b441c` restores the previous manifest by the same mechanism that
installs a new one: §4.5 prunes what the current manifest owns and the new one does not, and that
loop reads every dest key in `STATE.json` with no directory scoping, so it reverses the move as
readily as it made it.

**Run on bobby, in full: forward → back → forward.** All three states verified.

| state | ref | gate |
|---|---|---|
| forward | `28d11f8` | PASS 12/12 |
| rolled back | `13be751` | **FAIL 6/12** — every layout check failed, every health check passed |
| forward again | `28d11f8` | PASS 12/12 |

The middle row is the one worth keeping. **A fully rolled-back agent is perfectly healthy**: 5/5
services, contracts valid, no module errors, brain started, no restarts, 15 skills. Health cannot
tell you which version is running, which is the entire reason the gate checks layout at all.

### The gate's own vacuous checks, found by rolling back

The rollback exposed that three of the four "pre-move trees removed" checks could never fail. At the
old ref `corekit/daemon/*` installed to `bin/*.mjs` and `brain/*` to `agents/`/`workspace-*`, so
those DIRECTORIES have never existed on any VM, before or after the move. Only `corekit/lib` is both
a repo path and a VM path.

The first leftover-check reported all four absent on both canaries and read as strong evidence. It
was one check and three pieces of noise. Replaced by `corekit/lib`, the symlink, **and a check that
can fail**: the four `bin/start-agent-*` launchers must exec `platform/runtime`, and no stale
`bin/agent-brain.mjs` may remain. On the rolled-back agent that check reported `0/4`.
