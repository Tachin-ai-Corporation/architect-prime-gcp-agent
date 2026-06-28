# Designer Specialty — Motor Operational Rules

## Slides: Structure Before Content
When building a slide deck, follow this order strictly:
1. Set the master layout — background, logo placement, footer format.
2. Create the slide structure — one slide per idea, establish the narrative arc.
3. Populate content — headlines, body text, data, imagery.
4. Apply formatting — colors, typography, alignment, transitions.

Never jump to formatting before the structure is locked.

## Slides: Layout Discipline
- One core idea per slide. If a slide says two things, split it.
- Consistent margins on every slide — set once in the master, never override per-slide.
- Use the slide master for any element repeated across slides (logos, footers, page numbers).
- Every slide gets speaker notes — what the presenter should say, not what's on the slide.
- Image slides: full-bleed or consistently sized, never stretched or distorted.

## Docs: Design Spec Format
Design specification documents follow a consistent structure:
- Open with a visual reference (screenshot, mockup, or embedded image).
- Specify exact values: hex codes for color, pt/px for size, font family names.
- Use tables for property lists (component, property, value, notes).
- Include Do/Don't examples side by side for ambiguous guidelines.
- End each section with rationale — why this choice, not just what.

## HTML/CSS: Production Standards
- Use CSS custom properties for all design tokens (colors, spacing, typography).
- Build mobile-first — start at 320px, layer up with min-width breakpoints.
- Semantic HTML structure — headings in order, landmarks for regions, lists for lists.
- No inline styles. No `!important` except for third-party overrides.
- Interactive elements must have visible hover, focus, and active states.

## HTML/CSS: File Output (MANDATORY)
When implementing design changes to web pages, you MUST produce the actual modified file.
Analysis, recommendations, and descriptions are NOT deliverables — the cerebellum will
FAIL your task if you don't write the file.

- For files from Drive: follow the "Edit a file from Drive" procedure in the workspace-drive skill.
- For files from a URL: fetch with `web-fetch`, modify, write with `writeFile`, then upload.
- Always write the ENTIRE document — no diffs, no snippets, no truncation.

## Asset Management
- Organize Drive folders by project, then by asset type (logos, images, icons, fonts).
- Descriptive filenames: `brand-logo-primary-dark-bg.svg`, not `logo-v3-final-FINAL.svg`.
- Keep source files (Figma exports, SVGs) alongside rasterized exports.
- Version assets with dates or version numbers, never overwrite without a backup.

## Color Specification
Every color reference in any deliverable must include both hex and RGB values.
When specifying a palette, include: swatch, hex, RGB, and intended usage context.

## Drive Workspace Convention
- **Publish artifacts**: Always use `work-publish`, never raw `drive-upload` for sharing work products
- **Project work**: `work-publish <file> --project <project-id>` → uploads to `{project}/{MM-DD}/`
- **Personal work**: `work-publish <file>` → uploads to `{prime}/{agent}/{MM-DD}/`
- **Custom subfolder**: `work-publish <file> --project <id> --subfolder assets`
- **Read/browse**: Use `drive-ls`, `drive-download`, `drive-search` as normal
- Artifacts produced during a mission MUST be published to Drive before completion

## Project Context Discovery

When you discover a fact about a project during execution that would help future missions, persist it immediately:

| Discovery Type | Command |
|---|---|
| Permission requirement | `project-manage add-context '<project_id>' '<key>' '<what you learned>'` |
| Working command/path | `project-manage add-context '<project_id>' '<key>' '<verified command or path>'` |
| Resource ID (Drive folder, URL) | `project-manage add-context '<project_id>' '<key>' '{"kind":"drive_folder","ref":"<id>","summary":"<description>"}'` |
| Failure mode | `project-manage add-context '<project_id>' '<key>' 'AVOID: <what failed and why>'` |

Examples of useful discoveries:
- `sync_folder_requires_editor` → "Editor access required for all agents uploading to sync folder"
- `deploy_command_verified` → "firebase deploy --project your-website-project --only hosting"
- `staging_url` → "your-website-project--staging-abc123.web.app"
- `css_build_step_required` → "Must run npm run build before deploying; raw source files won't work"

**Rule:** If you learn something that would save the next agent time on this project, write it to project context. Don't rely on mission output alone — context is the project's institutional memory.
