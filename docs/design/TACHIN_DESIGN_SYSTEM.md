# Tachin.ai Design System

> Single source of truth for every visual decision on the tachin.ai marketing website.
> Every value below is a design token — reference by name, never by raw number.

---

## Design Principles

1. **Trust before flash** — Healthcare buyers need to feel safe. Whitespace, calm color, legible type.
2. **Clinical clarity** — Information is organized and scannable. Strong hierarchy.
3. **Warm, human, not sterile** — A warm accent keeps it from feeling like a lab report.
4. **One system, applied everywhere** — Every value is a token. No magic numbers.

---

## Color Tokens

### Why light, not dark?

Trust-driven healthcare brands read light and clinical as credible. Dark "SaaS hacker" palettes signal startup energy but undermine the gravitas healthcare buyers expect. Our palette is calm, airy, and professional — a digital white coat.

### Brand

| Token            | Hex       | Usage                                              |
| ---------------- | --------- | -------------------------------------------------- |
| `primary`        | `#0E7C86` | Deep teal — primary buttons, links, active states  |
| `primary-dark`   | `#0A5A62` | Hover/pressed states on primary elements            |
| `primary-light`  | `#E6F4F5` | Hero washes, feature-icon tiles, subtle highlights  |
| `accent`         | `#FF6B5D` | Warm coral — CTA buttons, key callouts              |
| `accent-dark`    | `#E5524A` | Hover/pressed states on accent elements             |

### Neutrals

| Token        | Hex       | Usage                                    |
| ------------ | --------- | ---------------------------------------- |
| `ink`        | `#14202B` | Primary text, footer background          |
| `ink-soft`   | `#4A5A66` | Secondary text, descriptions             |
| `ink-faint`  | `#8295A1` | Tertiary text, captions, roles           |
| `line`       | `#E2E8EC` | Borders, dividers                        |
| `surface`    | `#FFFFFF` | Card backgrounds, nav background         |
| `canvas`     | `#F7FAFB` | Page background                          |
| `canvas-alt` | `#EFF5F6` | Alternating section background           |

### Semantic

| Token     | Hex       | Usage                          |
| --------- | --------- | ------------------------------ |
| `success` | `#1FA971` | Positive states, confirmations |
| `warning` | `#E2A53C` | Caution states, alerts         |
| `danger`  | `#D9534F` | Error states, destructive      |
| `focus`   | `#0E7C86` | Focus rings (matches primary)  |

---

## Typography

### Font Families

| Role     | Family   | Fallback                          |
| -------- | -------- | --------------------------------- |
| Heading  | Outfit   | system-ui, sans-serif             |
| Body     | Inter    | system-ui, sans-serif             |

### Type Scale (Major-Third — 1.250)

| Token    | Size      | rem     | Typical use                |
| -------- | --------- | ------- | -------------------------- |
| `xs`     | 12px      | 0.75    | Captions, fine print       |
| `sm`     | 14px      | 0.875   | Labels, metadata           |
| `base`   | 16px      | 1       | Body text                  |
| `lg`     | 20px      | 1.25    | Subheadings, lead text     |
| `xl`     | 25px      | 1.563   | Section titles             |
| `2xl`    | 31px      | 1.953   | Page subtitles             |
| `3xl`    | 39px      | 2.441   | Page titles                |
| `4xl`    | 49px      | 3.052   | Hero subhead               |
| `5xl`    | 61px      | 3.815   | Hero headline              |

### Leading

| Token    | Value | Usage                     |
| -------- | ----- | ------------------------- |
| `tight`  | 1.15  | Large headings            |
| `snug`   | 1.35  | Subheadings, short blocks |
| `normal` | 1.6   | Body text, paragraphs     |

### Weights

| Token      | Value | Usage                       |
| ---------- | ----- | --------------------------- |
| `regular`  | 400   | Body text                   |
| `medium`   | 500   | UI labels, emphasized body  |
| `semibold` | 600   | Subheadings, card titles    |
| `bold`     | 700   | Headings, hero text         |

---

## Spacing

Base unit: **4px** (`0.25rem`).

| Token | Value   | rem   |
| ----- | ------- | ----- |
| `1`   | 4px     | 0.25  |
| `2`   | 8px     | 0.5   |
| `3`   | 12px    | 0.75  |
| `4`   | 16px    | 1     |
| `5`   | 20px    | 1.25  |
| `6`   | 24px    | 1.5   |
| `8`   | 32px    | 2     |
| `10`  | 40px    | 2.5   |
| `12`  | 48px    | 3     |
| `16`  | 64px    | 4     |
| `20`  | 80px    | 5     |
| `24`  | 96px    | 6     |
| `32`  | 128px   | 8     |

**Section vertical rhythm:** `--space-32` (128px) on desktop, scales down with viewport.

---

## Radius

| Token  | Value  | Usage                              |
| ------ | ------ | ---------------------------------- |
| `sm`   | 6px    | Small elements, tags               |
| `md`   | 12px   | Inputs, small cards                |
| `lg`   | 20px   | Cards, modals                      |
| `xl`   | 28px   | Large containers, hero panels      |
| `full` | 999px  | Buttons, pills, avatars            |

Soft, medical-device rounded — never sharp, never cartoonishly round.

---

## Shadows

| Token | Value                                         | Usage                    |
| ----- | --------------------------------------------- | ------------------------ |
| `sm`  | `0 1px 3px rgba(14,124,134,0.06)`             | Nav on scroll, subtle    |
| `md`  | `0 4px 12px rgba(14,124,134,0.08)`            | Cards, resting state     |
| `lg`  | `0 8px 24px rgba(14,124,134,0.12)`            | Cards on hover, modals   |

Soft, diffuse, low-contrast. Tinted with primary hue for brand coherence.

---

## Motion

| Token      | Value                            | Usage             |
| ---------- | -------------------------------- | ----------------- |
| `ease`     | `cubic-bezier(0.4, 0, 0.2, 1)`  | All transitions   |
| `dur-fast` | `150ms`                          | Hover states      |
| `dur`      | `250ms`                          | General UI        |
| `dur-slow` | `400ms`                          | Overlays, reveals |

Gentle, never bouncy. `prefers-reduced-motion` disables all transitions.

---

## Layout

| Token            | Value                              | Notes                       |
| ---------------- | ---------------------------------- | --------------------------- |
| `container-max`  | `1180px`                           | Max content width           |
| `container-pad`  | `clamp(1.25rem, 4vw, 2.5rem)`     | Responsive horizontal pad   |

### Breakpoints

| Name      | Width   | Usage                     |
| --------- | ------- | ------------------------- |
| `mobile`  | 375px   | Base / mobile-first       |
| `tablet`  | 768px   | Tablet layouts            |
| `desktop` | 1280px  | Full desktop layouts      |

---

## Components

### Button

| Variant     | Fill              | Text              | Border            | Radius    | Padding          |
| ----------- | ----------------- | ----------------- | ----------------- | --------- | ---------------- |
| `primary`   | `accent`          | `surface`         | none              | `full`    | `space-3 space-6`|
| `secondary` | transparent       | `primary`         | `primary`         | `full`    | `space-3 space-6`|
| `ghost`     | transparent       | `primary`         | none              | `full`    | `space-3 space-6`|

- Hover: darken fill (`accent-dark` / `primary-dark`), transition `dur-fast`
- Focus: 2px `focus` ring, 2px offset
- Min height: 44px (tap target)

### Card

- Background: `surface`
- Border-radius: `radius-lg`
- Shadow: `shadow-md` → `shadow-lg` on hover
- Padding: `space-8`
- Transition: shadow `dur-fast` `ease`

### Section

- Full-width
- Vertical padding: `space-32`
- Alternating backgrounds: `canvas` / `canvas-alt`
- Content constrained to `container-max` with `container-pad`

### Hero

- Background: `primary-light` wash
- Headline: `text-5xl`, `bold`, `leading-tight`, `ink`
- Subhead: `text-lg`, `regular`, `leading-normal`, `ink-soft`
- Buttons: primary (accent) + secondary (teal outline)
- Vertical padding: `space-32`

### Nav

- Position: sticky top
- Background: `surface`
- Shadow: `shadow-sm` on scroll (added via JS)
- Logo: left-aligned
- Links: right-aligned, `ink-soft`, hover `primary`
- CTA: accent button (coral), right-most

### Feature Item

- Icon container: `primary-light` background tile, `radius-md`
- Title: `text-xl`, `semibold`, `ink`
- Body: `text-base`, `regular`, `ink-soft`
- Spacing: `space-4` between icon and title, `space-2` between title and body

### Team Card

- Photo: circular (`radius-full`), centered
- Name: display font (Outfit), `semibold`, `ink`
- Role: `text-sm`, `ink-faint`
- Spacing: `space-3` between photo and name

### Footer

- Background: `ink`
- Text: `surface` (white) for headings, `ink-faint` for links
- Layout: grid columns (Company, Legal, Contact)
- Padding: `space-16` vertical

---

## Accessibility

- **Contrast (WCAG AA):** teal on white = 4.9:1 ✓ · ink on canvas > 12:1 ✓
- **Focus rings:** 2px solid `--color-focus`, 2px offset on all interactive elements
- **Images:** meaningful `alt` text on all images; decorative images use `alt=""`
- **Reduced motion:** `prefers-reduced-motion: reduce` disables all transitions and animations
- **Minimum body text:** 16px (`text-base`)
- **Minimum tap targets:** 44×44px on all interactive elements
