// platform/deployment/parity.mjs — does a release reproduce what the fleet runs?
//
// Phase D item 11 says: seed a release from the legacy sources, ASSERT PARITY,
// switch readers, freeze the legacy writes, delete them. This is the assertion.
//
// It exists because the deletions it gates are large and irreversible. Every
// legacy authority in §4 — agent-types.json, static kit.json persona assembly,
// the composition half of job-*.txt, local process JSON, the top-level Firestore
// process library — is deleted on the strength of "the release produces the same
// thing". A migration that switches readers on the strength of "it looked right"
// is how content silently disappears from a fleet.
//
// Pure by construction: it takes two already-loaded sides and returns a verdict.
// The caller owns the reads (B-19), which is what makes the interesting cases —
// an empty side, a side that failed to load — testable at all.
//
// THE RULE THAT SHAPES EVERY FUNCTION HERE: an empty released side is never a
// pass. That is the shape this program has been finding all week — a removal set
// that could not be non-empty, an evidence array nothing appended to, a scan root
// that excluded its own subject. A parity check that reports MATCH when the
// release delivered nothing would be the same defect guarding the biggest
// deletion in the plan.

/** Sort key so a report reads the same way twice. */
const byId = (a, b) => String(a).localeCompare(String(b));

/**
 * Compare two id→record maps.
 *
 * @param {Record<string,object>} legacy   - what the fleet runs today
 * @param {Record<string,object>} released - what the release would deliver
 * @param {string[]} fields - the fields that must agree. Chosen by the caller
 *   because "same" means different things per kind: a process is its narrative,
 *   a responsibility is its schedule and instruction. Comparing whole records
 *   would fail on provenance that is SUPPOSED to differ (revision, digest).
 * @returns {{ ok: boolean, reason: string, missing: string[], extra: string[], changed: object[] }}
 */
export function compareSets(legacy, released, fields) {
  const legacyIds = Object.keys(legacy || {}).sort(byId);
  const releasedIds = Object.keys(released || {}).sort(byId);

  // An empty release is the failure mode this whole module guards. Reported as a
  // distinct reason rather than as "N missing", because the operator response is
  // different: nothing was seeded, versus something was dropped.
  if (legacyIds.length && !releasedIds.length) {
    return {
      ok: false,
      reason: `the release delivers NOTHING while the fleet runs ${legacyIds.length} — the seed did not happen`,
      missing: legacyIds,
      extra: [],
      changed: [],
    };
  }

  const missing = legacyIds.filter((id) => !(id in (released || {})));
  const extra = releasedIds.filter((id) => !(id in (legacy || {})));

  const changed = [];
  for (const id of legacyIds) {
    if (!(id in (released || {}))) continue;
    const a = legacy[id];
    const b = released[id];
    const diffs = fields.filter((f) => !same(a?.[f], b?.[f]));
    if (diffs.length) changed.push({ id, fields: diffs });
  }

  const ok = !missing.length && !extra.length && !changed.length;
  return {
    ok,
    reason: ok
      ? `${legacyIds.length} item(s) match on ${fields.join(', ')}`
      : [
        missing.length ? `${missing.length} missing from the release` : null,
        extra.length ? `${extra.length} only in the release` : null,
        changed.length ? `${changed.length} differ` : null,
      ].filter(Boolean).join('; '),
    missing,
    extra,
    changed,
  };
}

/**
 * Value equality that does not care about key order or array order.
 *
 * Array order is ignored deliberately: `intent_keywords` and `triggers` are sets
 * wearing an array, and a reordering during migration is not a behaviour change.
 * A parity check that fails on it would be abandoned within a day, which is worse
 * than one that is slightly loose.
 */
function same(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map(canon).sort(byId);
    const sb = [...b].map(canon).sort(byId);
    return sa.every((v, i) => v === sb[i]);
  }
  if (typeof a === 'object' && typeof b === 'object' && a && b) return canon(a) === canon(b);
  // Whitespace at the edges is a formatting artifact of migration, not content.
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return false;
}

/** Key-order-independent JSON, so two equal objects compare equal. */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort(byId).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

/** The fields that define sameness, per kind. */
export const PARITY_FIELDS = Object.freeze({
  // A process IS its narrative — that is the thing an agent recalls. name and
  // description are how it is found; intent_keywords is how it is matched.
  process: ['name', 'description', 'narrative', 'intent_keywords'],
  // A responsibility is when it fires and what it is asked to do. `enabled` is
  // included because a responsibility that migrates as disabled is a silent
  // capability loss, which is exactly what parity is for.
  responsibility: ['name', 'schedule', 'event', 'instruction', 'success_criteria', 'enabled'],
});

/**
 * Roll several category verdicts into one.
 *
 * Fails if ANY category fails, and — separately — if no category was checked at
 * all. A parity run over zero categories returning "ok" is the empty-scan defect
 * one level up from compareSets.
 */
export function parityVerdict(categories) {
  const entries = Object.entries(categories || {});
  if (!entries.length) {
    return { ok: false, reason: 'no categories were compared — a parity run that checks nothing is not a pass', categories: {} };
  }
  const failed = entries.filter(([, v]) => !v.ok).map(([k]) => k);
  return {
    ok: !failed.length,
    reason: failed.length ? `parity FAILED for: ${failed.join(', ')}` : `parity holds across ${entries.length} categor${entries.length === 1 ? 'y' : 'ies'}`,
    categories,
  };
}

/** A short human-readable report. */
export function renderParity(verdict) {
  const lines = [verdict.ok ? 'PARITY OK' : 'PARITY FAILED', ''];
  for (const [kind, v] of Object.entries(verdict.categories || {})) {
    lines.push(`${v.ok ? '  ok  ' : '  FAIL'} ${kind.padEnd(16)} ${v.reason}`);
    for (const id of v.missing || []) lines.push(`         - missing from release: ${id}`);
    for (const id of v.extra || []) lines.push(`         + only in release:      ${id}`);
    for (const c of v.changed || []) lines.push(`         ~ differs: ${c.id} (${c.fields.join(', ')})`);
  }
  return lines.join('\n');
}
