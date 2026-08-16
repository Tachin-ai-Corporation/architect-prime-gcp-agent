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

| VM | ref | installed | layout | services |
|---|---|---|---|---|
| prime-candicejr | `7bcaa1c` | 08-16 | post-move | 5/5 |
| fleet-millie | `0a2b78d` | 08-16 | post-move | 5/5 |
| prime-chuck | `13be751` | 08-14 | **pre-move** | 5/5 |
| fleet-archie | `13be751` | 08-14 | **pre-move** | 5/5 |
| fleet-bobby | `13be751` | 08-14 | **pre-move** | 5/5 |
| fleet-dot | `13be751` | 08-14 | **pre-move** | 5/5 |
| fleet-stan | `13be751` | 08-14 | **pre-move** | 5/5 |
| fleet-tom | `13be751` | 08-14 | **pre-move** | 5/5 |
| architect-prime | — | — | no corekit | 0/5 |

"Pre-move" means the VM still holds `corekit/lib/`, `corekit/daemon/`, `corekit/contracts/`, `brain/`
and the `/opt/corekit/lib` symlink. Six production agents are on the far side of the `platform/`
restructure from the two canaries.

`13be751` → HEAD is **73 commits**, and it is not an ordinary upgrade: every runtime module's install
destination changed.

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

### S-2 · A prime is registered online with no VM

`prime-chucknorris` — `status: online`, `coreRef: UNSET`, no instance. A ghost that any fleet-wide
operation will try to include.

### S-3 · Releases exist with no definitions behind them

`fleet_releases: 2`, `fleet_changes: 2`, `fleet_definitions: 0`. Both releases sit at `canary`. Either
definitions live elsewhere and the collection name is wrong, or the releases reference content that
was never imported. **Resolve before anyone rolls a release back** — a rollback to a release whose
definitions cannot be read is a failure discovered at the worst moment.

### S-4 · `fr-6a524ab97fd1` has a null `parent_release`

Known and previously reported. `previousLiveReleaseId()` fixed the code path; the existing record was
never edited, and no tenant data was changed to make this document tidier. **Operator action.**

### S-5 · Two removed primes carry `coreRef: "main"`

`mhive2`, `pdf-to-cqd-team` — both `status: removed`. Harmless, and a reminder that `coreRef` holds
two kinds of thing: a floating branch name before a deploy resolves one, a pinned commit after.

### S-6 · An idle VM

`architect-prime` is RUNNING with no corekit installed and all five services inactive. It is the
original bootstrap/control instance. Cost with no current function — decide whether to keep it.

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

### Order

`bobby → dot → tom → stan → archie → chuck`

Ascending blast radius. bobby (engineer) is the least entangled; archie and stan carry the operator
job layer; chuck is the prime that owns the whole fleet and goes last.

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
