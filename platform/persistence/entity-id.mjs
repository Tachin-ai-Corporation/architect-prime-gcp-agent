// platform/persistence/entity-id.mjs — Canonical entity identity (Foundation)
//
// Invariant: **the Firestore document ID IS the entity ID.**
//
// Before this module, several writers persisted an entity under `doc(body.id)`
// but omitted `id` from the stored object, while every runtime loader accepted
// only records where the decoded `id` was truthy. A dashboard-created Project or
// Process therefore reported success and was invisible to every agent.
//
// The fix is one-directional: readers derive identity from the document path,
// which no writer can forget. Writers still stamp `id` (see the dashboard's
// `withCanonicalId`) so the two agree, but a stamped field is now belt to the
// document path's braces — never the sole authority.
//
// C-29/C-31: identity is a Foundation mechanism, not per-writer convention.

/**
 * Extract the document ID from a Firestore REST resource name.
 *
 * A REST `name` is a full resource path:
 *   projects/{gcp}/databases/(default)/documents/projects/marketing-site
 *                                                        ^^^^^^^^^^^^^^^ the ID
 *
 * @param {string} name - Firestore document resource name
 * @returns {string} The trailing path segment, or '' when unparseable
 */
export function docIdFromName(name) {
  if (typeof name !== 'string' || name === '') return '';
  const trimmed = name.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Reconcile a decoded entity body with its authoritative document path.
 *
 * The document path wins. A body that carries a *different* `id` is a genuine
 * integrity defect (a record copied between documents), so it is reported rather
 * than silently repaired.
 *
 * @param {object} decoded - Decoded Firestore field map
 * @param {string} name - Firestore document resource name
 * @returns {{ entity: object|null, id: string, mismatch: string|null }}
 *   `entity` is null when no ID can be established at all.
 */
export function reconcileEntityId(decoded, name) {
  const docId = docIdFromName(name);
  if (!docId) {
    const bodyId = decoded && typeof decoded.id === 'string' ? decoded.id : '';
    if (!bodyId) return { entity: null, id: '', mismatch: null };
    return { entity: decoded, id: bodyId, mismatch: null };
  }
  const bodyId = decoded && typeof decoded.id === 'string' ? decoded.id : '';
  const mismatch = bodyId && bodyId !== docId ? bodyId : null;
  return { entity: { ...decoded, id: docId }, id: docId, mismatch };
}

/**
 * Stamp the canonical ID onto an entity about to be written.
 *
 * @param {string} id - The document ID the entity will be stored under
 * @param {object} body - The entity body
 * @returns {object} `body` with `id` set to the document ID
 */
export function withCanonicalId(id, body) {
  return { ...body, id };
}
