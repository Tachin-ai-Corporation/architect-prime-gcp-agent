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

## HTML/CSS: File Output (MANDATORY — TASK FAILS WITHOUT THIS)
When implementing design changes to web pages, follow these steps IN ORDER:
1. **Fetch** the live page HTML using `web-fetch --url "<URL>" --format html`.
2. **Read** the fetched file with `readFile` to load it into context.
3. **Modify** the HTML/CSS content — apply design improvements directly to the markup.
4. **Write the modified HTML** using `writeFile` with the COMPLETE modified HTML content.
   - The `writeFile` path must be `<filename>.html` in the shared workspace directory.
   - The file must contain the ENTIRE HTML document, not a diff or partial snippet.
   - This is the PRIMARY deliverable. Without this `writeFile` call, the task FAILS.
5. **Write any separate CSS** using `writeFile` if extracted from inline styles.
6. **Upload** the written file using `drive-upload` to the project Drive folder.

CRITICAL: If you analyze a page but do not call `writeFile` to save the modified HTML,
the cerebellum will FAIL your task. Analysis alone is not sufficient — you must produce
the actual file. When the HTML is large (>10KB), write it in full — do not truncate.

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
| Permission requirement | `project-manage update '<project_id>' '{"context":{"<key>":{"kind":"convention","summary":"<what you learned>"}}}'` |
| Working command/path | `project-manage update '<project_id>' '{"context":{"<key>":{"kind":"convention","summary":"<verified command or path>"}}}'` |
| Resource ID (Drive folder, URL) | `project-manage update '<project_id>' '{"context":{"<key>":{"kind":"drive_folder","ref":"<id>","summary":"<description>"}}}'` |
| Failure mode | `project-manage update '<project_id>' '{"context":{"<key>":{"kind":"convention","summary":"AVOID: <what failed and why>"}}}'` |

Examples of useful discoveries:
- `sync_folder_requires_editor` → "Editor access required for all agents uploading to sync folder"
- `deploy_command_verified` → "firebase deploy --project tachin-website --only hosting"
- `staging_url` → "tachin-website--staging-abc123.web.app"
- `css_build_step_required` → "Must run npm run build before deploying; raw source files won't work"

**Rule:** If you learn something that would save the next agent time on this project, write it to project context. Don't rely on mission output alone — context is the project's institutional memory.
