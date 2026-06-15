# Skill: Design Operations

## What this skill does
Design system creation, brand guideline enforcement, visual concept development,
and cross-medium design coordination across Slides, Docs, and HTML/CSS.

## When to use
When creating brand guidelines, design systems, visual concepts, or coordinating
design across Slides/Docs/HTML.

Use these procedures when building or maintaining brand identity, creating design
deliverables, or auditing cross-medium consistency.

## Procedures

### Brand System Creation

A brand system is the foundation for all design work. Follow this sequence:

1. **Discovery** — Gather existing materials: logos, past decks, website screenshots,
   any informal style choices already in use. Interview stakeholders for adjectives
   that describe the desired brand personality (e.g., "professional but approachable").
2. **Mood Board** — Assemble 8–12 visual references that capture the target aesthetic.
   Organize in a Slides deck with one reference per slide and a caption explaining
   what it demonstrates (color feel, typography style, layout approach).
3. **Palette Definition** — Select colors:
   - Primary (1–2 colors) — brand recognition, CTAs, key UI elements.
   - Secondary (1–2 colors) — supporting elements, section differentiation.
   - Accent (1 color) — highlights, alerts, interactive feedback.
   - Neutrals (3–5 shades) — backgrounds, text, borders, dividers.
   - Specify each color with: swatch, hex, RGB, and usage context.
   - Verify WCAG AA contrast for every text-on-background combination.
4. **Typography Selection** — Choose a heading and body font pairing:
   - Heading font: distinctive, brand-aligned, readable at large sizes.
   - Body font: highly legible, works at 16px+, clean at small sizes.
   - Define the type scale: H1 through H6, body, caption, overline.
   - Specify font family, weight, size, and line-height for each level.
5. **Component Library** — Define reusable visual components:
   - Buttons (primary, secondary, ghost, disabled states).
   - Cards (image + text, text-only, horizontal, vertical).
   - Headers/footers with logo placement and navigation patterns.
   - Icon style (outline, filled, duotone) and size grid.
   - Document each component with properties table and usage guidelines.

### Design System Documentation

Consolidate brand and component decisions into a living specification:

1. **Component Inventory** — List every reusable component with:
   - Visual reference (screenshot or embedded image).
   - Properties table: property name, value, and notes.
   - All states: default, hover, active, focus, disabled, error.
   - Responsive behavior at each breakpoint.
2. **Token Documentation** — Create a token reference table:
   - Color tokens: name, hex, RGB, usage.
   - Spacing tokens: name, px value, usage.
   - Typography tokens: name, font, weight, size, line-height.
   - Border/radius tokens: name, value, usage.
3. **Usage Guidelines** — For each component and token:
   - When to use vs. when not to use.
   - Do/Don't examples with visual references.
   - Common mistakes and how to avoid them.

### Slides Deck Templates

Standard deck structures for common use cases:

**Pitch Deck** (10–12 slides):
1. Title — company/project name, tagline, date.
2. Problem — what pain exists, who feels it.
3. Solution — what you do about it.
4. How It Works — 3-step or visual walkthrough.
5. Market — size, growth, opportunity.
6. Traction — metrics, milestones, social proof.
7. Business Model — how money flows.
8. Competition — landscape and differentiation.
9. Team — key people and relevant experience.
10. Ask — what you need, what you'll do with it.
11. Contact — how to follow up.

**Brand Guidelines Deck** (8–10 slides):
1. Cover — brand name and visual identity.
2. Brand Story — mission, values, personality.
3. Logo — versions, clear space, minimum size, misuse examples.
4. Color Palette — all colors with hex/RGB and usage.
5. Typography — type scale with specimens.
6. Photography — style guidelines with examples.
7. Iconography — style, grid, examples.
8. Layout Principles — spacing, grids, alignment.
9. Do/Don't — common application examples.

**Project Update Deck** (5–8 slides):
1. Title — project name, date, team.
2. Summary — one-line status and key metric.
3. Completed — what shipped since last update.
4. In Progress — current work with expected dates.
5. Blockers — what's stuck and what's needed.
6. Next Steps — upcoming priorities.

### Cross-Medium Audit

Verify consistency when a project has deliverables across multiple media:

1. **Color Audit** — Extract every color used in each deliverable. Compare hex
   values across Slides, Docs, and HTML. Flag any color that doesn't match the
   defined palette. Flag any palette color used inconsistently between media.
2. **Typography Audit** — Verify font families, weights, and size hierarchy match
   across all deliverables. Flag any deviation from the defined type scale.
3. **Terminology Audit** — Check that naming conventions (product names, feature
   names, labels) are identical across deliverables. Flag inconsistencies.
4. **Visual Language Audit** — Verify icon style, image treatment, and layout
   patterns are consistent across deliverables.
5. **Report** — Produce a consistency report listing every discrepancy with:
   location (file + page/slide/element), expected value, actual value, severity.

### Color Palette Generation

When creating a palette from scratch:

1. Start with the primary color — often derived from an existing logo or brand asset.
2. Generate the secondary color — complementary, analogous, or split-complementary
   depending on desired energy (complementary = high contrast, analogous = harmonious).
3. Select the accent color — high-saturation, used sparingly for attention.
4. Build the neutral scale — derive from the primary hue at very low saturation,
   create 5 steps from near-white to near-black.
5. **Contrast Verification** — Test every text-on-background combination:
   - Body text (< 18px): minimum 4.5:1 contrast ratio.
   - Large text (≥ 18px or 14px bold): minimum 3:1 contrast ratio.
   - Reject any combination that fails and adjust until it passes.
6. Document the final palette with swatch, hex, RGB, and usage for each color.

### Typography Pairing

Guidelines for selecting heading and body font combinations:

1. **Contrast Principle** — Pair fonts with distinct personalities (serif heading +
   sans-serif body, or geometric sans heading + humanist sans body). Avoid pairing
   fonts that are too similar — they create visual tension without clear hierarchy.
2. **Readability Test** — The body font must be highly legible at 16px on screen.
   Test with a full paragraph, not just a specimen word. Reject fonts with ambiguous
   letterforms (1/l/I, 0/O, rn/m).
3. **Weight Range** — Both fonts should offer at least Regular and Bold weights.
   Ideally the heading font has a Semibold or Black weight for emphasis.
4. **Size Scale** — Define the type scale using a consistent ratio (1.25 minor third,
   1.333 perfect fourth, or 1.5 major third). Apply the ratio from body size upward.
5. **Line Height** — Body text: 1.5–1.7× font size. Headings: 1.1–1.3× font size.
   Tighter line height for larger text, looser for smaller.
6. **Fallback Stack** — Always specify system font fallbacks. The design should
   degrade gracefully if the primary fonts fail to load.

## Safety Rules
- Always verify brand guidelines exist before designing — never assume.
- Document every design decision with rationale.
- Never deliver final polish without prior structural approval.
- Keep source files alongside exports — never delete originals.
- Verify accessibility on every deliverable, not just when asked.
