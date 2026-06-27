# Tachin.ai — Site Information Architecture

> Content structure, page inventory, and voice guidelines for the tachin.ai marketing website.

---

## Voice

Clear, warm, credible. Short sentences. Concrete claims, not hype. Healthcare-literate but never jargon-heavy.

**Reader:** Healthcare leader, clinician, or partner evaluating trust.

| Do                                  | Don't                                |
| ----------------------------------- | ------------------------------------ |
| "We protect patient data at rest and in transit." | "Our cutting-edge solution leverages..." |
| "Built for HIPAA-covered entities." | "Disrupting the healthcare paradigm." |
| Use active voice                    | Use passive or hedging language       |
| State facts with specifics          | Make vague superlatives               |

---

## Sitemap

| Page                  | File                | Purpose                                | Key Sections                                     |
| --------------------- | ------------------- | -------------------------------------- | ------------------------------------------------ |
| Home                  | `index.html`        | Primary landing — hero, value prop, CTA | Hero, Problem, Features, Credibility, CTA        |
| About                 | `about.html`        | Team & mission                         | Mission, Leadership, Board/Advisors              |
| Security              | `security.html`     | Trust & compliance                     | Data Protection, Infrastructure, Compliance, Responsible AI |
| Privacy Policy        | `privacy.html`      | Legal — privacy policy                 | Embedded Google Doc                              |
| Terms of Service      | `terms.html`        | Legal — terms of service               | Embedded Google Doc                              |
| Blog / Announcements  | `newly-released.html` | Product updates & news               | Reverse-chronological posts                      |

---

## Per-Page Specifications

### Home (`index.html`)

**Purpose:** Convert visitors into leads. Establish what Tachin does, why it matters, and why it's trustworthy — in under 60 seconds of scrolling.

**Target audience:** Healthcare executives, clinical informaticists, and innovation leads evaluating AI partners.

**Voice notes:** Confident but not aggressive. Lead with the problem, not the product. Every claim should be provable.

**Sections:**

1. **Hero** — `primary-light` wash background. Healthcare-promise headline (e.g., "AI agents that understand healthcare"). Subhead explains the product category in one sentence. Primary CTA (coral) + secondary CTA (teal outline).

2. **The Problem** — Empathy section. Acknowledge the complexity healthcare leaders face: fragmented systems, alert fatigue, compliance burden. Short, punchy copy. No product mention yet.

3. **What Tachin Does** — 3–4 feature items. Each has an icon in a `primary-light` tile, a `text-xl` title, and a `text-base` description. Features should map to pain points from section 2.

4. **Credibility** — Proof band. Stats, partner logos, compliance badges, or testimonials. Keep it scannable — numbers and logos, minimal prose.

5. **Closing CTA** — Warm, direct. "Let's talk about your organization." Single accent CTA button. No pressure language.

---

### About (`about.html`)

**Purpose:** Build personal trust. Show the humans behind Tachin and their healthcare/AI credentials.

**Target audience:** Anyone who passed the home page and wants to know who they'd be working with.

**Voice notes:** Warm and personal. First names are fine. Highlight healthcare domain expertise — this is the differentiator.

**Sections:**

1. **Mission** — Why Tachin exists. 2–3 sentences max. Connect AI capability to healthcare outcomes.

2. **Leadership** — Team cards (circular photo, name in display font, role in `ink-faint`). Brief bio paragraphs beneath each card. Emphasize healthcare and AI credentials.

3. **Board / Advisors** — If applicable. Smaller cards or a simple list. Names and affiliations.

---

### Security (`security.html`)

**Purpose:** Answer every trust question a CISO, compliance officer, or privacy-conscious clinician would ask.

**Target audience:** Security reviewers, compliance officers, CTOs evaluating vendor risk.

**Voice notes:** Precise and technical. No marketing fluff. Specifics over generalities. Link to certifications and policies where possible.

**Sections:**

1. **Data Protection** — Encryption at rest (AES-256) and in transit (TLS 1.2+). Data residency. Access controls. Audit logging.

2. **Infrastructure** — Google Cloud Platform. SOC 2 Type II (GCP). Region and availability details.

3. **Compliance** — HIPAA readiness. BAA availability. Any other applicable frameworks.

4. **Responsible AI** — How AI models are used. Data handling for AI processing. Human-in-the-loop commitments. Bias monitoring.

---

### Privacy Policy (`privacy.html`)

**Purpose:** Legal compliance — display the full privacy policy.

**Target audience:** Anyone reviewing legal terms.

**Voice notes:** Standard legal. This is an embedded document, not marketing copy.

**Sections:**

1. **Embedded Google Doc** — Full-width iframe embedding the canonical privacy policy document. Minimal page chrome (nav + footer only).

---

### Terms of Service (`terms.html`)

**Purpose:** Legal compliance — display the full terms of service.

**Target audience:** Anyone reviewing legal terms.

**Voice notes:** Standard legal. This is an embedded document, not marketing copy.

**Sections:**

1. **Embedded Google Doc** — Full-width iframe embedding the canonical terms document. Minimal page chrome (nav + footer only).

---

### Blog / Announcements (`newly-released.html`)

**Purpose:** Share product updates, feature launches, and company news.

**Target audience:** Existing customers, prospective customers tracking progress, partners.

**Voice notes:** Informative, concise. Lead with the outcome or benefit. Date every post clearly.

**Sections:**

1. **Post List** — Reverse-chronological. Each post has a date, title, and summary. Cards or simple list items. Link to full content (inline expand or separate page).

---

## Home Page Structure (Redesigned)

The home page follows a linear narrative arc:

```
┌─────────────────────────────────────────┐
│  Nav (sticky)                           │
├─────────────────────────────────────────┤
│  1. Hero                                │
│     primary-light wash                  │
│     Healthcare promise headline         │
│     Subhead + dual CTAs                 │
├─────────────────────────────────────────┤
│  2. The Problem                         │
│     Empathy for healthcare complexity   │
│     canvas-alt background               │
├─────────────────────────────────────────┤
│  3. What Tachin Does                    │
│     3–4 feature items with icons        │
│     canvas background                   │
├─────────────────────────────────────────┤
│  4. Credibility                         │
│     Stats / logos / badges              │
│     canvas-alt background               │
├─────────────────────────────────────────┤
│  5. Closing CTA                         │
│     Warm, direct call to action         │
│     primary-light wash                  │
├─────────────────────────────────────────┤
│  Footer                                 │
│     ink background, grid columns        │
└─────────────────────────────────────────┘
```

---

## Navigation

### Primary Nav (Header)

| Position | Item       | Type   | Destination           |
| -------- | ---------- | ------ | --------------------- |
| Left     | Logo       | Brand  | `index.html`          |
| Right    | About      | Link   | `about.html`          |
| Right    | Security   | Link   | `security.html`       |
| Right    | Blog       | Link   | `newly-released.html` |
| Right    | Contact    | CTA    | Contact form / mailto |

### Footer

| Column    | Links                                    |
| --------- | ---------------------------------------- |
| Company   | About, Blog                              |
| Legal     | Privacy Policy, Terms of Service         |
| Contact   | Email, LinkedIn, location                |
