// lib/entity.ts — Canonical entity identity (control plane side)
//
// Invariant: **the Firestore document ID IS the entity ID** (PRODUCT_CANON C-31).
//
// Several POST routes used to persist an entity under `doc(body.id)` while
// omitting `id` from the stored object. Every runtime loader accepted only
// records whose decoded `id` was truthy, so a dashboard-created Project or
// Process reported success and was invisible to the fleet. The runtime now
// derives identity from the document path (`platform/persistence/entity-id.mjs`); this
// helper keeps the stored body in agreement so both surfaces read the same
// thing.
//
// Route every `.set()` and identity-bearing `.update()` on a canonical
// collection through this helper — `test/canonical-id.test.mjs` scans for
// writers that skip it.

/** Stamp the canonical ID onto an entity body about to be written. */
export function withCanonicalId<T extends object>(id: string, body: T): T & { id: string } {
  return { ...body, id };
}
