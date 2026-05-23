# 1health Design System

**Brand:** 1health  
**Domain:** app.1health.io  
**Purpose:** A practical design system for AI agents and humans designing or redesigning 1health documents, decks, web pages, and applications.  
**Version:** 0.1  

---

## 1. Brand Intent

1health should feel like a modern healthcare platform: calm, trustworthy, precise, interoperable, and product-led. The design language should communicate reliability without feeling cold, and innovation without feeling flashy.

The system should avoid visual noise. Every screen, slide, page, and document should feel like it was intentionally reduced to the clearest possible version of the message.

### Core adjectives

- Modern
- Clinical
- Calm
- Trustworthy
- Networked
- Intelligent
- Operationally reliable
- Enterprise-ready

### Design philosophy

The 1health experience should feel like a **healthcare command center**: quiet, structured, responsive, and confidence-building.

Use motion, glow, emphasis, and color sparingly. They should guide attention, not decorate the interface.

---

## 2. Logo and Brand Usage

### Brand name

Always write the brand as:

```text
1health
```

Do not capitalize it as `1Health`, `1 Health`, or `OneHealth` unless quoting another source.

### Wordmark

Use the 1health wordmark prominently in brand-led contexts:

- Cover slides
- Landing pages
- Product introductions
- Login screens
- External-facing documents
- Executive summaries

For app screens, use the wordmark only where it adds clarity. In dense product UI, the icon alone may be sufficient.

### Icon

The app icon uses a rounded-square dark base with a white `1h` mark. Use it for:

- App launcher contexts
- Favicons
- Sidebar headers
- Compact navigation
- Deck section markers
- Internal app tiles

### Clear space

Maintain minimum clear space equal to the height of the `h` counter or approximately 20% of the logo height on all sides.

### Logo behavior on dark backgrounds

Preferred logo treatment:

- Dark gray wordmark on near-black background for subtle, premium brand presence
- White or light icon mark inside dark rounded-square container
- Use teal or blue accent lines to create structure

### Logo behavior on light backgrounds

Use Graphite or Charcoal wordmark. Avoid pure black unless required for print contrast.

---

## 3. Color System

The 1health palette is built around cool neutrals, healthcare blue/teal accents, warm action colors, and clear functional status states.

### 3.1 Primary / Base

Use these for backgrounds, text, cards, panels, dividers, and core UI structure.

| Token | Name | Hex | Primary use |
|---|---|---:|---|
| `--color-graphite` | Graphite | `#202833` | Main dark background, primary dark text |
| `--color-charcoal` | Charcoal | `#313B47` | Cards, app chrome, icon background |
| `--color-slate` | Slate | `#566373` | Secondary text, borders, disabled UI |
| `--color-mist` | Mist | `#AEB8C4` | Muted text, inactive states, subtle dividers |
| `--color-cloud` | Cloud | `#E6EBF0` | Light surfaces, reversed text, pale backgrounds |

### 3.2 Healthcare / Platform

Use these as the distinctive 1health platform color family.

| Token | Name | Hex | Primary use |
|---|---|---:|---|
| `--color-trust-blue` | Trust Blue | `#246B8F` | Primary brand accent, links, key platform actions |
| `--color-network-teal` | Network Teal | `#1F9A9B` | Interoperability, connection, active states |
| `--color-care-mint` | Care Mint | `#5FC7B2` | Positive health signals, completion, confirmation |
| `--color-signal-aqua` | Signal Aqua | `#8FD8E6` | Highlights, chart accents, soft hover glow |
| `--color-clinical-ice` | Clinical Ice | `#E8F7FA` | Light tint backgrounds, info panels |

### 3.3 Action / Emphasis

Use these sparingly for attention, urgency, and critical actions.

| Token | Name | Hex | Primary use |
|---|---|---:|---|
| `--color-pulse` | Pulse | `#D84F45` | Critical action, urgent emphasis, destructive states |
| `--color-coral` | Coral | `#E8786F` | Softer warning/emphasis |
| `--color-blush` | Blush | `#F2C8C3` | Light alert background |
| `--color-amber` | Amber | `#D6A83A` | Warning, attention, pending decision |
| `--color-glow` | Glow | `#F5E6B8` | Soft highlight background |

### 3.4 Functional Status

Use status colors consistently across apps, decks, dashboards, and documents.

| Token | Name | Hex | Meaning |
|---|---|---:|---|
| `--status-success` | Success | `#3BAA78` | Complete, verified, healthy, approved |
| `--status-info` | Info | `#2F80A8` | Informational, neutral notice, system message |
| `--status-warning` | Warning | `#D6A83A` | Needs attention, pending, at risk |
| `--status-error` | Error | `#D84F45` | Failed, blocked, rejected, critical |
| `--status-neutral` | Neutral | `#7A8696` | Unknown, inactive, not started |

### 3.5 Color rules

1. Use cool neutrals as the foundation.
2. Use Trust Blue and Network Teal for brand recognition.
3. Use warm colors only when the user needs to act or understand risk.
4. Do not use red decoratively.
5. Do not use more than one primary accent color in the same component group unless showing status or data categories.
6. Avoid rainbow dashboards. Prefer structured, meaningful color.
7. In executive documents and decks, use fewer colors than in product UI.

### 3.6 Recommended color ratios

For most compositions:

- 70% neutral structure
- 20% healthcare/platform accent
- 5% action/emphasis
- 5% functional status

For dense product screens:

- 80% neutral structure
- 10% healthcare/platform accent
- 10% status/action colors

---

## 4. Typography

1health uses **Inter only**.

### 4.1 Font family

```css
font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

### 4.2 Font roles

| Role | Weight | Use |
|---|---:|---|
| Inter Bold | 700 | Page titles, major deck headlines, hero statements |
| Inter SemiBold | 600 | Section headers, card titles, button labels |
| Inter Medium | 500 | Metadata, labels, navigation, table headers |
| Inter Regular | 400 | Body text, descriptions, paragraphs |

### 4.3 Type scale

Use a restrained type scale. Avoid too many competing sizes.

| Token | Size | Line height | Use |
|---|---:|---:|---|
| `display` | 56px | 64px | Hero slides, landing page headlines |
| `h1` | 40px | 48px | Page titles, major document headers |
| `h2` | 32px | 40px | Section openers |
| `h3` | 24px | 32px | Card groups, subsections |
| `h4` | 20px | 28px | Card titles, panel headers |
| `body-lg` | 18px | 28px | Executive prose, deck body text |
| `body` | 16px | 24px | Default UI and document text |
| `body-sm` | 14px | 20px | Tables, helper text, metadata |
| `caption` | 12px | 16px | Labels, timestamps, secondary details |

### 4.4 Typography rules

1. Use sentence case for most UI labels and document headings.
2. Avoid all caps except for small metadata labels.
3. Do not mix fonts.
4. Avoid long lines of text. Target 60–80 characters per line in documents and web pages.
5. Use weight before color to create hierarchy.
6. Use spacing before decoration.

---

## 5. Layout System

### 5.1 Spacing

Use an 8px spacing grid.

| Token | Value | Use |
|---|---:|---|
| `space-1` | 4px | Tight internal spacing |
| `space-2` | 8px | Small gaps, icon/text spacing |
| `space-3` | 12px | Compact component padding |
| `space-4` | 16px | Default component padding |
| `space-5` | 24px | Card spacing, section gaps |
| `space-6` | 32px | Major component groups |
| `space-7` | 48px | Page sections |
| `space-8` | 64px | Hero sections, deck divisions |
| `space-9` | 96px | Large landing page breaks |

### 5.2 Radius

Use rounded corners to soften enterprise healthcare UI without making it playful.

| Token | Value | Use |
|---|---:|---|
| `radius-sm` | 6px | Tags, inputs, small UI |
| `radius-md` | 10px | Buttons, table filters |
| `radius-lg` | 16px | Cards, panels, modals |
| `radius-xl` | 24px | Hero cards, large containers |
| `radius-icon` | 22% | App icons, product tiles |

### 5.3 Shadows and elevation

Prefer subtle depth. Avoid heavy drop shadows.

| Level | Shadow | Use |
|---|---|---|
| Level 0 | none | Flat panels, tables |
| Level 1 | `0 4px 16px rgba(0,0,0,0.18)` | Cards on dark surfaces |
| Level 2 | `0 8px 28px rgba(0,0,0,0.24)` | Floating panels, menus |
| Level 3 | `0 16px 48px rgba(0,0,0,0.32)` | Modals, major overlays |

### 5.4 Glows

Use glow only for active states, hover states, and important call-to-action moments.

Preferred glow:

```css
box-shadow: 0 0 0 1px rgba(143, 216, 230, 0.32),
            0 0 24px rgba(143, 216, 230, 0.18);
```

Rules:

1. Glow should be subtle and brief.
2. Do not glow every card on a page.
3. Never combine glow, heavy shadow, bright border, and animation on the same element.
4. Use Signal Aqua for soft glow and Network Teal for active outlines.

---

## 6. Motion and Interaction

Motion should make the interface feel responsive and intelligent. It should never slow the user down.

### 6.1 Easing

Default easing:

```css
cubic-bezier(0.16, 1, 0.3, 1)
```

Use this for most entrance, hover, and panel transitions. It feels smooth, efficient, and premium.

Secondary easing:

```css
cubic-bezier(0.4, 0, 0.2, 1)
```

Use this for standard UI transitions where a familiar material-style ease-in-out is appropriate.

### 6.2 Duration

| Motion type | Duration |
|---|---:|
| Hover response | 120–180ms |
| Button press | 80–120ms |
| Tooltip/menu open | 120–160ms |
| Panel/card entrance | 180–240ms |
| Modal entrance | 220–280ms |
| Page transition | 240–360ms |
| Loading shimmer | 900–1400ms loop |

### 6.3 Hover behavior

Standard hover pattern:

- Raise element by 1–2px
- Slightly brighten border or surface
- Add soft aqua or teal glow only for interactive cards or primary actions
- Do not scale above 1.02 unless the element is large and isolated

Example:

```css
transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
            box-shadow 160ms cubic-bezier(0.16, 1, 0.3, 1),
            border-color 160ms cubic-bezier(0.16, 1, 0.3, 1),
            background-color 160ms cubic-bezier(0.16, 1, 0.3, 1);

.card:hover {
  transform: translateY(-2px);
  border-color: rgba(143, 216, 230, 0.42);
  box-shadow: 0 0 0 1px rgba(143, 216, 230, 0.24),
              0 12px 32px rgba(0, 0, 0, 0.24);
}
```

### 6.4 Press behavior

Buttons and interactive cards should compress slightly on press.

```css
.button:active {
  transform: translateY(0) scale(0.99);
}
```

### 6.5 Reduced motion

Always support reduced motion.

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 7. Cognitive Load Standards

The 1health interface should reduce cognitive load by limiting choices, grouping information, and making the next action obvious.

### 7.1 Screen density rules

For app screens:

1. One primary user goal per screen.
2. One primary call-to-action per view.
3. Maximum 2 secondary actions visible at the same hierarchy level.
4. Maximum 5 major content groups per screen.
5. Maximum 7 visible navigation items in a single menu group.
6. Tables should default to the most important 5–7 columns.
7. Hide advanced controls behind filters, drawers, accordions, or progressive disclosure.

For landing pages:

1. One major idea per section.
2. Avoid more than 3 cards in a row unless scanning/comparison is the explicit goal.
3. Use section headers to tell the story before the user reads details.
4. Use visual rhythm: headline, supporting text, proof, action.

For decks:

1. One claim per slide.
2. Maximum 3 major bullets per slide.
3. Use supporting details in speaker notes or appendix slides.
4. Prefer diagrams over dense paragraphs.
5. Each slide should be understandable in 5 seconds.

For documents:

1. Use executive summary first.
2. Use scannable headings.
3. Use tables only when they improve comparison.
4. Put recommendations before supporting detail.
5. Avoid long undifferentiated paragraphs.

### 7.2 Progressive disclosure

Use progressive disclosure whenever a screen contains:

- Advanced filters
- Bulk actions
- Audit logs
- Technical configuration
- Legal/compliance detail
- Long histories
- Debug data
- Rarely used settings

Default state should show the user what matters now. Details should be available but not forced.

### 7.3 Empty states

Every empty state should include:

1. A plain-language explanation of what is missing.
2. Why it matters.
3. One clear next action.

Example pattern:

```text
No provider connections yet
Connect your first provider organization to begin routing requests, results, and follow-up workflows through 1health.
[Add provider]
```

---

## 8. Component Design Standards

### 8.1 Buttons

#### Primary button

Use for the single most important action on a screen.

- Background: Trust Blue or Network Teal
- Text: white
- Radius: 10px
- Padding: 12px 18px
- Font: Inter SemiBold 14–16px
- Hover: brighten slightly, add subtle Signal Aqua glow
- Press: compress slightly

#### Secondary button

Use for supportive actions.

- Background: transparent or Charcoal
- Border: Slate at low opacity
- Text: Cloud or Mist
- Hover: border shifts toward Signal Aqua

#### Destructive button

Use only for irreversible or high-risk actions.

- Background: Pulse
- Text: white
- Require confirmation when destructive action affects multiple records, data integrity, or external communication.

#### Button rules

1. Do not place two primary buttons side by side.
2. If there are multiple actions, visually rank them.
3. Use verbs: `Create request`, `Send invite`, `Connect provider`.
4. Avoid vague labels like `Submit`, `OK`, or `Click here`.

### 8.2 Cards

Cards should organize related content into digestible units.

Default card:

- Background: Charcoal or white, depending on theme
- Border: 1px Slate at 20–35% opacity
- Radius: 16px
- Padding: 24px
- Header, body, action area

Interactive card hover:

- Translate up 2px
- Add subtle aqua glow
- Change border to Signal Aqua at low opacity

Card rules:

1. Cards should not contain more than 2–3 competing actions.
2. Card titles should be short and scannable.
3. Use icons only when they clarify category or status.
4. Do not overuse cards for simple lists.

### 8.3 Inputs and forms

Inputs should feel calm and precise.

Default input:

- Height: 40–44px
- Radius: 10px
- Border: Slate at 40% opacity
- Background: Graphite or white depending on theme
- Focus border: Network Teal
- Focus glow: subtle Signal Aqua

Form rules:

1. Group fields by user intent, not database structure.
2. Use helper text where mistakes are common.
3. Validate inline as soon as it is useful, not before the user has finished typing.
4. Required fields should be obvious but not visually aggressive.
5. Error text should explain how to fix the issue.

### 8.4 Tables

Tables are common in healthcare operations but can become overwhelming. Design them for scanning first.

Default table rules:

1. Show only the most important columns by default.
2. Freeze key identity columns when tables scroll horizontally.
3. Use status chips instead of raw status text where helpful.
4. Use row hover to indicate clickability.
5. Put bulk actions in a toolbar that appears after selection.
6. Keep row height between 44–56px for operational screens.
7. Use pagination or virtualization for large datasets.

Table visual style:

- Header: Inter Medium 12–14px, Slate/Mist
- Body: Inter Regular 14px
- Divider: Slate at 16–24% opacity
- Selected row: Clinical Ice tint in light mode or Trust Blue tint in dark mode

### 8.5 Status chips

Status chips should be compact, readable, and semantically colored.

| Status | Color |
|---|---|
| Success / complete / verified | Success |
| Info / sent / available | Info |
| Warning / pending / needs attention | Warning |
| Error / failed / blocked | Error |
| Neutral / unknown / not started | Neutral |

Chip style:

- Radius: full pill
- Font: Inter Medium 12px
- Padding: 4px 8px
- Use light tint background with darker semantic text in light mode
- Use transparent semantic border with muted fill in dark mode

### 8.6 Navigation

Navigation should be calm and predictable.

Rules:

1. Keep primary navigation to 5–7 items.
2. Use clear nouns: `Requests`, `Providers`, `Patients`, `Workflows`, `Reports`, `Settings`.
3. Use active state with Network Teal line, pill, or left border.
4. Avoid deep nesting unless the application is complex enough to require it.
5. In sidebars, group rarely used admin tools separately.

### 8.7 Modals and drawers

Use modals for decisions and focused tasks. Use drawers for context-preserving detail views.

Modal rules:

1. Use for confirmations, short forms, and focused interruptions.
2. Do not use modals for complex workflows.
3. Primary action belongs bottom right.
4. Cancel or secondary action belongs bottom left or to the left of primary.

Drawer rules:

1. Use for record detail, audit history, metadata, and contextual actions.
2. Keep the underlying page visible when context matters.
3. Include a clear close affordance.

### 8.8 Alerts and notifications

Alerts should be calm, specific, and actionable.

Alert structure:

1. Status icon or color cue
2. Short title
3. Plain-language detail
4. Action, if relevant

Avoid generic alerts like:

```text
Error occurred.
```

Prefer:

```text
Fax could not be sent
The provider fax number is missing. Add a fax number before retrying.
```

### 8.9 Loading states

Use loading states to preserve trust.

Preferred patterns:

- Skeleton loaders for page-level and table loading
- Spinner only for short inline actions
- Progress steps for long-running workflows
- Clear queued/running/complete states for background jobs

Do not leave users wondering whether the system is working.

---

## 9. UX Writing Standards

1health copy should be plainspoken, direct, and calm.

### Voice

- Clear over clever
- Confident but not hype-driven
- Clinical but human
- Operationally precise

### Preferred wording

Use:

- `Connect provider`
- `Create request`
- `Review results`
- `Needs attention`
- `Ready to send`
- `No action needed`

Avoid:

- `Leverage synergies`
- `Click here`
- `Submit`
- `Oops`
- `Something went wrong`
- `Utilize` when `use` works

### Error messages

Error messages should include:

1. What happened
2. Why it matters, if not obvious
3. How to fix it

### Confirmation messages

Use calm, specific confirmations:

```text
Provider invite sent
```

```text
Request saved as draft
```

```text
Record marked as not my patient
```

---

## 10. Data Visualization

Healthcare data must be readable, trustworthy, and decision-oriented.

### 10.1 Chart rules

1. Use charts only when they clarify comparison, trend, distribution, or progress.
2. Prefer bar charts for comparisons.
3. Prefer line charts for time trends.
4. Prefer simple KPI cards for single metrics.
5. Avoid pie charts unless there are very few categories and the whole matters.
6. Do not use 3D charts.
7. Always label axes and units.
8. Use direct labels when possible.
9. Do not rely on color alone.

### 10.2 Dashboard rules

1. Start with the operational question the user needs answered.
2. Place the most important KPI in the upper-left or primary hero area.
3. Use status colors consistently.
4. Keep dashboard sections grouped by decision type.
5. Provide drill-down paths without cluttering the top-level view.

### 10.3 Recommended chart palette

Use in this order unless semantic status colors are required:

1. Trust Blue `#246B8F`
2. Network Teal `#1F9A9B`
3. Care Mint `#5FC7B2`
4. Signal Aqua `#8FD8E6`
5. Amber `#D6A83A`
6. Slate `#566373`

Use Pulse only for negative or urgent values.

---

## 11. Accessibility

Accessibility is required, not optional.

### Standards

1. Target WCAG 2.1 AA contrast minimum.
2. Do not rely on color alone for meaning.
3. All interactive elements must have visible focus states.
4. Touch targets should be at least 44px high.
5. Use semantic headings in documents and web pages.
6. Provide alt text for meaningful images.
7. Respect reduced motion preferences.
8. Tables must have clear headers.
9. Form errors must be programmatically associated with fields.

### Focus state

Preferred focus treatment:

```css
outline: 2px solid #8FD8E6;
outline-offset: 2px;
```

For dark UI, pair focus outline with subtle glow.

---

## 12. Documents

1health documents should feel executive-ready and easy to scan.

### Document structure

Preferred order:

1. Title
2. Executive summary
3. Key recommendation or decision needed
4. Context
5. Details
6. Risks / tradeoffs
7. Next steps
8. Appendix, if needed

### Document styling

- Use Inter throughout.
- Use Graphite for primary text.
- Use Trust Blue or Network Teal for links and section accents.
- Use subtle dividers between major sections.
- Avoid decorative color blocks unless they clarify content.
- Use callout boxes sparingly for key decisions, risks, or recommendations.

### Document component patterns

#### Executive callout

Use for the main point:

- Border-left: Network Teal
- Background: Clinical Ice
- Title: Inter SemiBold
- Body: Inter Regular

#### Risk callout

Use for important warnings:

- Border-left: Amber or Pulse
- Background: Glow or Blush
- Do not overuse red

---

## 13. Decks and Presentations

1health decks should be clear, modern, and restrained. Avoid clutter and over-decoration.

### Slide principles

1. One message per slide.
2. Use strong section titles.
3. Use fewer, larger elements.
4. Use whitespace to create confidence.
5. Favor diagrams and structured comparisons over paragraphs.
6. Use the dark brand style for high-impact title and section divider slides.
7. Use light backgrounds for dense content slides when readability is more important than drama.

### Recommended slide types

#### Title slide

- Dark background
- Large 1health wordmark or icon
- Large Inter Bold title
- Thin Network Teal divider line
- Subtitle in Mist or Cloud

#### Executive summary slide

- One headline claim
- Three supporting cards maximum
- Optional recommendation callout

#### Problem / solution slide

- Left: problem statement
- Right: 1health solution
- Use Trust Blue / Network Teal contrast

#### Architecture slide

- Use clean blocks and directional lines
- Use neutral containers with teal connection lines
- Avoid excessive iconography

#### Roadmap slide

- Use horizontal timeline
- Use status chips for phase state
- Keep milestones short

---

## 14. Web Pages

1health web pages should feel like a healthcare infrastructure platform: calm, credible, and conversion-aware.

### Page structure

Recommended landing page flow:

1. Hero: clear value proposition and one primary CTA
2. Problem: operational pain or market friction
3. Platform answer: what 1health enables
4. Product/app modules: grouped cards
5. Proof or workflow example
6. Security/compliance/trust section
7. CTA

### Hero section

- Large Inter Bold headline
- Short supporting paragraph
- One primary CTA, one secondary CTA maximum
- Use dark background with subtle gradient or dark card surface
- Use teal line, glow, or diagram accent sparingly

### Web component feel

- Rounded panels
- Calm hover lift
- Subtle teal glow for interactive product tiles
- Clear CTA hierarchy
- Minimal decorative imagery unless it explains the platform

---

## 15. Applications

1health apps should prioritize operational efficiency, clarity, and trust.

### App shell

Recommended structure:

- Sidebar or top navigation depending on app complexity
- Clear page title and description
- Primary action in predictable top-right position
- Filters near the data they affect
- Contextual detail in drawer or right panel
- Status and system feedback always visible when relevant

### App screen hierarchy

Every app screen should answer:

1. Where am I?
2. What matters here?
3. What needs attention?
4. What can I do next?
5. What changed after I acted?

### Operational workflow pattern

For healthcare workflows, use this pattern:

1. Intake / source
2. Match / validate
3. Review / resolve exceptions
4. Send / execute
5. Track / audit
6. Complete / report

### Avoid

- Dense screens with every possible field exposed
- Multiple competing primary buttons
- Red-heavy interfaces
- Animation that delays work
- Icon-only actions without labels in complex workflows
- Raw technical errors shown to non-technical users

---

## 16. AI Agent Design Instructions

When an AI agent designs or redesigns a 1health artifact, it must follow these rules.

### 16.1 Always start with intent

Before designing, identify the artifact type:

- Document
- Deck
- Web page
- App screen
- Dashboard
- Workflow
- Form
- Email or notification

Then identify the primary audience:

- Executive
- Product
- Engineering
- Operations
- Provider organization
- Payer organization
- Patient/member
- Internal admin

Then identify the primary user goal.

### 16.2 Reduce before styling

Do not start by adding visuals. First reduce the content:

1. Remove duplicate ideas.
2. Group related concepts.
3. Promote the main point.
4. Hide secondary detail.
5. Make the next action obvious.

Only then apply brand styling.

### 16.3 Default visual approach

Use this default style unless the task says otherwise:

- Inter font
- Graphite / Charcoal foundation
- Trust Blue and Network Teal accents
- Minimal glow
- Rounded cards
- Calm spacing
- One primary action
- Clear section hierarchy

### 16.4 Component selection

Use:

- Cards for grouped concepts
- Tables for operational records
- Chips for statuses
- Drawers for contextual detail
- Modals for focused decisions
- Timelines for process/roadmap
- Callouts for recommendations or risks
- Diagrams for systems and workflows

Avoid:

- Decorative components without purpose
- Excess icons
- Large gradients on dense screens
- Multiple simultaneous emphasis colors
- Long paragraphs in slide designs

### 16.5 Final design checklist

Before producing a final design, verify:

- Brand name is written as `1health`
- Inter is the only font
- Palette matches this system
- One clear primary action exists, if action is needed
- No unnecessary red is used
- Layout uses whitespace intentionally
- Content is grouped by user task
- Status colors are semantic
- Hover/focus/active states are specified for interactive work
- Accessibility is not sacrificed for style

---

## 17. CSS Token Starter

```css
:root {
  /* Typography */
  --font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

  /* Primary / Base */
  --color-graphite: #202833;
  --color-charcoal: #313B47;
  --color-slate: #566373;
  --color-mist: #AEB8C4;
  --color-cloud: #E6EBF0;

  /* Healthcare / Platform */
  --color-trust-blue: #246B8F;
  --color-network-teal: #1F9A9B;
  --color-care-mint: #5FC7B2;
  --color-signal-aqua: #8FD8E6;
  --color-clinical-ice: #E8F7FA;

  /* Action / Emphasis */
  --color-pulse: #D84F45;
  --color-coral: #E8786F;
  --color-blush: #F2C8C3;
  --color-amber: #D6A83A;
  --color-glow: #F5E6B8;

  /* Functional Status */
  --status-success: #3BAA78;
  --status-info: #2F80A8;
  --status-warning: #D6A83A;
  --status-error: #D84F45;
  --status-neutral: #7A8696;

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --space-9: 96px;

  /* Radius */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --radius-icon: 22%;

  /* Motion */
  --ease-premium: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --duration-hover: 160ms;
  --duration-panel: 220ms;
  --duration-page: 300ms;

  /* Shadows */
  --shadow-1: 0 4px 16px rgba(0, 0, 0, 0.18);
  --shadow-2: 0 8px 28px rgba(0, 0, 0, 0.24);
  --shadow-3: 0 16px 48px rgba(0, 0, 0, 0.32);

  /* Glow */
  --glow-aqua: 0 0 0 1px rgba(143, 216, 230, 0.32), 0 0 24px rgba(143, 216, 230, 0.18);
}
```

---

## 18. Tailwind Starter Mapping

```js
export const oneHealthTheme = {
  fontFamily: {
    sans: ['Inter', 'system-ui', 'sans-serif'],
  },
  colors: {
    graphite: '#202833',
    charcoal: '#313B47',
    slate: '#566373',
    mist: '#AEB8C4',
    cloud: '#E6EBF0',
    trustBlue: '#246B8F',
    networkTeal: '#1F9A9B',
    careMint: '#5FC7B2',
    signalAqua: '#8FD8E6',
    clinicalIce: '#E8F7FA',
    pulse: '#D84F45',
    coral: '#E8786F',
    blush: '#F2C8C3',
    amber: '#D6A83A',
    glow: '#F5E6B8',
    success: '#3BAA78',
    info: '#2F80A8',
    warning: '#D6A83A',
    error: '#D84F45',
    neutral: '#7A8696',
  },
  borderRadius: {
    sm: '6px',
    md: '10px',
    lg: '16px',
    xl: '24px',
  },
  transitionTimingFunction: {
    premium: 'cubic-bezier(0.16, 1, 0.3, 1)',
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
};
```

---

## 19. Do / Do Not

### Do

- Use Inter only.
- Use cool neutrals as the base.
- Use teal/blue accents to guide attention.
- Keep screens and slides focused.
- Make status meaning consistent.
- Use motion lightly and purposefully.
- Prioritize clarity over visual novelty.
- Design for healthcare operations and enterprise trust.

### Do not

- Do not capitalize 1health incorrectly.
- Do not use red unless something is urgent, destructive, or failed.
- Do not overload screens with every available field.
- Do not use multiple glowing elements at once.
- Do not use gradients as a substitute for hierarchy.
- Do not create rainbow dashboards.
- Do not hide important status or error information.
- Do not make users guess what to do next.

---

## 20. Canonical Design Prompt for AI Agents

Use this prompt when asking an AI agent to create a 1health-branded artifact:

```text
Design this artifact using the 1health design system. Use Inter only. Keep the brand name lowercase as 1health. Use a calm healthcare SaaS visual style with Graphite, Charcoal, Slate, Mist, and Cloud as the foundation, and Trust Blue / Network Teal as the primary accents. Use Pulse, Amber, and status colors only semantically. Reduce cognitive load: one primary idea per section, one primary action per screen, and no more than 3 major options at the same decision level. Use rounded cards, clear spacing, subtle hover lift, soft aqua focus/hover glow, and premium ease-out motion using cubic-bezier(0.16, 1, 0.3, 1). Prioritize clarity, trust, accessibility, and enterprise healthcare readiness over decorative visuals.
```
