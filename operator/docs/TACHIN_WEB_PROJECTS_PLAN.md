# Tachin Web Projects — Clean Structure & Framework Plan

> **Status:** Implemented
> **Implemented:** 2026-06-27

## Summary

This plan restructured the single `tachin-website` project into two clean projects:

1. **`tachin-website`** — The public marketing website at tachin.ai. Source of truth is git (`sites/tachin-website/`). Processes: p-web-content, p-web-design, p-web-feature, p-web-deploy, p-web-verify.

2. **`tachin-public-files`** — The ad-hoc public file service (Drive → GCS → proxy). Processes: p-publicfile-publish, p-publicfile-health.

## Key Decisions

- Website source moved from Google Drive to git (`sites/tachin-website/`)
- Design system established at `docs/design/TACHIN_DESIGN_SYSTEM.md`
- Site IA established at `docs/design/TACHIN_SITE_IA.md`
- Light, clinical palette replaces the dark-SaaS theme
- index.html is now the home page (no redirect to home.html)
- Processes use `p-web-*` and `p-publicfile-*` naming convention
- Both projects share the same GCP project (`tachin-website`) but are separated at the work-management layer

## Files Created

- `docs/design/TACHIN_DESIGN_SYSTEM.md`
- `docs/design/TACHIN_SITE_IA.md`
- `docs/services/PUBLIC_FILE_SERVICE.md`
- `sites/tachin-website/` (all page files + styles.css)
- `corekit/config/processes/p-web-content.json`
- `corekit/config/processes/p-web-design.json`
- `corekit/config/processes/p-web-feature.json`
- `corekit/config/processes/p-web-deploy.json`
- `corekit/config/processes/p-web-verify.json`
- `corekit/config/processes/p-publicfile-publish.json`
- `corekit/config/processes/p-publicfile-health.json`

## Files Retired

- `corekit/config/processes/p-deploy-website.json` → replaced by `p-web-deploy.json`
- `corekit/config/processes/p-sync-health-check.json` → replaced by `p-publicfile-health.json`
