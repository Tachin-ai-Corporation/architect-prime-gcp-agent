# DevOps per-CLI Skills — dissolve `gcp-devops` into one-CLI-per-skill

**Status:** ✅ DONE — implemented and proven on the devops canary (v2026.07.31.1.0 atomic split +
v2026.07.31.1.1 canary counting-idiom fix). `gcp-devops` is retired; `gcloud`/`gsutil`/`docker`
are live on Stan. Recommended placement was taken (Firestore-REST + Cloud Logging folded into
`gcloud`). **Prereq DONE:** the `firebase` skill was already extracted from `gcp-devops`
(v2026.07.31.0.0–.0.2). The 14b/14c specialty-skill coverage gap and the base-motor-SOUL principle
below remain open follow-ons; the canary also surfaced a brain **evidence-elision** churn
(cerebellum can't verify when tool logs are elided) — reported separately, not part of this work.

## Why

Operator direction: **one CLI = one skill.** `gcp-devops` is a grab-bag ("GCP DevOps
Operations") mixing several distinct command surfaces. It matches this repo's other skills
poorly — `workspace-sheets`, `workspace-docs`, and now `firebase` are each one coherent tool
surface. Dissolving `gcp-devops` finishes that pattern for devops and makes each capability
independently discoverable, versioned, and safety-scoped.

Firebase already moved. This plan covers the **remaining** contents of `gcp-devops`.

## Current contents of `gcp-devops` (post-firebase-strip)

`specialties/devops/skills/gcp-devops/` — `scripts: [gcloud, gsutil, docker]`, sections:

| Section | Underlying CLI(s) |
|---|---|
| Create & bind a service account (IAM) | `gcloud` |
| Build & deploy to Cloud Run | `docker` (build/push) **+** `gcloud run deploy` |
| Cloud Logging (`gcloud logging read`) | `gcloud` |
| Infrastructure discovery table | `gcloud` |
| Firestore document querying (REST) | `curl` (+ token) |
| Error recovery (API-not-enabled, 403, image-not-found, quota, 404) | mixed |
| GCS bucket ops (in Write commands) | `gsutil` |

## Target skills

| New skill | Absorbs | `scripts` |
|---|---|---|
| **`gcloud`** | IAM / service accounts, Cloud Run deploy, Cloud Build, infra discovery, Cloud Logging, **Firestore-REST reads** (see open decision) | `gcloud`, `curl` |
| **`gsutil`** | GCS bucket ops (create/copy/permissions/ls/stat) | `gsutil` |
| **`docker`** | build / tag / push to Artifact Registry | `docker` |
| ~~`gcp-devops`~~ | **deleted** once emptied | — |

## Open decision (operator)

**Where do Firestore-REST reads + Cloud Logging live?** They are not their own CLIs —
Firestore is `curl` against the REST API; logging is `gcloud logging read`.
- **Recommended:** fold both into **`gcloud`** as "GCP state reads" — fewest skills, and both
  are read-your-project-state operations an infra agent reaches for alongside gcloud discovery.
- **Alternative:** a dedicated **`firestore`** skill (data-access as its own concern), leaving
  logging in `gcloud`. One more skill; cleaner "infra vs data" separation.

## Wrinkle: cross-CLI procedures

"Build & deploy to Cloud Run" spans **docker** (build/push image) → **gcloud** (`gcloud run
deploy`). A one-CLI-per-skill split has no single home for an end-to-end procedure that crosses
CLIs. Resolution: keep the end-to-end procedure in the skill whose CLI owns the *goal*
(`gcloud`, since the deploy is the outcome), and have it reference the `docker` skill for the
build/push step — rather than duplicating build mechanics. Same treatment for any other
cross-CLI flow discovered during the split.

## Blast radius (what moves together — C-9)

- `specialties/devops/skills/{gcloud,gsutil,docker}/` (new SKILL.md + skill.json each).
- Delete `specialties/devops/skills/gcp-devops/`.
- `infra/manifests/job-devops.txt` — swap the gcp-devops lines for the three new skills.
- `corekit/config/agent-types.json` + `specialties/devops/kit.json` — replace `gcp-devops`
  with `gcloud`/`gsutil`/`docker` in the devops skill lists.
- `docs/guides/SKILL_STANDARD.md` — the high-traffic list currently names `gcp-devops`.
- **No organ change needed.** The devops motor `SOUL_APPEND` was already de-hardcoded
  (v2026.07.31.0.1) to name no skills, so it survives this split untouched — no `ORGAN_LOCK`
  re-pin, no `organ-change` trailer for this work.

## Enforcement gap to close (or track)

`validate-contracts` Checks **14b (skill-doc coverage)** and **14c (phantom capability)** only
scan top-level `skills/*` — the regex is `^skills/([a-z0-9-]+)/SKILL\.md$` and the 14b glob is
`skills/*/skill.json`. **Specialty skills under `specialties/*/skills/` are unchecked.** So the
new gcloud/gsutil/docker skills (like firebase today) get no automated doc-coverage or
phantom-capability guard. Extending both checks to specialty skills is worthwhile — but note it
must handle **system-CLI skills**: their `scripts` (gcloud/gsutil/docker/curl/firebase) are
system binaries, not repo `bin/<tool>` scripts, so 14c's `bin/<tool>` existence test would
false-positive. Options: an allowlist of system binaries, or a `_scripts_kind: "system"` opt-out
mirroring the existing `"gateway"` opt-out. This is an **enforcement-layer** change (its own
task), not part of the skill split.

## Sequencing (production-safe)

`gcp-devops` currently backs Stan's IAM / Cloud Run / Cloud Build / docker / Firestore / logging
capability. To strand nothing:

1. Author `gcloud` + `gsutil` + `docker` skills (content redistributed from gcp-devops; keep it
   GENERIC — the guardrails in `.claude/skills/skill-improvement-loop` apply).
2. Wire manifest + agent-types.json + kit.json + docs **in the same commit** (C-9).
3. Delete `gcp-devops` in that same commit — the install.sh manifest-truth reconcile then sweeps
   it from the VM on upgrade, and the three new skills install in its place (atomic swap; no
   window where devops has neither).
4. `validate-contracts --repo` green; deploy to Stan (`upgrade-corekit --apply <sha>`).
5. Canary: a read-only-first devops task exercising the new skills (e.g. an infra discovery /
   IAM-audit / Cloud Run status task) — confirm real-CLI usage, no capability lost, no
   skill-name hallucination. Stan is the sole devops agent → canary = fleet-wide.
6. Update `.agents/rules/project-context.md` + memory when it lands.

## Separate, related item (NOT part of this plan)

The firebase loop surfaced a **motor-reasoning** tendency: inventing a command from a skill's
*name*. The skill-layer nudge fixed it for firebase, but the general principle — **"a skill is a
procedure I follow, never a command I invoke"** — would best live once in the **base motor
SOUL** (`brain/fleet/_brain/motor/SOUL.md`), fleet-wide, rather than per-specialty. That is a
base-organ change with its own ceremony and blast radius (every specialty inherits it) and
should be decided on its own, not folded into the CLI split.
