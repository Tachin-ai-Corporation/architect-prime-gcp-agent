// platform/contracts/digest.mjs — content addressing (Foundation)
//
// A definition revision is identified by what it contains, not by when it was
// written or who wrote it (C-31). That requires one canonical serialization: two
// records with the same content must produce the same digest regardless of key
// order, and any content change must produce a different one.
//
// This is also what makes an Effective Agent Spec attributable (C-32) — a
// mission stamped with `agentSpecDigest` can be reproduced later by finding the
// bundle that hashes to it.

import { createHash } from 'node:crypto';

/**
 * Fields excluded from a content digest.
 *
 * These describe *this* revision rather than the content it carries. Including
 * them would make a digest depend on its own value (`digest`) or change on a
 * no-op rewrite (`created_at`), which defeats the purpose: re-authoring
 * identical content must land on the identical digest so the system can tell
 * "unchanged" from "changed".
 */
export const NON_CONTENT_FIELDS = new Set([
  'digest',
  'revision',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'parent_revision',
]);

/**
 * Deterministic JSON: keys sorted at every depth, undefined dropped.
 *
 * Array order is preserved — in these schemas order is meaningful
 * (checkpoint sequence, overlay precedence, capability lists).
 */
export function canonicalize(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON text for a value. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Content digest of a record, as `sha256:<hex>`.
 *
 * @param {object} record
 * @param {{ exclude?: Set<string>|string[] }} [opts] - extra top-level fields to omit
 */
export function contentDigest(record, opts = {}) {
  const extra = opts.exclude
    ? (opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude))
    : null;

  const content = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (NON_CONTENT_FIELDS.has(key)) continue;
    if (extra && extra.has(key)) continue;
    if (key.startsWith('_')) continue; // runtime scratch, never content
    if (value === undefined) continue;
    content[key] = value;
  }
  return `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`;
}

/** Digest of raw bytes or text — used for rendered bundles and installed files. */
export function bytesDigest(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

/**
 * Digest of a set of files, as `{ path: digest }` folded into one value.
 *
 * A rendered agent bundle is many files; its identity is the identity of all of
 * them together, including their paths — a file moved is a different bundle.
 *
 * @param {Record<string,string|Buffer>} files - path → contents
 */
export function treeDigest(files) {
  const entries = Object.keys(files).sort().map((p) => [p, bytesDigest(files[p])]);
  return `sha256:${createHash('sha256').update(canonicalJson(entries)).digest('hex')}`;
}

/** True when two records carry identical content, ignoring revision metadata. */
export function sameContent(a, b) {
  return contentDigest(a) === contentDigest(b);
}

/** Short form for logs and UI. `sha256:ab12…` → `ab12cd34`. */
export function shortDigest(digest) {
  const hex = String(digest || '').replace(/^sha256:/, '');
  return hex.slice(0, 8);
}
