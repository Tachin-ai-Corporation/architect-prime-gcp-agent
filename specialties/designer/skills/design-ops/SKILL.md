# Skill: Design Operations

## When to Use
When creating brand guidelines, design systems, visual concepts, or coordinating design across Slides, Docs, and HTML/CSS.

## Commands

No custom corekit scripts are governed by this skill.

## Procedures

### Brand System Creation
A brand system is the foundation for all design work. Follow this sequence:
1. **Discovery** — Gather existing materials: logos, past decks, website screenshots, any informal style choices already in use. Interview stakeholders for adjectives that describe the desired brand personality (e.g., "professional but approachable").
2. **Mood Board** — Assemble 8–12 visual references that capture the target aesthetic. Organize in a Slides deck with one reference per slide and a caption explaining what it demonstrates (color feel, typography style, layout approach).
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
1. **Component Inventory** — List every reusable component with visual references, properties table, states, and responsive behavior.
2. **Token Documentation** — Create a token reference table for color tokens, spacing tokens, typography tokens, and border/radius tokens.
3. **Usage Guidelines** — Document when to use vs. when not to use, Do/Don't examples, and common mistakes.

### Cross-Medium Audit
Verify consistency when a project has deliverables across multiple media:
1. **Color Audit** — Extract every color used in each deliverable. Compare hex values across Slides, Docs, and HTML. Flag any color that doesn't match the defined palette.
2. **Typography Audit** — Verify font families, weights, and size hierarchy match across all deliverables. Flag any deviation from the defined type scale.
3. **Terminology Audit** — Check that naming conventions (product names, feature names, labels) are identical across deliverables.
4. **Visual Language Audit** — Verify icon style, image treatment, and layout patterns are consistent across deliverables.
5. **Report** — Produce a consistency report listing every discrepancy with: location (file + page/slide/element), expected value, actual value, severity.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| Contrast check fails | Selected color combination has a contrast ratio < 4.5:1 | Adjust the lightness or saturation of either the text or background color until it exceeds the WCAG AA threshold. |
| Primary web font fails to load | Network timeout or blocked custom font URL | Ensure a robust system font stack fallback (e.g. `system-ui, -apple-system, sans-serif`) is defined and verified. |
| Image asset fetch fails | Broken URL or size too large | Verify the asset URL is active and accessible, compress/resize the image if it exceeds 5MB, and re-fetch. |

## Safety Rules
- Always verify brand guidelines exist before designing — never assume.
- Document every design decision with rationale.
- Never deliver final polish without prior structural approval.
- Keep source files alongside exports — never delete originals.
- Verify accessibility on every deliverable, not just when asked.
