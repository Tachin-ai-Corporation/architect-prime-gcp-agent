# Design (HTML/CSS as the medium)

## When to Use
Producing any visual design — a page, component, layout, mockup, report, one-pager, email, or
slide content — by authoring it as **HTML/CSS**, then converting to the delivery format. HTML/CSS
is the design *medium*; the deliverable format (web, PDF, image, `.docx`, `.pptx`) is a render
target, not a redo. For governing a project's design *system* / brand (tokens, component
libraries, cross-medium audits), see the `design-ops` skill — this skill *produces* the designs.

## Work like a designer — decide, don't decorate
Great design is a sequence of confident decisions, not markup with styling sprinkled on. Do this
thinking **before** you touch HTML:

1. **Understand the brief.** Who is this for? What is the ONE thing it must achieve? What feeling
   should it leave, and what is the brand's personality? If the brief is thin, *decide these
   yourself* — a designer brings a point of view, they don't wait to be told.
2. **Form a concept.** Name a creative direction in 2–4 words ("bold editorial", "calm & premium",
   "playful & warm", "brutalist & confident"), plus a mood and a reference or metaphor. Every later
   choice — type, color, space, motion — must serve it. **A design without a concept is generic by
   default.**
3. **Write the content.** *You* decide the actual words: headline, subhead, body copy, labels, CTA.
   Content and form are one design — never design around placeholder text. Make the words sharp,
   specific, and on-concept.
4. **Compose the big moves** (before any pixel). What is the hero moment that owns the first screen?
   Where does the drama live — a huge headline, dramatic space, a striking color field? What are the
   sections and their rhythm down the page? What does the eye hit 1st, 2nd, 3rd?
5. **Build it** in HTML/CSS to realize the vision (craft + fundamentals below).
6. **Critique and refine.** Render it and look with a hard eye (see Self-critique). The first version
   is a *draft* — good design is refined, never one-shot.

## Make it beautiful — not merely correct
Correctness (the Fundamentals) is the floor. **Beauty is the job.** The difference is a concept
committed to, and *ambition in the execution*:

- **Commit to the concept, boldly.** A clear, slightly daring point of view beats safe blandness
  every time. Let the personality show loudly — in the type, the color, the space, the motion.
- **Restrained in elements, ambitious in execution.** Use *few* elements — but make them *striking*.
  A minimal page should still be bold: one enormous headline, dramatic negative space, one confident
  color move. **Minimal ≠ timid or plain. If the result looks merely "fine" or "clean," it is not
  done.**
- **Let typography carry the design.** Choose an expressive typeface with real character — load a
  **web font** (e.g. Google Fonts via `<link>`; it renders in the tools' pipeline) with a system
  fallback; do *not* default to `system-ui`. Set the hero headline **large and confident**
  (think `clamp(2.5rem, 7vw, 6rem)`), tight leading (~1.05), a strong weight, maybe tighter tracking.
  Contrast it hard against small, quiet body text. **Great type alone can make a page beautiful.**
- **Color with depth and intent.** Build a *considered* palette, not three flat colors: a neutral
  ramp with a temperature (warm greys, cool near-blacks), a purposeful accent, real tints and shades
  (5–9 steps). Reach for a rich dark background, a subtle 2–3-stop gradient, or a duotone when it
  serves the mood. Color must evoke the concept **and** pass contrast — both, not either.
- **Compose with drama.** Big/small **scale contrast**. **Negative space as a device**, not leftover
  padding — let key things breathe. **Asymmetry and tension** over dead-centering everything. A clear
  **hero moment**. **Depth**: overlap, layering, a soft considered shadow, a foreground/background
  relationship — not flat boxes stacked in a column.
- **Richness, tastefully — CSS is your visual material.** Backgrounds beyond flat white: a tonal
  section band, a gradient, a hint of texture, a blurred color blob. With no image assets,
  **gradients, geometric shapes, big type, and rules ARE the art** — a page can be beautiful with
  zero photos. Add details (a fine divider, a small badge, a considered radius) with intent.
- **Finish.** Optical alignment (not just mathematical), one consistent radius + one elevation
  language, considered hover/transition, spacing that breathes on a rhythm, no orphans or widows.
  The last 10% of polish separates good from great.

## Self-critique — do this every time, before you deliver
Render it (`design-render`, full-page + one breakpoint) and look **hard**, as an art director would:
- Can I name the concept *from the design alone*, or is it generic?
- Does **one** thing seize attention on the first screen, or does everything blur together?
- Is the type **expressive and confident**, or default and timid?
- Is the color a **considered palette with depth**, or a few flat / arbitrary values?
- Is there **depth, rhythm, and dramatic space** — or is it a flat stack of centered boxes?
- **Would a strong design studio ship this?**

If any answer is weak, name the **single highest-impact move** — usually a real display web font at
large scale, more dramatic space, a richer/darker palette, or a background treatment — **make that
one move and re-render.** Repeat until it is genuinely good, not merely correct. *Stopping at
"correct and accessible" is the most common failure of this skill.*

## The substrate: author in HTML/CSS
- Build as **semantic HTML + CSS, mobile-first**.
- **Design tokens live in CSS custom properties** (`--color-*`, `--space-*`, `--font-*`, `--radius-*`)
  at `:root`, so one change propagates and every value traces to a token.
- **Consume the project's design system** from project context when one exists (palette, type,
  spacing, logo) — never invent brand values then. If none exists, your concept defines a minimal one.

## Fundamentals — the floor (never ship below this)
These prevent ugliness and illegibility; the sections above create beauty. **Both are required.**

### Hierarchy
Decide 1st / 2nd / 3rd before styling. One dominant focal point per view; size, weight, color, and
position encode importance. If everything is bold, nothing is.

### Typography mechanics
- A **modular scale** (≥ 1.25 ratio; larger ratios read as more designed). **Body ≥ 16px**;
  line-height ~1.5 body, ~1.05–1.2 headings.
- **Measure 45–75 characters** (`max-width: ~65ch`) on running text.
- **1–2 typefaces**; a distinctive display face + a legible body face. **Left-align** body; avoid
  justified text and centered multi-line paragraphs.

### Spacing & rhythm
- **One spacing scale** (4/8px based): `--space-1:4px … --space-8`. Every margin/padding is a step —
  no arbitrary `13px`.
- **Arithmetic on a token needs `calc()`.** `padding: var(--space-2)` is fine, but
  `padding: var(--space-1) * 2` is **invalid CSS** — silently dropped, the element falls back to its
  default. Always `calc(var(--space-1) * 2)`.
- Whitespace groups and separates (proximity); generous, rhythmic vertical spacing.

### Color & contrast
- **WCAG AA** — 4.5:1 body, 3:1 large text — from the start, verified not eyeballed. (Accessibility
  and beauty are not in tension: a strong palette hits both.)
- **Never carry meaning by color alone** (add an icon, label, or shape).

### Layout, responsive, interaction
- Align to a grid; consistent edges. **Mobile-first**; fluid sizing (`clamp()`, `minmax()`),
  breakpoints only where the layout breaks; **no horizontal scroll** at any width; tap targets ≥ 44px.
- Every interactive element has visible **`:hover`, `:focus-visible`, `:active`**; motion subtle
  (150–250ms), honoring `prefers-reduced-motion`.

## Designing for print / paged output (flyers, brochures, multi-page PDFs)
Print is **paged, not scrolled** — you design to a fixed page and control every break. Screen habits
(continuous flow, `vh`/`vw`) don't apply; think page by page, in document order.

- **Set the page.** `@page { size: A4; margin: 0; }` — A4 is 210×297mm, US Letter 8.5×11in; add
  `landscape` for wide. `margin: 0` for full-bleed glossy, or e.g. `margin: 12mm` for a safe content
  inset. Author print dimensions in **physical units** (mm/cm/in), not px/vw.
- **One box per page.** Wrap each page in a container the exact page size
  (`.page { width: 210mm; min-height: 297mm; box-sizing: border-box; }`) and force the break with
  `break-after: page` on every page **except the last**. Content order = document order = page order.
- **Avoid the blank trailing page.** A page box at *exactly* the page height plus any padding,
  border, margin, or a `break-after` on the final page spills into an empty extra page. Use
  `box-sizing: border-box`, no `break-after` on the last page, no bottom margin on the last block; if
  a blank page persists, trim the height a hair (`min-height: 296mm`) — then **verify the count**.
- **Keep blocks whole** with `break-inside: avoid` on anything that must not split across pages.
- **Full-bleed glossy:** `@page margin: 0` + backgrounds/images to the paper edge (the exporter turns
  on `printBackground`); keep critical text inside a safe inset from the trim.
- **Export and verify.** `design-export --to pdf` uses the CSS `@page` size/margins and reports a
  **`pages`** count — confirm it equals your intent (exactly 2 for a two-pager; no blank trailing page).
- **Critique the print view, not the screen.** Screen and print media differ — judge a print piece
  from `design-render --print` (print-media emulation) or the exported PDF, never the plain render.

## Tools
All run headless Chrome on the mission's HTML/CSS files (paths are local files in the workspace).

- **`design-render <file.html> [--breakpoints 320,768,1440] [--full] [--print] [--out p.png]`** —
  screenshot the design at one or more viewport widths (`--full` = the whole scrollable page;
  `--print` = print-media emulation, for paged/flyer pieces). Your eyes on the work — render early and
  often, and critique what you see. Prints JSON with the PNG paths.
- **`design-export <file.html> --to pdf|png|docx|pptx [--out p] [--slide-selector "section"]`** —
  convert to a delivery format. `pdf`/`png` are full fidelity (Chrome); `docx` is structural (pandoc);
  `pptx` renders each slide element (default `section`) to a full-bleed image (pixel-perfect). For a
  print/paged design (`@page` in the CSS) the PDF adopts the CSS page size + margins and the JSON
  includes a **`pages`** count — use it to verify clean pagination.
- **`design-a11y <file.html> [--width N]`** — axe-core audit incl. WCAG AA contrast; JSON `score`
  (100 = clean) + per-rule violations. Aim for **no critical or serious** violations.

## Procedures

### Design something (the full process)
1. **Concept & content** — decide the goal / audience / feeling, name the concept, and **write the
   real content** (headline, copy, CTA). Never lorem ipsum.
2. **Compose** — plan the big moves: the hero moment, where the drama lives, the sections and rhythm.
3. **Tokens** — pull the project system, or define one from your concept, into `:root` (a palette
   with depth, a real type scale, a spacing scale). Load a web font.
4. **Build — markup and its styles together, in one pass.** Write semantic, mobile-first HTML *and*
   its complete CSS in the same step, styling from tokens with responsive + hover/focus/active. Author
   every file **in full** — an empty or stub `style.css` means the design does not exist yet. Work
   economically: read your inputs (this SKILL, the brief) **once** and don't re-recall mid-task — a task
   has a bounded tool-call budget, and re-reads spend it before the artifact is finished.
5. **Render & self-critique** — `design-render` (full-page + a breakpoint); judge it hard against
   Self-critique; make the single highest-impact move; **re-render**. Iterate until genuinely good.
6. **Accessibility** — `design-a11y`; fix any critical/serious (usually contrast or a missing
   landmark); confirm no horizontal scroll at each breakpoint.
7. **Convert** — `design-export --to <format>` for the deliverable; keep the HTML/CSS source with it.

### The deliverable is the file
Produce the complete HTML/CSS file(s), written in full to the mission workspace — never a diff, a
snippet, or a prose description of changes (those fail verification). Keep the source with any exports.

## Error Recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| It renders correct and accessible but looks **generic or bland** | You stopped at the floor — no concept committed; timid type, color, and space | Return to the concept and make ONE bold move: a real display web font at large scale, dramatic space, a richer/darker palette, or a background treatment. "Correct" is not the goal — beautiful is. |
| `style.css` (or a file) came out **empty or partial** and the design won't render | Authoring ran past its per-task tool-call budget — steps spent on re-reads/recall before the CSS was written | Author the markup and its **full** CSS in ONE pass; read inputs once, skip re-recall. If the outcome is genuinely too large for one task, the split is authoring vs render vs deliver — never HTML vs CSS. |
| Everything looks equally important | Hierarchy never established | Stop styling; re-rank the content and let size/weight/position encode the ranking. |
| Type feels flat and default | `system-ui` everywhere, uniform sizes | Load an expressive web font; open up the scale — a large, confident headline against small body. |
| A margin/padding/gap is ignored (element uses default spacing) | Arithmetic written as `var(--x) * N` — invalid CSS, silently dropped | Wrap it in `calc()`: `calc(var(--x) * N)`. Only `calc()` evaluates arithmetic inside a CSS value. |
| Contrast check fails (< 4.5:1) | Text/background too close in luminance | Adjust the lightness/saturation of one until it clears AA; re-verify. Keep the palette's mood. |
| Web font fails to load | Blocked or slow font URL | Confirm a robust fallback stack (`'Font', system-ui, -apple-system, sans-serif`) renders acceptably; re-render to check. |
| Horizontal scroll on mobile | Fixed widths or an overflowing element | Fluid units + `max-width:100%` on media; find the overflowing element and constrain it. |
| A flyer/print PDF is one long page, not paged | No `@page` / `.page` boxes / `break-after` | Design to fixed `.page` containers with `break-after: page` between them; set `@page { size }`. |
| PDF has a blank trailing page | Last `.page` = exactly the page height + padding/border, or a `break-after` on the final page | `box-sizing: border-box`; drop the final `break-after` and any trailing bottom margin; trim `min-height` a hair; re-check the reported `pages`. |

## Safety
- Verify the project's design system exists before designing — never assume brand values.
- Every decision traces to a token or a stated rationale ("ink-black because the concept is
  editorial", not "black looks nice").
- Accessibility is a starting constraint (contrast, focus, alt text, reduced-motion), not a final polish.
- Keep source files alongside exports; never overwrite without a versioned backup.
