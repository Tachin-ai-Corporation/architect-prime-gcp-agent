# Designer Specialty — Cerebellum Verification Rules

## Brand Consistency Check (MANDATORY)
Before marking any design deliverable as complete, verify brand alignment:
- Every color used must match the project palette — hex-verified, not eyeballed.
- Typography must match the brand type stack — font family, weight, and size hierarchy.
- Logo usage must follow placement and clear-space rules.
- FAIL the deliverable if any off-brand color, font, or logo treatment is found.

If no brand guidelines exist, this check verifies internal consistency instead — all
deliverables in the mission must use the same palette and type stack.

## Visual Hierarchy Verification
Every layout must pass these checks:
- Clear focal point — one element dominates attention on each page/slide/screen.
- Logical reading order — content flows naturally without requiring the viewer to hunt.
- Intentional whitespace — spacing creates grouping and separation, not just emptiness.
- Contrast supports hierarchy — most important elements have highest contrast.

## Slides Quality Gate
Before completing any slide deck:
- Consistent margins across all slides — spot-check at least 3 non-adjacent slides.
- No orphaned text (single words on a line) or widows (single lines on a slide).
- All images are high-resolution — no pixelation at presentation resolution.
- Every slide has speaker notes with presenter guidance.
- Slide count is appropriate — flag decks over 20 slides for scope review.

## HTML/CSS Quality Gate
Before completing any HTML/CSS deliverable:
- Responsive at three breakpoints: 320px (mobile), 768px (tablet), 1440px (desktop).
- All interactive elements have visible hover and focus states.
- No horizontal scroll at any breakpoint.
- Accessibility score ≥ 90 (Lighthouse or equivalent criteria).
- All images have meaningful alt text.
- Color contrast meets WCAG AA on every text element.

## Design Spec Completeness
Before completing any design specification document:
- Every component is documented with all visual properties.
- All interactive states are defined (default, hover, active, disabled, error).
- Responsive behavior is specified for each breakpoint.
- Spacing and layout rules use consistent units and a defined scale.
- At least one Do/Don't example exists for commonly misapplied guidelines.

## Cross-Deliverable Consistency
When a mission produces multiple deliverables (Slides + Docs, Docs + HTML, etc.):
- Same colors must appear across all deliverables — hex-verified match.
- Same typography hierarchy must be used across all deliverables.
- Terminology and naming must be consistent across all deliverables.
- Flag any discrepancy as a verification failure before completion.

### Workspace Convention Gate
- ✅ PASS if work products written to `shared/{missionId}/` (git-tracked automatically)
- ✅ PASS if agent used `work-publish` for stakeholder-facing Drive uploads
- ⚠️ WARN if agent used raw `drive-upload` — suggest `work-publish` next time
- ✅ PASS if no artifacts were produced (read-only mission)
