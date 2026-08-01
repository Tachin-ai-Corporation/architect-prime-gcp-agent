# Design Skill — HTML/CSS as the universal design medium

**Status:** ✅ DONE — fully implemented and proven on dot (v2026.08.01.0.0–.0.4). Two skills
(`design` primary + `design-ops` companion), tools `design-render` / `design-export` / `design-a11y`
(headless Google Chrome via puppeteer-core + pandoc + pptxgenjs), the `install.sh` setup.sh
install-hook enabler, and the motor-SOUL C-28 trim all shipped. Names taken as proposed; docx/pptx
built per the documented fidelity tradeoff. **Canary:** dot designed a "Coming Soon" landing page —
authored token-driven accessible HTML, rendered at 375/1440, ran a11y, **fixed contrast + added a
`<main>` landmark to reach WCAG AA score 100**, exported a PDF; mission COMPLETE, cerebellum PASS.
One canary-driven craft fix landed (`calc()` required for token arithmetic, v2026.08.01.0.4).

## Core idea

Design agents produce every design **as HTML/CSS** — the medium they work in and get very good at —
because HTML/CSS is expressive, precise, tokenizable, inspectable, and **deterministically
convertible**. One well-crafted HTML/CSS source becomes whatever the deliverable needs: a live web
page, a PDF, an image, a `.docx`, a `.pptx`. HTML/CSS is the **source of truth**; the output format
is a render target, not a redo.

This is **design** — HTML/CSS is the substrate, not the scope. (It is deliberately *not* framed as
"web design," which is too narrow.) The skill is as much about **best practices for optimal human
visual experience and consumption** as about writing the markup.

## Where we are (the gap)

Dot is *architected* as an HTML/CSS designer but *equipped* as a Slides/Docs one:

- **All three organs claim HTML/CSS, nothing backs it (phantom capability).** Cortex — "I am the
  specialist for HTML, CSS, and JavaScript." Motor — "design tokens in CSS custom properties,
  mobile-first semantic HTML, hover/focus/active states." Cerebellum — a quality gate for "responsive
  320/768/1440, WCAG AA, accessibility score ≥ 90." No skill documents *how*, and no tool exists to
  *do* or *measure* any of it.
- **`design-ops`** (the only specialty design skill) is a solid **brand-system methodology** (palette,
  type scale, tokens, component library, cross-medium audits) but is **toolless** (`scripts: []`) and
  medium-agnostic — it governs design systems; it does not produce HTML/CSS.
- **Web best-practices live in the motor SOUL** (a C-28 leak) instead of a skill.
- **No render, preview, export, or measurement.** Dot cannot see its output, and cerebellum is asked
  to score responsiveness / accessibility it has no tool to measure.
- The manifest ships **Slides + Docs tooling only** — zero HTML/CSS.

Grounding: dot is on a project team whose site is hand-authored HTML/CSS — work dot has no governed
way to touch today.

## Target — two single-purpose skills + real tooling + an organ trim

### 1. `design` (primary — the craft, in HTML/CSS)  *(name proposed)*
Owns *how to design well, in HTML/CSS, and convert to any format.* Two halves, deliberately paired:

- **Craft — optimal human visual experience** (the codified best-practice the user is asking for):
  visual hierarchy & a dominant focal point; a typographic system (modular scale, 45–75ch line
  length, line-height rhythm); a spacing system (4/8px); color & contrast; whitespace and restraint;
  reading patterns (F/Z); progressive disclosure; motion used sparingly and purposefully. Principles
  with rationale, not taste.
- **Mechanics** (lifted out of the motor SOUL): semantic HTML; design tokens as CSS custom
  properties; mobile-first responsive; real hover/focus/active states; no inline-style / `!important`
  hacks; consume the project's design system from project context rather than inventing one.
- **Convert:** author the HTML/CSS source, then export to the target format via the tools below.

### 2. `design-ops` (companion — design systems & governance)  *(keep; optional rename `design-system`)*
Medium-agnostic: brand systems, design tokens, component libraries, cross-medium consistency audits.
`design` **consumes** what `design-ops` **defines**. Clear split: `design` = produce a design;
`design-ops` = govern the system a design conforms to.

### 3. Tooling (Full) — corekit `bin/` tools governed by `design`
| Tool *(name proposed)* | Does | Enables |
|---|---|---|
| `design-render` | headless-chrome screenshot at 320 / 768 / 1440 px (+ full-page) | dot *sees* output; cerebellum verifies "no horizontal scroll" and layout |
| `design-export` | HTML/CSS → PDF, → PNG/image; → `.docx`, → `.pptx`, → standalone web | "convert as needed" — one source, many artifacts |
| `design-a11y` | contrast + accessibility score (axe-core) | makes cerebellum's "WCAG AA / a11y ≥ 90" gate real, not aspirational |

**Conversion fidelity (stated honestly — this shapes expectations):**
- HTML → **web / PDF / PNG**: full fidelity, deterministic (headless chrome print/screenshot).
- HTML → **`.docx`**: *structural* (pandoc, or rebuild via `workspace-docs`) — content + hierarchy,
  not pixel-perfect (docx is not a pixel medium).
- HTML → **`.pptx` / Slides**: two paths per deliverable — *pixel-perfect but flat* (render each
  slide-section to an image and place it full-bleed) or *editable but lossy* (rebuild via
  `workspace-slides`).

Infra: chromium/puppeteer (+ pandoc) on dot's VM, declared in `skill.json` `requires` and provisioned
by `skill-setup`. **Precedent:** QA already runs headless chromium in this fleet, so the capability is
proven, not novel.

### 4. Organ trim (C-28, ceremonied)
Move the web methodology out of the motor SOUL into `design`; trim the cortex/cerebellum HTML/CSS
assertions to *character*, letting the **skill** carry the how and the **tools** carry the measurement.
Once the tools exist, the organ claims are **backed and measurable** instead of phantom.
`ORGAN_LOCK` re-pin + `organ-change: intended` trailer.

## Phasing
1. **`design` skill + codified craft** (+ lift the mechanics out of the motor SOUL into it). Immediately
   unblocks HTML/CSS work and de-phantoms the organs — highest value, lowest infra.
2. **`design-render` + `design-export` (PDF/PNG/web) + infra.** Dot can see and export its output.
3. **`design-a11y`** + wire cerebellum's now-measurable gates; the ceremonied organ trim.
4. **docx / pptx conversion** paths (pandoc + render-and-place), per the fidelity notes.
5. Canary on dot each phase (via the `skill-improvement-loop`: stay in the skill layer, keep it generic);
   dot is the sole designer, so a dot canary is fleet-wide.

## Layer discipline
- Craft + mechanics + per-tool procedure + error-recovery → **skill** (`design`, `design-ops`).
- Render/export/a11y binaries → **tools** under `corekit/` governed by the skill (file + manifest same commit, C-9).
- Character-only edits to remove the web-methodology leak → **organ** (ceremonied re-pin).
- A project's brand/design system → **project context** (consumed, never hardcoded in the skill).
- Keep every skill **generic** — no operator brand values baked in (Guardrail 2).

## Open items (operator)
- **Names:** primary `design` vs `visual-design` vs `design-craft`; companion keep `design-ops` vs rename `design-system`; tool prefix `design-*` vs other.
- **docx/pptx:** confirm the fidelity tradeoff (structural / flattened) is acceptable, or scope those two targets to a later phase.
- **Go / refine:** build from Phase 1, or iterate the plan further first.
