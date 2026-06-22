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
When implementing design changes to web pages:
- **Always use `writeFile`** to save the modified HTML/CSS as actual `.html` and `.css` files in the shared workspace directory. Never just describe changes — write the complete files.
- When modifying an existing page, first fetch the live content with `web-fetch`, then use `writeFile` to save the modified version as `<filename>.html` in the shared workspace.
- If a page uses inline `<style>` blocks, either keep them inline in the HTML file or extract to a separate `.css` file — but always produce a complete, runnable HTML file.
- The written file must be self-contained and viewable in a browser without additional dependencies (except external fonts/CDNs already referenced).
- After writing the file, use `drive-upload` to upload it to the project's Google Drive folder for sync-service deployment.

## Asset Management
- Organize Drive folders by project, then by asset type (logos, images, icons, fonts).
- Descriptive filenames: `brand-logo-primary-dark-bg.svg`, not `logo-v3-final-FINAL.svg`.
- Keep source files (Figma exports, SVGs) alongside rasterized exports.
- Version assets with dates or version numbers, never overwrite without a backup.

## Color Specification
Every color reference in any deliverable must include both hex and RGB values.
When specifying a palette, include: swatch, hex, RGB, and intended usage context.
