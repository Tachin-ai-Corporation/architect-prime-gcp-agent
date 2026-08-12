# Baseline Agent Role: Web-Master

> **Version:** 0.1
> **Status:** DESIGN — not yet landed. Decisions locked (2026-08-12): **v1 = the core vertical** (reuse
> design + content + code + firebase-deploy; defer the net-new `web-domains` skill to Phase 2); **deploy
> permissions = out-of-band grant** on the web-master's fleet SA against the target project (canary path,
> as `stan` is permissioned today — no platform IAM code this pass). To validate: hire a canary
> web-master, grant it Firebase Hosting admin on the 1health target project, and run one real
> end-to-end website mission (design a change → write copy → commit → stage → owner-approve → promote).
> **Ownership:** Human maintainers via CODEOWNERS.
> **Canon alignment:** A new role is a **specialty bundle** — pure **C-28 layer separation**. Preserves
> **C-1** (a *wider* specialist that owns its whole vertical is still a specialist that owns its own work;
> the factory is not made an orchestrator), **C-27** (the mouth is the sole egress; production is
> owner-gated), **B-16/B-17** (zero tool syntax in SOULs — all procedure lives in the reused skills),
> and the organ soft-lock (**C-28**). The one canon *tension* is **B-3/B-4** (one organ, one job; context
> economy) — addressed head-on below.

## Objective

Add **`web-master`** as a baseline agent role: a **single-handed owner of a website surface**. One agent
takes a site from concept to live production — **visual design, content/copy, code implementation, and
Firebase staging→approval→production deploys plus hosting config** — with **nothing delegated** across the
vertical. It is the deliberate fusion of four existing specialties' capabilities into one identity, scoped
to exactly one product surface (a website).

This is the role the codebase already gestures at. The **designer** SOUL says outright: *"Implementation is
mine… I delegate only what is genuinely outside my specialty, such as server config, database changes, or
CI/CD"* ([designer cortex append](../../specialties/designer/brain/cortex/SOUL_APPEND.md)). The web-master
**erases that one boundary** — it owns the server config, the CI/CD, and the deploy too — so a website never
has to cross an agent seam.

## The load-bearing design decision: one vertical, one owner (and its cost)

A single agent holding design + content + code + deploy is not a generalist — its **specialty is the website
vertical itself**. That framing is what keeps it canon-sound, and it has a precise, verified mechanical
consequence and a precise cost.

**What it buys (verified against `corekit/lib/delegation.mjs` + `checkpoint-executor.mjs`).** The whole
cross-agent apparatus is *keyed on capability partitioning*: an instruction that invokes a distinctive skill
(`firebase`, `coding`, `design`…) is rerouted to whichever specialty owns it. If **one** specialty owns the
union, then for every website instruction the executor's *own* specialty owns the skill, so
`checkExecutionCapability` never reroutes, `checkDelegationCapability` is moot, prefrontal marks every part
`local`, and cortex routes everything to its own motor. **The entire false-complete-on-delegation failure
class that FC-A…FC-F were built to catch simply cannot occur for the website vertical** — there is no
delegate to under-converge, no waiting-children lifecycle, no empty-input-branch review loop. Its cortex
behaves like a self-executing designer/devops cortex, not a delegate-first product-architect one.

**It still uses checkpoints.** Checkpoints are verifiable milestones, orthogonal to delegation. Of
plan-structuring's four boundary triggers, only *"a different specialty is needed"* disappears;
*verify-before-continue*, *risk-change*, and *approval-gate* remain. A website still flows **concept →
structural approval → build → stage → owner approval → promote** — as one agent's own `standard` checkpoint
sequence. Plan-structuring's existing guidance *"make it ONE deploy checkpoint owned by the deploy-capable
agent — don't split the edit off"* stops being a warning and becomes the **natural default**.

**What it costs (B-3/B-4).** Concentrating four specialties' character into three organ appends strains
*one organ, one job* and *context economy*. **Mitigation, and it is load-bearing:** the appends carry only
the **unifying stance** — own-the-vertical, hierarchy-and-brand-before-aesthetics, staging→approval→prod,
verify-by-live-fetch — and **all domain procedure stays in the reused skills** (which are pulled in whole,
not copied). The appends must **not** re-list three roles' souls verbatim; if an append starts reproducing
skill procedure or ballooning past its siblings (~25–50 lines each), that content belongs in a skill, not
the organ. This keeps the identity coherent and the context economical.

**Where the wideness stops.** The lane is a *website surface*. Backend systems beyond hosting — databases,
data pipelines, standalone backend services, org-wide IAM — remain outside it and are escalated/delegated.
Wide, not infinite.

## Verified foundations (how a role is defined — every path checked)

The factory is **data-driven by convention**: deploy, bootstrap, persona-assembly, and the dashboard are all
generic per-specialty. A new role is a **data bundle + registry entry + manifest** — no edits to
`assemble-persona`, `install.sh`, `fleet-bootstrap.sh`, `fleet-deploy`, `fleet-hire`, or any `app/` route.
The two non-data steps are the **organ soft-lock re-pin** and — because this role deploys — **IAM**.

| Fact | Where | Consequence |
|---|---|---|
| One role registry — a `types[]` array | [`corekit/config/agent-types.json`](../../corekit/config/agent-types.json) (11 roles; shipped to VMs via `infra/manifests/base.txt`) | Add one object; it is the gate `fleet-hire` + the dashboard resolve against |
| A role = a `specialties/<id>/` bundle (kit.json, responsibilities, workspace/MEMORY.md, `brain/{organ}/SOUL_APPEND.md`, `skills/<skill>/`) | [`specialties/designer/**`](../../specialties/designer) / [`devops/**`](../../specialties/devops) (templates) | Create the parallel `specialties/web-master/` tree |
| Personas assemble generically: `assemble-persona` appends each `SOUL_APPEND.md` onto the base organ SOUL (all six organs always present) | [`corekit/brain/assemble-persona`](../../corekit/brain/assemble-persona) | No code edit — the append files ARE the work |
| **A skill a role uses is installed by that role's manifest — sourced from wherever it already lives.** Reuse = *re-list in the manifest*, never a repo copy | [`job-product-architect.txt`](../../infra/manifests/job-product-architect.txt) already re-lists all the shared `workspace-docs` `docs-*` executables | The web-master manifest re-lists `design`/`coding`/`firebase`/… from their owning specialties — single source of truth preserved |
| Specialty append hashes are pinned in the organ soft-lock | [`brain/ORGAN_LOCK.json`](../../brain/ORGAN_LOCK.json) (count **56**) + `corekit/system/update-organ-lock` | Re-pin after adding the 3 appends (→ **59**), commit trailer `organ-change: intended` — else `validate-contracts` fails |
| Deploy passes specialty as VM metadata; bootstrap reads it generically | `fleet-deploy --specialty <id>`, `fleet-bootstrap.sh` | Zero deploy-script edits — role works once the bundle is on `main` |
| Dashboard reads roles live from `agent-types.json` (no hardcoded list) | `app/src/app/api/agent-types/**` | Role appears automatically |
| **Fleet IAM is uniform + hardcoded — no per-role grants exist; nothing grants `firebasehosting.admin`** | grant loop [`corekit/fleet/fleet-deploy:389`](../../corekit/fleet/fleet-deploy) (aiplatform.user, tokenCreator, datastore.user only) | A deploy role's Firebase perms must be granted **deliberately** — the crux, handled in Phase 1 §IAM |

`validate-contracts` gates that make the scaffolding mandatory: **Check 7** (every `agent-types` id needs
`specialties/<id>/` + `infra/manifests/job-<id>.txt`), **Check 14** (every skill dir needs a `skill.json`
install line; every non-base skill in `skills[]` must be manifest-installed), **Check 15** (organ purity —
no tool syntax in appends), **Check 16** (organ soft-lock hash match).

## Layer purity (C-28) — where each piece of "web-master" lives

| Content | Layer | File |
|---|---|---|
| Who the web-master **is** — owns the vertical, hierarchy+brand before aesthetics, staging→approval→prod discipline, verify-by-live-fetch, discovery-before-assertion | **SOUL appends** (identity) | `specialties/web-master/brain/{cortex,motor,cerebellum}/SOUL_APPEND.md` |
| **How** to design / write copy / render+a11y / implement code / drive git-store / deploy+promote+diagnose Firebase | **Skills** (procedure) | **Reused whole:** `design`, `design-ops`, `coding`, `workspace-git`, `firebase`, `gcloud`, `project-ops`. **Net-new (Phase 2):** `web-domains` |
| The repeatable **workflow** — concept → content → structural approval → build → stage → owner approval → promote → verify | **Process** (workflow, optional) | `corekit/config/processes/p-web-ship.json` (Phase 3) |
| A specific **site** (1health) — its deploy target, brand, repo, team | **Project** (runtime) | Firestore `projects/{id}` — the `## Deployment` descriptor, *not* repo |

No web/domain knowledge leaks into a generic organ or a shared skill; the reused skills stay owned by their
home specialties and improve for everyone.

## Skills — reuse map, exclusions, and the one net-new capability

**Reuse whole (v1) — the manifest re-lists these from their owning specialties (no repo copy):**

| Skill | Owner | Why the web-master needs it |
|---|---|---|
| `design` (+ `design-render`, `design-export`, `design-a11y`) | designer | Visual design **and content/copy** — the skill mandates real words, *"never lorem ipsum"*; renders/exports/audits its own work via headless Chrome + axe-core |
| `design-ops` | designer | Define & maintain the site's brand system (palette, type, tokens) so design conforms to a system, not a whim |
| `coding` | engineer | Land the design as real, verified, committed code in the site repo; edit the *actually-served* file, run/verify locally |
| `workspace-git` | base | The git-store ("ether") flow `coding` runs on — daemon auto-clones into `shared/<missionId>/`; edit → `work-commit` → `work-sync` the mission branch; **not** plain git |
| `firebase` | devops | Staging/prod deploys, preview channels, **promote-by-clone**, the pre-deploy gate, `firebase.json` config, and URL diagnosis — the deploy engine |
| `gcloud` | devops | GCP-side config (API enablement, Cloud Run backends behind a rewrite, service identity) — and the CLI home the Phase-2 DNS work extends |
| `project-ops` | product-architect | Keep the site's own project context current — including the authoritative `deploy` descriptor it reads to know *where* to ship (site vs project kept distinct) |

Plus the standard base skills every role carries: `web-search`, `workspace-drive`, `skill-introspect`,
`memory-consolidate`.

**Explicitly EXCLUDE (shipping them invites wrong-model behavior):**

- `git-ops` — plain local git + `gh` + `feat:`/`fix:` commits. **Contradicts** `workspace-git` (git-store +
  C-23 + daemon-merge). A deployed agent that carries it will try feature branches / `gh pr` / push-to-main.
- `github-pr` — Prime-only; fleet VMs have no `gh` CLI and their git origin is the git-store, not GitHub.
- `code-review`, `codebase-audit` — read-only; optional for a solo builder, omitted from v1 to hold context
  economy (can be added if the web-master should self-review before shipping).

**Net-new — the one genuine gap (Phase 2): `web-domains`.** Custom domain + DNS is the single capability that
exists **nowhere** today (the lone "custom domains" string in the whole tree is a *verification target* in the
devops cerebellum SOUL, not a how-to). The Phase-2 skill codifies: Firebase Hosting `customDomains` REST →
the TXT/A/CNAME records it demands; **apex `A` records = Firebase's static anycast IPs**; Cloud DNS record
management via `gcloud`; and the reserved-static-IP + external HTTPS load balancer alternative. This is the
1health "build C" gap and deserves its own focused skill-authoring + canary loop — which is exactly why it is
Phase 2, not v1.

## Phases

### Phase 1 — the core vertical (v1: land + hire + prove on 1health)

**1a. Role registry** — add one `types[]` entry to `corekit/config/agent-types.json`:
```json
{
  "id": "web-master",
  "aliases": ["webmaster", "web", "web-producer"],
  "title": "Web Master",
  "glyph": "🌐",
  "accent": "#14b8a6",
  "specialty": "End-to-end ownership of a website surface — visual design, content/copy, code implementation, and Firebase staging→approval→production deploys plus hosting config, single-handed",
  "emailPattern": "web-agent-{name}",
  "skills": ["web-search", "workspace-drive", "skill-introspect", "memory-consolidate", "design", "design-ops", "coding", "workspace-git", "firebase", "gcloud", "project-ops"],
  "brain": true
}
```

**1b. Specialty bundle** — `specialties/web-master/`:
- `kit.json` — dashboard metadata (`base_skills:["web-search","workspace-drive","workspace-git"]`,
  `specialty_skills:["design","design-ops","coding","firebase","gcloud","project-ops"]`,
  `brain_appends:["cortex","motor","cerebellum"]`).
- `workspace/MEMORY.md` — 3-line seed (`# MEMORY (Web-Master)` — record deploy targets, brand system
  locations, and verified live URLs here).
- `responsibilities-web-master.json` — **empty for v1** (`{"version":2,"responsibilities":[]}`); an optional
  periodic *uptime/health probe of the live site* responsibility is a Phase-3 fast-follow.
- `brain/cortex/SOUL_APPEND.md` — **Decision bias:** I own the whole vertical and do not delegate its parts;
  information hierarchy and brand consistency precede any aesthetic choice; content and form are one design
  (I write the real words); discovery before assertion (no infra resource named unverified); diagnose before
  rebuilding on a "not-serving" symptom; **staging/preview is mine to ship freely, production is
  owner-gated** and promoted as the exact reviewed bytes; every prod change carries a rollback; my lane ends
  at the website surface (backend systems beyond hosting are escalated).
- `brain/motor/SOUL_APPEND.md` — **Operating character:** design → HTML/CSS/JS → committed code is mine, and
  the deliverable is the complete changed file (not a diff or a description); I work the git-store flow (edit
  in the mission tree, commit with the version format, sync the mission branch — never re-clone `main`
  mid-mission or push to `main`); I deploy the **reviewed source**, and when I edited the site this mission I
  deploy the tree I edited; discovery before change, reuse before create, least privilege; durable facts
  (deploy target, verified endpoints, brand locations) persist to project context.
- `brain/cerebellum/SOUL_APPEND.md` — **Verification bias:** design gates (brand palette hex-for-hex, WCAG AA
  contrast, responsive with no horizontal scroll at mobile/tablet/desktop); code gates (the *actually-served*
  file changed — judge the committed diff, not the claim; build/tests green where they exist); **deploy gates
  (a deploy passes only on a live HTTP-200 *whole-render* of the exact URL — byte size + a below-the-fold
  marker — never a CLI "✅"; a multi-page/asset site also verifies a page + an image)**; a custom domain, when
  present, resolves and answers over HTTPS with the expected markers; production serves the exact bytes
  approved on staging; never synthesize success without live evidence.
- *(No new skill dirs in v1 — every skill is reused.)*

**1c. Manifest** — create `infra/manifests/job-web-master.txt`, merging the reused-skill lines from the
existing `job-designer.txt` (the `design`/`design-ops` `SKILL.md`+`skill.json`+the three `design-*`
executables + `setup.sh`), `job-devops.txt` (`firebase`, `gcloud`), `job-engineer.txt` (`coding`),
`job-product-architect.txt` (`project-ops`), plus the 3 new SOUL appends, the MEMORY seed, and
`responsibilities-web-master.json`. Confirm during authoring which base skills (`workspace-git`,
`web-search`) `role-fleet.txt` already provides vs. which need re-listing. Every reused skill lands in the
VM's runtime skill-scan path, so the brain discovers all of them.

**1d. Organ soft-lock** — run `corekit/system/update-organ-lock` (adds the 3 web-master append hashes →
count **59**); commit with an `organ-change: intended` trailer.

**1e. IAM — the deliberate grant (out-of-band, canary path).** The web-master's fleet SA
(`fleet-<name>@<fleet-project>.iam.gserviceaccount.com`) gets the uniform 3 roles at deploy like every agent.
For it to deploy the 1health site, the operator **additionally grants — out of band, on the 1health target
Firebase/GCP project** (the project that hosts site `1health-website`, distinct from the fleet's own
project): `roles/firebasehosting.admin`. This mirrors exactly how `stan` is permissioned today, requires no
platform code change, and is documented as a **manual operator step** alongside "create the Workspace user /
add to the Chat space." *(Phase 2 adds `roles/dns.admin` for custom domains.)* Also settle the auth
mechanism per project standard: GCE ADC via the VM SA (preferred, per the firebase skill) vs. the deprecated
`FIREBASE_TOKEN` (open P1 to retire) — the ADC path is the target.

**1f. Hire + validate on 1health.** `fleet-deploy --name <n> --specialty web-master` → create the Workspace
user (exact name match) + add its email to the 1health project's Chat space → grant Firebase admin (1e) →
scope a real mission to the 1health project and run it **end to end in one mission**: *design a visible
change, write its copy, implement it in the repo, commit it, deploy to staging, report the staging URL, wait
for approval, then promote to production* — with **no delegation** and honest **staging→approval→prod**
gating. Acceptance in §Rollout.

### Phase 2 — `web-domains` skill (custom domain + DNS + static IP)

Author `specialties/web-master/skills/web-domains/{SKILL.md,skill.json}` (a specialty skill, `agent_part`
mixed motor/cerebellum). Codify: Firebase Hosting `customDomains` REST provisioning → the TXT ownership +
A/CNAME records it returns; **apex domains use Firebase's anycast `A` IPs**, subdomains use CNAME; Cloud DNS
zone/record management via `gcloud`; TLS-cert issuance wait + verification; and the reserved-static-IP +
external HTTPS LB alternative when Hosting's managed path doesn't fit. Add `web-domains` to the `agent-types`
`skills[]`, add its install lines to `job-web-master.txt`, and grant the SA `roles/dns.admin` on the target
project. Prove it by attaching 1health's custom domain end-to-end (records created → domain resolves → HTTPS
serves the site). Extend the cerebellum append's "custom domain resolves over HTTPS" gate to assert it.

### Phase 3 — (optional fast-follow) `p-web-ship` process + health responsibility

- `corekit/config/processes/p-web-ship.json` — a first-class, checkpoint-verified workflow encoding the
  natural single-agent sequence (concept → content → structural approval → build → stage → owner approval →
  promote → verify), referencing skills by name; +1 line in `infra/manifests/base.txt`. This is the
  single-agent embodiment of plan-structuring's "one deploy checkpoint" guidance.
- A periodic **live-site health probe** responsibility (curl the prod URL, flag non-200 / content drift),
  mirroring the devops nightly-health pattern.

## Consolidated file surface

**CREATE:** `specialties/web-master/{kit.json, workspace/MEMORY.md, responsibilities-web-master.json,
brain/cortex/SOUL_APPEND.md, brain/motor/SOUL_APPEND.md, brain/cerebellum/SOUL_APPEND.md}`;
`infra/manifests/job-web-master.txt`. *(Phase 2:* `specialties/web-master/skills/web-domains/{SKILL.md,
skill.json}`*; Phase 3:* `corekit/config/processes/p-web-ship.json`*.)*
**EDIT:** `corekit/config/agent-types.json` (+role entry); `brain/ORGAN_LOCK.json` (re-pin 56→59).
*(Phase 2:* re-add `web-domains` to the entry + manifest; Phase 3:* +1 line in `infra/manifests/base.txt`*.)*
**NO REPO EDITS (generic / data-driven):** `assemble-persona`, `install.sh`, `fleet-bootstrap.sh`,
`fleet-deploy`, `fleet-hire`, all `app/`. **NO skill copies** — reused skills stay owned by their specialties.
**OUT-OF-BAND (operator, not repo):** grant `roles/firebasehosting.admin` (Phase 2: `roles/dns.admin`) on the
target project; create the Workspace user; add it to the Chat space.

## Open decisions (for you)

1. **Trim the skill set?** `design-ops` (define a brand *system*) and `project-ops` (self-curate the site's
   project context, incl. the deploy descriptor) both serve "single-handed" but add surface. Keep both
   (recommended — they make the agent self-sufficient), or drop either for a leaner v1.
2. **Name / title / email.** Proposed: id `web-master`, title **"Web Master"**, glyph 🌐, accent `#14b8a6`,
   email `web-agent-{name}`. Adjust any (e.g. "Web Producer" if "Master" reads oddly).
3. **Self-review.** Add `code-review` so the web-master reviews its own diff before shipping, or keep v1 lean
   and rely on the cerebellum gates?
4. **Phase 3 now or later.** Land the `p-web-ship` process with v1 (codifies the workflow up front), or prove
   the freeform single-agent flow first and capture the process from a good run?

## Rollout & measurement

Each phase: author → `validate-contracts --repo` clean (Checks 7/14/15/16 — organ purity, soft-lock,
manifest tri-source) → version-prefixed commit(s) → deploy a canary web-master → the validation mission →
note. **v1 acceptance:** one agent, one mission, **no delegation** — produces a real designed+written change,
lands it as committed code in the site repo, deploys it to a reachable **staging** URL (verified by a live
HTTP-200 whole-render), **stops for owner approval**, and on approval **promotes the exact reviewed version**
to a reachable **production** URL. The brand/a11y/deploy cerebellum gates hold; the mouth stays the sole
egress; production is never touched without approval. Fully reversible (delete the bundle + registry entry +
manifest, revert the lock; revoke the out-of-band IAM grant).
