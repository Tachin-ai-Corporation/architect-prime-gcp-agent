# Channel Addressing

> **Repo location:** `docs/guides/CHANNEL_ADDRESSING.md`
> **Ownership:** Human maintainers via CODEOWNERS. Agents may propose amendments only by PR.
> **Audience:** Anyone touching the Ears, Mouth, or Brain daemons, or the inter-agent transport.
> **Status:** Normative spec for the conversational transport.

A fleet agent lives in many conversations at once — several shared Google Chat spaces it has been invited to, plus its dashboard channel. Every inbound message arrives from exactly one of those conversations, and every reply belongs back in the same one. The mechanism that guarantees this is **channel addressing**: every message carries an immutable **Address**, stamped at ingestion, carried through cognition untouched, and obeyed at delivery.

This is a routing problem, and under **C-4** routing is code. No model ever decides which conversation a reply belongs to.

---

## The Address

An **Address** is the complete, self-contained set of coordinates needed to place a message in a conversation. It is the only thing the Mouth needs to deliver, and the only routing fact the Ears must capture.

```
Address ::= {
  channel:  "gchat" | "dashboard"        // the transport kind

  // when channel = "gchat"
  space:    "spaces/AAAA…"               // the Chat space resource name
  thread:   "spaces/AAAA…/threads/BBBB"  // nullable; present iff the inbound was threaded

  // when channel = "dashboard"
  fleet_agent: "<hostname>" | null       // null = Prime channel; set = fleet sub-collection
}
```

Three rules govern its lifecycle:

1. **Ears stamps it.** Every intake record carries the full origin Address under `source_meta.address`.

2. **The Brain carries it, untouched.** The Brain copies `source_meta` from intake onto every envelope. The Address rides inside it for free. Cortex never reads it, never writes it, never sees it.

3. **The Mouth obeys it.** Every deliverable output envelope carries a `delivery_address`. The Mouth delivers **strictly** to that address and nowhere else.

---

## Address Lifecycle

### Replies → echo the origin
When the Brain produces a response to an intake, `delivery_address := source_meta.address`. A question asked in space C is answered in space C.

### Delegations → look up the target's room
When the Brain emits a delegation envelope, `delivery_address := { channel: "gchat", space: <project's space> }`, looked up from the project registry.

---

## Pipeline

```
            deterministic                  cognition (gateway)                  deterministic
 channel ──► EARS ──► intake ──────────► BRAIN DAEMON ◄───────────────────────► MOUTH ──► channel
            stamp Address    source_meta.address    delivery_address =          deliver to
            on every intake  rides every envelope   ├─ reply:    echo origin    delivery_address
                                                    └─ delegate: project space  (one primitive)
```

---

## Per-Space Cursors

Each space maintains an independent high-water cursor. A busy space cannot advance another space's cursor — cross-space message shadowing is structurally impossible. Cursors persist to `/var/lib/agent-ears-state/cursors.json`.

---

## Delivery Primitive

`deliverToAddress(addr, text, opts)` in `platform/providers/channel.mjs` is the single delivery function. The Mouth's job collapses to: read `delivery_address` off the envelope, voice the text, call `deliverToAddress`. No discovery, no ordering dependence, no "first space."

---

## Contracts

```jsonc
"ears": {
  "max_pages_per_poll": 5,
  "new_space_seed": "now",
  "mention_match": "annotation"
},
"mouth": {
  "dashboard_visibility_mirror": true
},
"chat": {
  "reply_in_thread": true
}
```

---

## Canon Alignment

| Canon | How this honors it |
|---|---|
| **C-3** | Replies and delegations land in the human-visible conversation. |
| **C-4** | Channel selection is pure code: reply-to-origin and project-space lookup. |
| **C-5** | Address lives in `source_meta` / `delivery_address`, moved by daemon. Cortex never touches it. |
| **C-7** | Poll cap, seed policy, mention mode, thread policy are contracts. |
| **C-10** | All runtime change in `corekit/`; new logic in one single-purpose lib. |
| **B-9** | No organ gains a second job. |
| **B-16** | Addressing is invisible to brain agents. |
