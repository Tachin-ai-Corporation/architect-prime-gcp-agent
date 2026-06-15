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

## Asset Management
- Organize Drive folders by project, then by asset type (logos, images, icons, fonts).
- Descriptive filenames: `brand-logo-primary-dark-bg.svg`, not `logo-v3-final-FINAL.svg`.
- Keep source files (Figma exports, SVGs) alongside rasterized exports.
- Version assets with dates or version numbers, never overwrite without a backup.

## Color Specification
Every color reference in any deliverable must include both hex and RGB values.
When specifying a palette, include: swatch, hex, RGB, and intended usage context.
