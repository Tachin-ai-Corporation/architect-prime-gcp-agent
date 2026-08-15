# File Ingestion — Implementation Plan

**Status:** DRAFT for operator review · **Date:** 2026-08-14
**Scope:** deployed agents ingest **any file** dropped into Google Chat or the dashboard. Images become
pixel-vision to the brain; text-bearing files become extracted text; everything else becomes a
referenced artifact the agent can operate on with a tool.

---

## Decision (settled — not re-litigated here)

Vision/file-sight is built as a **widened neural gateway + deterministic ingestion, not a new organ.**
Perception is already **Ears'** deterministic job; interpretation is already the **existing judgment
organs'** job. A new "eyes" organ would duplicate one or the other, force cerebellum to verify against
a model-written caption instead of the pixels (**B-28** violation), and trip the **C-28 ORGAN_LOCK**
ritual for no benefit. Widening the one gateway funnel (**B-20**) touches only code plumbing — no organ
files, no re-pin.

---

## Hard constraints (the forcing functions)

- **Firestore 1 MB/doc → bytes NEVER live in the envelope.** Files go to GCS; the envelope carries a
  pointer (`FileRef`). A single screenshot routinely exceeds 1 MB, so this is mandatory. It also
  sidesteps provider inline-size limits (Anthropic ~5 MB/image; prefer Gemini `fileData` `gs://` URIs).
- **C-6 (two-path split):** judgment-vision rides the gateway; stateless text-extraction (OCR/convert)
  rides the utility path (`vertex-text.mjs`).
- **C-4 / C-18:** all file handling is deterministic code; retention is a declarative bucket-lifecycle
  rule, not a cleanup daemon.
- **B-4 (economy):** pixels attach only to the organ calls whose job needs sight.
- **C-28:** no organ (`SOUL.md`/`IDENTITY.md`) is touched — no ORGAN_LOCK ceremony.

---

## Shape

```
  ┌── GChat ──┐  msg.attachment[]     ┌─────┐   deterministic         ┌─────────────────────┐
  │  (Ears)   ├─► fetch bytes ───────►│     │   type-router (mime):   │  Neural Gateway      │
  └───────────┘  (+drive.readonly)    │ GCS │    image ───────────────► pixel part (gate)   │
  ┌ Dashboard ┐  paste/drag/file      │     │    doc/pdf/txt ─► utility extract-to-text ───► │ text
  │(ChatPanel)├─► /media upload ──────►│     │    other ──────► referenced artifact ───► motor+skill
  └───────────┘                        └──┬──┘                         └─────────────────────┘
                     FileRef {gcsPath,mime,kind,name,sha,…}
                     on intake doc → M-envelope (only) → _files at dispatch
```

- **Ingestion (deterministic, type-agnostic):** dropped file → fetch bytes → store in GCS → write a
  `FileRef` on the intake doc.
- **Router (deterministic, by `mimeType`):** `image/*` → gateway pixel path (**new**); text-bearing →
  utility extract-to-text (**existing** `drive-to-doc`/`docs-cat`); other → referenced artifact for the
  motor organ to operate on via a skill (**existing**).
- **Gateway (widened):** the two `loop.mjs` converters emit an image part beside their text parts.

The **only new model-facing capability is image pixel-vision.** Every other type reuses a path that
already exists.

---

## Data model — `FileRef`

```ts
type FileRef = {
  gcsPath: string;      // artifacts/inbound/primes/{primeId}/{batch}/{name}
  mimeType: string;
  kind: 'image' | 'document' | 'data' | 'archive' | 'other';  // deterministic routing class
  name: string;
  bytes: number;
  sha256: string;
  source: 'gchat' | 'dashboard';
  alt?: string;         // optional utility-generated caption/OCR (redactSecrets-scrubbed)
};
```

- **Lives on:** the intake doc (top-level `files[]`) and the **M envelope only** — it mirrors
  `source_text` exactly: set at the four M-creation sites, **never** stamped onto `C`/`T` docs, and
  threaded to organs at dispatch as `_files` (beside `_sourceText`/`_sourceMeta`).
- **`app/src/lib/types.ts`** gains the `FileRef` type + `files?: FileRef[]` on `WorkEnvelope`.

---

## Implementation — phased, each provable on a canary (tom / archie), each behind a contract flag

### P0 — gateway seam + capability probe (de-risk the one unknown first)

Widen the gateway to carry an image part, and **prove the models can actually see** at our
regions/versions before building any UI.

| # | File | Change |
|---|---|---|
| 1 | `corekit/lib/prompt-blocks.mjs:55` (`toContentParts`) | Add an image part shape beside `{type:'text'}`. |
| 2 | `corekit/brain/loop.mjs:348` (`convertMessagesToGoogle`) | Emit `{ inlineData:{mimeType,data} }` or `{ fileData:{fileUri,mimeType} }` (`gs://` URI). |
| 3 | `corekit/brain/loop.mjs:411` (`convertMessagesToAnthropic`) | Emit `{ type:'image', source:{type:'base64',media_type,data} }`. |
| 4 | `corekit/brain/loop.mjs` (2 breakpoint reconstructors) | Preserve non-text parts (today they rebuild everything as `{type:'text'}`). |
| 5 | `corekit/brain/tools.mjs:59` (`sniffBinary`) | Sanctioned vision path (pixels → vision call) distinct from the OCR reroute. |

**Prove:** a real cortex (Anthropic) call *and* a real organ (Gemini) call each describe a known image
supplied via a hand-placed GCS `FileRef`. Both provider shapes work; capability confirmed.

### P1 — ingestion plumbing + envelope + dashboard channel + retention

**Envelope (type-agnostic):**
| # | File | Change |
|---|---|---|
| 1 | `agent-ears.mjs:890` intake write | Add top-level serialized `files[]` (mirror the `address` pattern, not flat fields). |
| 2 | `agent-brain.mjs:3207/3356/3626/4834`, `process-engine.mjs:753` | Set `files: intake.files` on the **M** envelope (mirror `source_text`; M-only). |
| 3 | `checkpoint-executor.mjs:1112`, `checkpoint_plan.mjs:443/542` | Thread `_files` at dispatch; optionally fold `alt` text into `seedText` (`checkpoint-executor.mjs:195`). |
| 4 | `app/src/lib/types.ts:99` | Add `FileRef` type + `files?: FileRef[]`. |

**Dashboard channel (first inbound upload primitive in `app/`):**
| # | File | Change |
|---|---|---|
| 1 | `app/src/components/ChatPanel.tsx` | Add `onPaste` (`clipboardData.items`), drag-drop, hidden file input. |
| 2 | new `app/src/app/api/primes/[id]/media/route.ts` | `requireAuth()` → REST PUT to GCS mirroring `artifact-share.mjs:137` with the Cloud Run SA metadata token → `artifacts/inbound/primes/{id}/…` → return `FileRef`. |
| 3 | `app/src/app/api/primes/[id]/messages/route.ts:50` | Accept optional `files[]` beside `text`; write onto the message doc. Ears `pollFirestore` carries it into the intake `files[]`. |

**Router + store (deterministic):**
| # | File | Change |
|---|---|---|
| 1 | reuse `artifact-share.mjs` writer (project-SA token) | Store any dropped file at `artifacts/inbound/primes/{id}/{batch}/{name}`; cap at `git.max_artifact_mb` (20 MB). No image filter — accept all, classify by `mimeType`. |
| 2 | new `corekit/lib/file-router.mjs` | `mimeType` → `kind`; `image` → gateway pixel path; text-bearing → utility extract (`drive-to-doc`/`docs-cat`); other → referenced artifact. |
| 3 | `contracts.json` + `prime-bootstrap.sh:434` / `fleet-bootstrap.sh:250` | Add `media_retention_days` (default 30) + a GCS lifecycle rule `{delete, age, matchesPrefix:["artifacts/inbound/"]}` via `gcloud storage buckets update --lifecycle-file` (idempotent). |
| 4 | vision-gate attach step | Treat a GCS 404 as "file expired/unavailable," not a crash. |

**Prove:** paste a screenshot in the dashboard → ask *"what's the error?"* → agent answers **from the
pixels**; drop a PDF → agent reads its extracted text.

### P2 — GChat channel

| # | File | Change |
|---|---|---|
| 1 | `agent-ears.mjs` `pollGChat:516` | Read `msg.attachment[]`; drop guard → `if (!text && !attachments.length) continue`. |
| 2 | `agent-ears.mjs:197` (`DWD_SCOPES`) | Fold `drive.readonly` into the single scope string (Drive-hosted case only). No Admin-Console change — master grant already has `drive`. |
| 3 | `corekit/lib/chat-media.mjs` (new) | Fetch bytes as the agent user (DWD). **`attachmentDataRef`** → `GET chat.googleapis.com/v1/media/{resourceName}?alt=media` (existing scope). **`driveDataRef`** → `GET drive/v3/files/{id}?alt=media&supportsAllDrives=true` (new scope). Mirror `git-store.mjs:95` + `drive-download:71`. |

**Prove:** on a real space, an image-only message is no longer dropped and reaches cognition; a
Drive-hosted attachment not shared with the agent surfaces a `needs_input` ("share it with me"),
reusing `drive-download:42`.

### P3 — economy + verification

- Per-organ **vision gate** (contracts): cortex `classify` / prefrontal `plan` / cerebellum `verify`
  ON; motor / temporal OFF.
- Utility **alt-text/OCR** pre-pass, `redactSecrets`-scrubbed before it persists to the envelope.
- **Prove:** cerebellum verifies a visual accept-criterion from the pixels (B-28), binning the claim
  `verified` (B-29). The `design-render` screenshot skill now verifies actual rendering, not just text.

---

## Gotchas (all found in the code)

- **G1 — DWD token cache not keyed by scope** (`dwd-auth.mjs:12`). Fold Drive into the single
  `DWD_SCOPES` string → one token; don't mint a second (or key the cache by `scope+subject`).
- **G2 — dedup keys on `msg.text`** (`agent-ears.mjs:823`), empty for a file-only message. Give it a
  stable key (`msg.name` + first attachment `resourceName`).
- **G3 — metadata key mismatch** (`:590` writes `space/thread`; `:900` reads `spaceName/threadName`).
  Carry `files[]` via the serialized `address` pattern.
- **G4 — consume-before-write ordering** (`markGChatConsumed` at `:847`). Fetch + store **before**
  consume, or re-queue on fetch failure.
- **G5 — graceful expiry.** A `FileRef` can outlive its GCS object (retention). Attach step treats 404
  as unavailable.

---

## Retention · privacy · access

- **Retention (new — nothing expires today).** Declarative GCS lifecycle rule on the
  `artifacts/inbound/` prefix, delete after `media_retention_days` (default 30). Inbound sits *high* in
  the path (`artifacts/inbound/primes/{id}/…`) precisely so one `matchesPrefix` rule targets only
  inbound and never deliverable artifacts. Extend the serve route's allowed prefix
  (`artifacts/route.ts:60`) to match. **Teardown gap:** teardown deletes no GCS objects and missions
  are top-level (survive it) — add a GCS prefix delete on teardown, or rely on the lifecycle rule.
- **Privacy / PII.** Pixels are opaque to the text-only secret scrubber, so a file is a genuinely new
  exposure surface. Keep bytes off the durable text spine (they ride by reference); `redactSecrets` any
  extracted/alt text before persistence. Retention TTL is the primary mitigation.
- **Access — honest boundary.** Bucket is private (SA-only, no public URLs). The dashboard serve route
  is session-gated but only path-prefix-checks a **caller-supplied prime id** — no user→prime authz,
  and the dashboard is a flat allowed-domain admin model. Inbound files are readable by any
  authenticated admin, **exactly like text artifacts today** — the design claims no isolation the
  platform doesn't already provide. Fixing the serve-route check is recommended (see decision #4).

---

## Open decisions for the operator

1. **Model vision capability — live-probe before building (the one real risk).** The repo asserts no
   multimodal capability for `claude-opus-4-6` / `gemini-3.6-flash`, and today's code strips images.
   P0 confirms it at our regions (Anthropic `us-east5`, Google `global`) — same discipline as the
   earlier Vertex model-location probe.
2. **Bytes-in-call vs. `gs://` URI.** `fileData` URI for Gemini, base64 for Anthropic; GCS-first
   storage serves both. Recommend URI where supported.
3. **Retention default** — `media_retention_days` = 30, uniform bucket-lifecycle vs. a per-prime sweep.
4. **Serve-route hardening** — fix the caller-supplied-prime gap now (recommended; small, and files
   raise its stakes) or track separately.
5. **Vision-gate defaults** — confirm cortex/prefrontal/cerebellum ON, motor/temporal OFF.
6. **Extract-to-text depth** — which non-image types push to text (pdf, docx, pptx, xlsx, csv, code)
   vs. stay referenced (zip, unknown binary).
7. **Field naming** — `files[]` (generic) vs `attachments_in[]`; kept distinct from the outbound
   `context.attachments_export`.
