# Skill: Site Audit (review a website + propose ranked improvements)

## When to Use
When you own a website surface and either (a) the owner asks you to review or improve it ("make it
better", "what would you improve", "take a look"), or (b) an open-ended request invites more than the
literal ask — and you want to find, rank, and PROPOSE concrete improvements. This produces a **ranked
proposal**, not applied changes: you surface it for the owner to choose, and you prototype the strongest
idea on a staging preview. It is NOT for a narrow literal task (change a word, fix one link, update a
price) — do that directly and stop.

This is a **procedure, not a program.** There is no `site-audit` command. You run it with tools you
already have — `curl`, your `design-render` and `design-a11y` tools, and reading the site's source in the
mission workspace.

## The method — inspect, rank, propose (never auto-apply)
1. **Establish the target + baseline.** Confirm the live URL(s) and the source from the project's
   deployment descriptor (the hosting site and the source repo/dir are named there — never guess them).
   Fetch the live page (`curl -sSL <url>`) AND render it (`design-render`) so you judge what a visitor
   actually sees, not just the source. Read the brand/design system (tokens, type scale, spacing, voice);
   every proposal conforms to it.
2. **Walk the dimensions** (below). For each, record concrete FINDINGS with evidence — the element, the
   line, the measured number, the a11y rule — never a vibe.
3. **Rank.** Score each finding by impact (how much it helps the visitor or the site's goal) against
   effort and risk (chance of regressing), and order them. Keep the few highest-leverage items.
4. **Propose.** Write a short ranked list: each item = the finding, the proposed change, why it matters,
   and rough effort. For the #1 item only, build it on a **staging preview channel** and include the link,
   so the owner can look, not only read. Apply NOTHING to production; change nothing the owner didn't ask
   for beyond that single staged preview.
5. **Carry the decision.** When the owner picks, iterate on staging, promote the approved version through
   the gate, and record what they chose (and rejected) in the project's context/canon so the next review
   is more aligned.

## Dimensions (generic — apply the ones that fit the site)
- **Message & hierarchy** — Does a visitor grasp what this is and why it matters in ~5 seconds? Is the
  most important thing the most prominent? Is the primary call-to-action obvious?
- **Brand & visual consistency** — Type scale, color, spacing rhythm, component style consistent and
  on-system? Any orphaned or off-brand element?
- **Responsive / mobile** — Render at mobile and desktop widths (`design-render` viewport). Any overflow,
  tap target too small, broken layout, or content hidden on small screens?
- **Accessibility** — Run `design-a11y`; check contrast, alt text, heading order, form labels, focus
  order. Report WCAG issues by severity.
- **Performance & weight** — Page and asset byte weight, oversized images, render-blocking bulk. A hero
  image many times larger than it needs to be is a finding.
- **SEO & social preview** — Is there a `<title>`, a `<meta name="description">`, and an Open Graph /
  Twitter card? Do they MATCH the visible copy? (A stale meta description that contradicts the current
  hero is a real defect — the page changed and the preview didn't.) Is there a social preview image?
- **Links & assets** — `curl` the internal links and referenced assets; flag any 404, broken image, or
  dead route.
- **Content freshness & voice** — Typos, stale dates or prices, leftover placeholder text, tone that
  drifts from the brand voice.
- **UX & conversion** — Are forms and CTAs clear and reachable? Any dead-end, confusing step, or friction
  on the primary flow?

## Output — the proposal (what you hand back)
A ranked list the owner can act on, e.g.:
> **Proposed improvements for `<site>`** (staging preview of #1: `<url>`)
> 1. **[high impact / low effort]** *Finding* → *proposed change* — *why it matters*
> 2. **[…]** …
>
> Nothing above is applied to production. #1 is on the staging preview for you to look at; say the word
> and I'll refine or ship any of these.

Keep it to the few that matter, each with a reason. A dump of twenty nitpicks is a worse proposal than
three that move the needle.

## Guardrails
- **Propose, don't impose.** Surface improvements; apply only what the owner approves. Never touch
  production without the approval gate.
- **Match ambition to the ask.** A narrow literal task is not an audit trigger — do it directly. Reserve
  the full audit for a review/improve request or an open invitation.
- **Stay in the system.** Improvements are polish within the site's brand/design system by default;
  propose a bolder move (a new section, a redesign) only when the owner invites it, and still conform to
  hierarchy and brand.
- **Ranked & few.** The highest-leverage handful, each with a reason — not an exhaustive lint list.
- **Evidence, not vibes.** Every finding cites the concrete thing (element, line, measured number, a11y
  rule).

## Error Recovery
| Symptom | Likely cause | Recovery |
|---|---|---|
| Can't reach the live URL | Wrong URL, or the site isn't deployed | Confirm the URL from the project's deployment descriptor; if it is genuinely down, report that as finding #1 rather than auditing a 404. |
| `design-render` shows a blank or partial page | The page's JS didn't run, or an inline script is broken | Render again after the load settles; if a section is still blank, that IS a finding (a render defect) — confirm it against the source. |
| The audit balloons into a huge list | Nitpicking every pixel | Re-rank by impact and cut to the few that move the needle; the owner wants leverage, not a lint dump. |
| Tempted to just fix it | An improvement looks trivial | Unless it is the literal ask, PROPOSE it (with a staging preview). An unrequested change to a live site is never yours to make alone. |

## Safety
- This skill READS and PROPOSES. It never applies a change to production; a staging preview is how you
  show a proposal.
- Conform every proposed change to the site's brand/design system and information hierarchy.
- Record the owner's choices so future proposals align; a suggestion from the owner outranks an idea of
  your own.
