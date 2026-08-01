# Design (HTML/CSS as the medium)

## When to Use
Producing any visual design — a page, component, layout, mockup, report, one-pager, email, or
slide content — by authoring it as **HTML/CSS**, then converting to the delivery format. HTML/CSS
is the design *medium* (expressive, tokenizable, inspectable, deterministically convertible); the
deliverable format (web, PDF, image, `.docx`, `.pptx`) is a render target, not a redo. For
governing a project's design *system* / brand (tokens, component libraries, cross-medium audits),
see the `design-ops` skill — this skill *produces* designs that conform to that system.

## The substrate: author in HTML/CSS
- Build everything as **semantic HTML + CSS, mobile-first**.
- **Design tokens live in CSS custom properties** (`--color-*`, `--space-*`, `--font-*`, `--radius-*`)
  at `:root`, so one change propagates and every value traces to a token.
- **Consume the project's design system** from project context (palette, type, spacing, logo);
  never invent brand values when a system exists. If none exists, define a minimal one first —
  that is the `design-ops` skill's job.

## Best practices — design for human visual consumption
The goal is not "valid HTML"; it is a page a human reads *effortlessly* and finds *pleasing*. Every
rule below has a reason — carry the reason, not just the rule.

### Hierarchy first
Decide what the viewer sees **1st / 2nd / 3rd before styling anything.** One dominant focal point
per view. Size, weight, color, and position encode importance — the most important thing is the most
prominent. If everything is bold, nothing is.

### Typography (most designs are mostly text)
- A **modular type scale** (e.g. 1.2–1.25 ratio): one H1, a clear H2/H3, body, small — not a dozen ad-hoc sizes.
- **Body ≥ 16px**; line-height ~1.5 for body, ~1.15–1.25 for headings.
- **Line length 45–75 characters** (`max-width: ~65ch` on text blocks) — long lines are hard to track.
- **1–2 typefaces max**; pair a distinctive heading face with a highly legible body face.
- **Left-align** body text; avoid justified (rivers of whitespace) and centered multi-line paragraphs.

### Spacing & rhythm
- **One spacing scale** (4/8px based): `--space-1:4px … --space-6:48px`. Every margin/padding is a
  scale step — no arbitrary `13px`.
- **Whitespace groups and separates** (proximity): related things closer, unrelated things farther.
- Consistent vertical rhythm; generous margins around blocks; do not fear empty space.

### Color & contrast
- **Restraint**: a small palette (1–2 brand, a neutral ramp, one accent). The accent earns attention
  *because* it is rare.
- **WCAG AA contrast** — 4.5:1 body, 3:1 large text — a constraint met from the start, verified not eyeballed.
- **Never carry meaning by color alone** (add an icon, label, or shape) — colorblind- and grayscale-safe.

### Layout & composition
- **Align to a grid**; keep consistent alignment edges — misalignment reads as sloppiness.
- Respect **reading patterns** (F for text-heavy, Z for sparse/landing); place the primary action on
  the path the eye travels.
- Group with cards/sections; use borders and shadows sparingly — **one elevation language**, not five.

### Responsive
- **Mobile-first**: base styles target small screens; `min-width` media queries add complexity upward.
- Prefer **fluid** sizing (`%`, `clamp()`, `minmax()`); add breakpoints only where the layout actually breaks.
- **No horizontal scroll at any width.** Tap targets ≥ 44px.

### Interaction & state
- Every interactive element has visible **`:hover`, `:focus-visible`, and `:active`** states.
- Motion is subtle and purposeful (150–250ms) and respects `prefers-reduced-motion`.

### Restraint (the mark of good design)
Remove until it breaks, then add one thing back. Fewer weights, fewer colors, fewer boxes.
Consistency over novelty — a calm, consistent page beats a busy, clever one for consumption.

## Tools
All three run headless Chrome on the mission's HTML/CSS files (paths are local files in the workspace).

- **`design-render <file.html> [--breakpoints 320,768,1440] [--width N] [--full] [--out p.png]`** —
  screenshot the design at one or more viewport widths (`--full` = the whole scrollable page). Use it to
  SEE the output and confirm no horizontal scroll at each breakpoint. Prints JSON with the PNG paths.
- **`design-export <file.html> --to pdf|png|docx|pptx [--out p] [--slide-selector "section"]`** —
  convert the design to a delivery format. `pdf`/`png` are full fidelity (Chrome); `docx` is structural
  (pandoc — content + hierarchy, not pixel-perfect); `pptx` renders each slide element (default `section`)
  to a full-bleed image (pixel-perfect, non-editable content).
- **`design-a11y <file.html> [--width N]`** — axe-core audit incl. WCAG AA contrast. Prints a JSON report
  with a `score` (100 = clean) and per-rule violations. Aim for **no critical or serious** violations.

> These operate on the HTML/CSS *source*: author it per the best-practices above, render to see it, run
> a11y to verify contrast/structure, then export to the delivery format. Keep the source with every export.

## Procedures

### Design a page or component
1. **Hierarchy** — write the content outline and rank importance *before any CSS*.
2. **Tokens** — pull the project design system (or define a minimal one) into `:root` custom properties.
3. **Structure** — semantic HTML skeleton, mobile-first, one idea per section.
4. **Style from tokens** — apply the type scale, spacing scale, and palette; every value is a token.
5. **Responsive pass** — add breakpoints only where the layout breaks; confirm no horizontal scroll.
6. **State pass** — hover / focus-visible / active on every interactive element; honor reduced-motion.
7. **Render & verify** — `design-render --breakpoints 320,768,1440` and read the images back against the
   hierarchy you set; run `design-a11y` for contrast + structure. Fix and re-render until it reads cleanly,
   with no horizontal scroll at any breakpoint and no critical/serious a11y violations.
8. **Convert** — `design-export --to <format>` produces the deliverable (pdf/png/docx/pptx); keep the
   HTML/CSS source alongside it.

### The deliverable is the file
Produce the complete HTML/CSS file(s), written in full to the mission workspace — never a diff, a
snippet, or a prose description of changes (those fail verification). Keep the source alongside any exports.

## Error Recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| Contrast check fails (< 4.5:1) | Text/background too close in luminance | Adjust the lightness/saturation of one until it clears AA; re-verify. |
| Web font fails to load | Blocked or slow font URL | Define a robust fallback stack (`system-ui, -apple-system, Segoe UI, sans-serif`) and verify it renders. |
| Horizontal scroll on mobile | Fixed widths or an overflowing element | Use fluid units + `max-width:100%` on media; find the overflowing element and constrain it. |
| Everything looks equally important | Hierarchy never established | Stop styling; re-rank the content and let size/weight/position encode the ranking. |
| Inconsistent spacing | Arbitrary pixel values | Replace with spacing-scale tokens — one scale, no one-offs. |
| It looks "off" but nothing's wrong | Misalignment or too many competing elements | Align to the grid; remove decoration until the hierarchy is clear, then add back one thing. |

## Safety
- Verify the project's design system exists before designing — never assume brand values.
- Every decision traces to a token or a stated rationale ("blue = brand primary", not "blue looks nice").
- Accessibility is a starting constraint (contrast, focus, alt text, reduced-motion), not a final polish.
- Keep source files alongside exports; never overwrite without a versioned backup.
