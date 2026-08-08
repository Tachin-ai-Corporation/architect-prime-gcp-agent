# Project-scoped deploy target — a devops agent deploys the right content to the right site

## Context

A prime-project's deploy mission failed because the deploying agent had to *guess* the target. In a
live delivery a devops agent deployed the `1health-website` project's content to the `tachin-website`
Hosting **site** (it confused the GCP/Firebase **project** id with the Hosting **site** id, and a bare
`firebase deploy` hit the project's default site), and separately shipped the Firebase default
placeholder because the Drive source was never fetched into the deploy dir. The firebase skill already
had the discipline ("name `--site`, deploy the reviewed source") — what was missing was an
**authoritative statement of *what* the site/source ARE**, reaching the organs that plan and run the
deploy. This makes a project's deploy target first-class, renders it unambiguously, and has the skill
read it.

## What shipped

**First-class `deploy` field on `projects/{id}`** — `{platform, gcp_project, hosting_site, source:{kind,ref}, flow}`.
A dedicated field (not a `context` packet entry, whose render drops structured subfields), so
`hosting_site` and `gcp_project` stay distinct and reach the brain.

- **Pure lib** `corekit/lib/deploy-target.mjs` (B-19, 14 tests): `normalizeDeployDescriptor`,
  `validateDeployDescriptor` (firebase-hosting requires both site and project), `renderDeployBlock`
  (a labeled `## Deployment` block stating site vs project distinctly + the exact
  `--site/--project` command), `deployTargetLine` (compact one-liner). Manifested in `base.txt`.
- **Render** `corekit/lib/projects.mjs buildContext` — emits the `## Deployment` block after canon.
- **Decide-time reach fix** `corekit/daemon/agent-brain.mjs` — `buildModePayload('decide')` now reads
  `payload.project_id || payload.envelope?.project_id` (the trimmed decide projection from `c686809`
  had dropped the nested `project_id`, so canon/the deploy block never reached cortex at decide). Also
  surfaces `deploy` in the prefrontal `[PROJECT CONTEXT]` JSON.
- **Delegated instruction** `checkpoint-executor.mjs` + `actions/delegate.mjs` — append a
  `[DEPLOY TARGET] site=… project=… source=…` line so the delegate has it in the task text too.
- **Bootstrap seeds it** `project-bootstrap.mjs buildProjectDoc` (+ decide-schema `project.deploy` in
  `vertex-text.mjs`, + the project-ops SKILL bootstrap example) — a PM captures site/project/source
  structurally at bootstrap.
- **Firebase skill** `specialties/devops/skills/firebase/SKILL.md` — new Step 0 "read the `## Deployment`
  block, never infer the site, always `--site`/`--project`"; Step 1 extended to fetch a `drive` source
  (`drive-download` into the deploy dir) as well as a git repo; error rows for the placeholder page and
  wrong-site.
- **Dashboard types** `app/src/lib/types.ts` + `components/projects/types.ts` — `deploy?` on
  `Project`/`ProjectDetail`. Operators set/edit it with `project-manage update <id> '{"deploy":{…}}'`
  (top-level fields are preserved by the existing update path).

## Verification

- Pure-core: `deploy-target` 14 tests (site≠project labeling, drive-vs-git source, validation). Full
  suite **1044/1044**; `validate-contracts --repo` green (template-clean placeholders).
- Live canary (stan + archie): roll to stan+archie only; backfill `tachin-web` (site `tachin-web`,
  project `tachin-website`, source git) and `1health-website` (site `1health-website`, project
  `tachin-website`, source drive) deploy descriptors; re-run the 1health delivery. Pass: stan targets
  `1health-website` (not `tachin-website`), fetches the Drive source, the channel serves the REAL site
  (not the 33-byte placeholder); FC-A/FC-B stay green; prod `tachin-web.web.app` untouched.

Commits: version-prefixed (C-23), layer-separated (corekit / skill / dashboard); files + manifest
together (C-9).
