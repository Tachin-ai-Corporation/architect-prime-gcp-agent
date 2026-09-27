// platform/work/responsibility-store.mjs — an agent's own responsibilities.
//
// A responsibility has three layers, and each has exactly one writer:
//
//   platform   corekit/responsibilities.json (+ -prime.json) — upkeep every agent
//              runs (memory consolidation, git gc). `locked`: changes only through
//              a platform release (C-30). Nothing below may override it.
//   role       corekit/responsibilities-*.json — the defaults a role ships with,
//              installed by the upgrade or rendered by a Fleet release (content-sync).
//              Prime changes these for a whole role through `fleet-config`.
//   agent      Firestore primes/{prime}/fleet/{agent}/responsibilities/{id} — the
//              agent's OWN edits: overrides of a shipped default and responsibilities
//              it created. Written by `responsibility-manage` — by the agent itself,
//              by Prime improving that agent, or by the dashboard toggle.
//
// Why the agent layer lives in Firestore and not in a file: every earlier writer
// (the agent's responsibility-manage, the dashboard toggle) edited the installed
// responsibilities-job.json in place, and the next CoreKit upgrade reinstalled that
// file — so an agent's own changes vanished silently, and the only change that
// stuck was a repo commit plus an upgrade (C-36). The store survives upgrades and
// VM rebuilds, and the scheduler re-reads it every minute, so a change is live
// without Prime and without an upgrade.
//
// This module is the one place the layering rule lives. The scheduler (what runs),
// introspect (what the dashboard shows and toggles) and responsibility-manage
// (what an author writes) all merge and validate through it, so the three can
// never disagree about what an agent's responsibilities are.
//
// Everything here is pure except loadShipped(), which reads the shipped files.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { RESPONSIBILITY_SCHEMA, PROVENANCE_FIELDS } from '../contracts/schemas/definition.mjs';
import { validate } from '../contracts/validate.mjs';

export const STORE_COLLECTION = 'responsibilities';
export const REVISIONS_COLLECTION = 'revisions';

/** Defaults for contracts.responsibility_store (infra/fleet-policy.json owns the live values). */
export const DEFAULT_POLICY = Object.freeze({
  refresh_ms: 60_000,
  min_interval_minutes: 15,
  max_per_agent: 25,
});

export function resolvePolicy(contracts) {
  const p = contracts?.responsibility_store || {};
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return {
    refresh_ms: num(p.refresh_ms, DEFAULT_POLICY.refresh_ms),
    min_interval_minutes: num(p.min_interval_minutes, DEFAULT_POLICY.min_interval_minutes),
    max_per_agent: num(p.max_per_agent, DEFAULT_POLICY.max_per_agent),
  };
}

/**
 * The Firestore parent that holds an agent's own responsibilities — the same shape
 * as its Core Memory: a fleet agent under primes/{prime}/fleet/{agent}, a Prime at
 * primes/{prime}.
 */
export function storeParent({ primeId, agentId, isPrime }) {
  if (!primeId) throw new Error('storeParent: primeId is required');
  if (isPrime) return `primes/${primeId}`;
  if (!agentId) throw new Error('storeParent: agentId is required for a fleet agent');
  return `primes/${primeId}/fleet/${agentId}`;
}

// ---- The shipped layers ------------------------------------------------------

/**
 * The shipped responsibilities, as the scheduler has always read them: the platform
 * base first, then every responsibilities-*.json overlay sorted by name, first id
 * seen wins (so the base stays authoritative). Each record is tagged with the file
 * it came from in `_source` — an underscore field, so it is never validated or
 * mistaken for part of the contract.
 */
export function loadShipped(coreDir, { onError } = {}) {
  const dir = `${coreDir}/corekit`;
  const files = [];
  if (existsSync(`${dir}/responsibilities.json`)) files.push('responsibilities.json');
  try {
    files.push(...readdirSync(dir).filter((f) => /^responsibilities-.+\.json$/.test(f)).sort());
  } catch { /* corekit dir may not exist in some contexts */ }
  const merged = [];
  const seen = new Set();
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      for (const r of (data.responsibilities || [])) {
        if (!r || !r.id || seen.has(r.id)) continue;
        seen.add(r.id);
        merged.push({ ...r, _source: f });
      }
    } catch (e) {
      if (onError) onError(f, e);
    }
  }
  return merged;
}

// ---- Validation ----------------------------------------------------------------

// The body of a responsibility is the registry contract minus the revision envelope:
// one schema for a released definition and for an agent's own record, so a field
// the release path can carry is a field the agent can write, and vice versa.
const PROVENANCE_ONLY = new Set(Object.keys(PROVENANCE_FIELDS).filter((k) => k !== 'id'));
const BODY_PROPS = Object.fromEntries(
  Object.entries(RESPONSIBILITY_SCHEMA.spec.properties)
    .filter(([k]) => !PROVENANCE_ONLY.has(k))
    // Several shipped responsibilities still nest success_criteria under context —
    // the scheduler reads either — so the body accepts both and the check below
    // insists on one of them.
    .map(([k, spec]) => [k, k === 'success_criteria' ? { ...spec, required: false } : spec]),
);

export const RESPONSIBILITY_BODY_SCHEMA = {
  id: 'responsibility-body',
  version: RESPONSIBILITY_SCHEMA.version,
  spec: {
    type: 'object',
    properties: BODY_PROPS,
    check: (r) => RESPONSIBILITY_SCHEMA.spec.check(r)
      || ((r.success_criteria || r.context?.success_criteria)
        ? null
        : 'success_criteria is required — how the agent knows a firing succeeded'),
  },
};

const CRON_FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 6]];

function checkCronField(expr, lo, hi) {
  if (expr === '*') return null;
  const step = /^\*\/(\d+)$/.exec(expr);
  if (step) return (+step[1] >= 1 && +step[1] <= hi) ? null : `a step must be 1-${hi}`;
  for (const part of expr.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    // The scheduler's matcher understands exactly these forms. Anything else — a name
    // (MON), a stepped range (1-5/2), `7` for Sunday — would parse, never match, and
    // leave a responsibility that silently never fires.
    if (!m) return 'use *, */N, a number, a range (a-b) or a list (a,b) — the scheduler reads nothing else';
    const a = +m[1];
    const b = m[2] === undefined ? a : +m[2];
    if (a < lo || b > hi || a > b) return `values must lie in ${lo}-${hi}`;
  }
  return null;
}

/** null when the scheduler can read `expression`, else what is wrong with it. */
export function checkCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return 'must be a five-field cron expression (minute hour day-of-month month day-of-week)';
  for (let i = 0; i < 5; i += 1) {
    const [label, lo, hi] = CRON_FIELDS[i];
    const err = checkCronField(parts[i], lo, hi);
    if (err) return `${label} '${parts[i]}': ${err}`;
  }
  return null;
}

/**
 * The floor between two fires of one schedule, so a responsibility an agent writes
 * for itself cannot turn into a loop that runs a mission every minute. Measured on
 * the schedule's first few fires from a fixed Monday, in UTC — frequency does not
 * depend on the zone, and a fixed start keeps the verdict deterministic.
 * `nextFire` is the scheduler's cronNextFire, passed in so this module stays a leaf.
 */
export function checkFrequency(expression, minMinutes, nextFire) {
  if (!minMinutes || !nextFire) return null;
  let prev = nextFire(expression, 'UTC', new Date('2026-01-05T00:00:00Z'));
  for (let i = 0; i < 6 && prev; i += 1) {
    const next = nextFire(expression, 'UTC', prev);
    if (!next) break;
    const gap = Math.round((next.getTime() - prev.getTime()) / 60_000);
    if (gap < minMinutes) {
      return `fires ${gap} minute(s) apart; the floor between two fires is ${minMinutes} minutes`;
    }
    prev = next;
  }
  return null;
}

function isKnownZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function scheduleErrors(record, { policy, nextFire }) {
  const errors = [];
  if (typeof record.schedule === 'string' && record.schedule.trim()) {
    const cron = checkCron(record.schedule);
    if (cron) errors.push(`schedule: ${cron}`);
    else {
      const freq = checkFrequency(record.schedule, policy?.min_interval_minutes, nextFire);
      if (freq) errors.push(`schedule: ${freq}`);
    }
  }
  if (typeof record.timezone === 'string' && !isKnownZone(record.timezone)) {
    errors.push(`timezone: '${record.timezone}' is not an IANA zone (e.g. America/Chicago)`);
  }
  return errors;
}

/** Every reason `record` cannot run as a responsibility; [] when it can. */
export function validateBody(record, { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const errors = validate(RESPONSIBILITY_BODY_SCHEMA, record).errors
    .map((e) => `${e.path || '(root)'}: ${e.message}`);
  if (record && typeof record === 'object') errors.push(...scheduleErrors(record, { policy, nextFire }));
  return errors;
}

/** Validate the fields a patch sets, without the shipped record it will apply to. */
export function validatePatch(patch, { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const props = {};
  for (const k of Object.keys(patch || {})) {
    if (BODY_PROPS[k]) props[k] = { ...BODY_PROPS[k], required: false };
  }
  const errors = validate({ id: 'responsibility-patch', version: 1, spec: { type: 'object', properties: props } }, patch)
    .errors.map((e) => `${e.path || '(root)'}: ${e.message}`);
  errors.push(...scheduleErrors(patch || {}, { policy, nextFire }));
  return errors;
}

/**
 * Validate an override: the fields it sets, plus the rules that span fields (a
 * schedule or an event, never both; success criteria somewhere) on the result. The
 * shipped fields it leaves alone are product content and are not re-judged — a
 * template's `YOUR_PROJECT_ID` placeholder must not stop an agent turning a default off.
 */
export function validateOverride(shipped, patch, { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const floor = patch?.schedule && patch.schedule !== shipped?.schedule ? nextFire : null;
  const errors = validatePatch(patch, { policy, nextFire: floor });
  const cross = RESPONSIBILITY_BODY_SCHEMA.spec.check(applyPatch(shipped, patch));
  if (cross) errors.push(cross);
  return errors;
}

// ---- Layering --------------------------------------------------------------------

/**
 * A shipped record with an override applied. Top-level fields replace; `context`
 * merges key by key, so an override that rewrites one process step list leaves the
 * purpose and learnings alone. Fields the override does not name keep flowing from
 * the shipped default — a later product fix still reaches an agent that changed
 * only its schedule.
 */
export function applyPatch(base, patch = {}) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'id') continue;
    if (k === 'context' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.context = { ...(out.context || {}), ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function withoutScratch(r) {
  const out = {};
  for (const [k, v] of Object.entries(r || {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

// The frequency floor governs schedules an author WRITES. A shipped schedule is
// product content with its own review; an override that only flips `enabled` must
// not be refused because the default it sits on is frequent.
function floorOpts(opts, schedule, shippedSchedule) {
  return schedule && schedule !== shippedSchedule ? opts : { ...opts, nextFire: null };
}

/**
 * The responsibilities an agent actually runs: the shipped layers with its own store
 * applied. Store records that are locked out, invalid, or orphaned are reported in
 * `issues` and skipped — the shipped default keeps running — so a bad write can never
 * take a responsibility away or crash the scheduler.
 *
 * Each result carries `_provenance` {origin: shipped|override|agent, source,
 * revision, updated_by, updated_at}.
 *
 * @param {object[]} shipped - from loadShipped()
 * @param {object[]} docs    - the agent's store documents
 * @returns {{effective: object[], issues: Array<{id: string, reason: string}>}}
 */
export function mergeResponsibilities(shipped, docs = [], { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const issues = [];
  const byId = new Map();
  for (const d of docs || []) {
    if (!d || typeof d.id !== 'string' || d.status === 'removed') continue;
    if (d.mode !== 'own' && d.mode !== 'override') {
      issues.push({ id: d.id, reason: `store record has unknown mode '${d.mode}' — ignored` });
      continue;
    }
    byId.set(d.id, d);
  }
  const stamp = (d) => ({ revision: d.revision ?? null, updated_by: d.updated_by ?? null, updated_at: d.updated_at ?? null });

  const effective = [];
  const shippedIds = new Set();
  for (const r of shipped || []) {
    shippedIds.add(r.id);
    const source = r._source || 'shipped';
    const fallback = { ...r, _provenance: { origin: 'shipped', source } };
    const doc = byId.get(r.id);
    if (!doc) { effective.push(fallback); continue; }
    if (r.locked) {
      issues.push({ id: r.id, reason: `locked platform responsibility — the ${doc.mode} (rev ${doc.revision}, by ${doc.updated_by}) is ignored` });
      effective.push(fallback);
      continue;
    }
    const candidate = doc.mode === 'own' ? { ...(doc.body || {}), id: r.id } : applyPatch(r, doc.patch || {});
    const errors = doc.mode === 'own'
      ? validateBody(candidate, floorOpts({ policy, nextFire }, candidate.schedule, r.schedule))
      : validateOverride(r, doc.patch || {}, { policy, nextFire });
    if (errors.length) {
      issues.push({ id: r.id, reason: `${doc.mode} rev ${doc.revision} is invalid, running the shipped default: ${errors.join('; ')}` });
      effective.push(fallback);
      continue;
    }
    effective.push({
      ...withoutScratch(candidate),
      _provenance: doc.mode === 'own'
        ? { origin: 'agent', source, shadows: source, ...stamp(doc) }
        : { origin: 'override', source, ...stamp(doc) },
    });
  }

  for (const doc of byId.values()) {
    if (shippedIds.has(doc.id)) continue;
    if (doc.mode === 'override') {
      issues.push({ id: doc.id, reason: `override rev ${doc.revision} has no shipped default to apply to — ignored` });
      continue;
    }
    const candidate = { ...(doc.body || {}), id: doc.id };
    const errors = validateBody(candidate, { policy, nextFire });
    if (errors.length) {
      issues.push({ id: doc.id, reason: `rev ${doc.revision} is invalid — not scheduled: ${errors.join('; ')}` });
      continue;
    }
    effective.push({ ...withoutScratch(candidate), _provenance: { origin: 'agent', source: 'store', ...stamp(doc) } });
  }
  return { effective, issues };
}

/** One line saying where a responsibility's current definition comes from. */
export function describeProvenance(r) {
  const p = r?._provenance || {};
  const by = p.revision != null ? ` (rev ${p.revision}, by ${p.updated_by || 'unknown'})` : '';
  if (p.origin === 'override') return `${p.source} + override${by}`;
  if (p.origin === 'agent') return p.shadows ? `agent-owned, adopted from ${p.shadows}${by}` : `agent-owned${by}`;
  return `${p.source || r?._source || 'shipped'}${r?.locked ? ' (locked)' : ''}`;
}

/** Cheap change detector for a set of store documents. */
export function storeSignature(docs = []) {
  return docs.map((d) => `${d.id}@${d.revision}:${d.status}`).sort().join('|');
}

// ---- Authoring -------------------------------------------------------------------

const fail = (error) => ({ ok: false, error });
const isActive = (d) => Boolean(d) && d.status !== 'removed';

/**
 * Decide the store document one authoring step produces — no I/O, so every rule is
 * testable and the CLI, the dashboard toggle and Prime all get the same answer.
 *
 * @param {object} a
 * @param {'create'|'update'|'remove'|'reset'|'adopt'|'revert'} a.verb
 * @param {string}  a.id
 * @param {object}  [a.input]       - the fields the author supplied
 * @param {object}  [a.current]     - the store document now (null if none)
 * @param {object}  [a.shipped]     - the shipped record with this id (null if none)
 * @param {boolean} [a.shippedKnown=true] - false when the author cannot see the target's
 *                                    shipped files (Prime editing a fleet agent remotely)
 * @param {object}  [a.revisionDoc] - for revert: the revision to restore
 * @param {number}  [a.ownCount=0]  - the agent's active own records (for max_per_agent)
 * @param {string}  a.actor         - who is writing: an agent id, 'prime:<id>', 'dashboard'
 * @returns {{ok: true, doc: object, summary: string} | {ok: false, error: string}}
 */
export function planWrite({
  verb, id, input = {}, current = null, shipped = null, shippedKnown = true,
  revisionDoc = null, ownCount = 0, actor, note = '', now = new Date().toISOString(),
  policy = DEFAULT_POLICY, nextFire = null,
}) {
  if (!id || typeof id !== 'string') return fail('an id is required');
  if (input && Object.prototype.hasOwnProperty.call(input, 'locked')) {
    return fail('`locked` is reserved for platform responsibilities — it changes only through a platform release');
  }
  if (input?.id && input.id !== id) return fail(`the body's id '${input.id}' does not match '${id}'`);
  if (shipped?.locked && verb !== 'create') {
    return fail(`'${id}' is platform upkeep (locked) — it changes only through a platform release, not per agent`);
  }

  const opts = { policy, nextFire };
  const base = {
    id,
    revision: (current?.revision || 0) + 1,
    status: 'active',
    updated_at: now,
    updated_by: actor || 'unknown',
    ...(note ? { note } : {}),
  };
  const invalid = (errors) => fail(`not a valid responsibility:\n  - ${errors.join('\n  - ')}`);
  const overLimit = () => ownCount >= policy.max_per_agent
    ? fail(`this agent already owns ${ownCount} responsibilities (the limit is ${policy.max_per_agent}) — remove one first`)
    : null;

  switch (verb) {
    case 'create': {
      if (shipped) return fail(`'${id}' ships with this agent — use update to change it, or adopt to take it over`);
      if (isActive(current)) return fail(`'${id}' already exists — use update`);
      const limit = overLimit();
      if (limit) return limit;
      const body = { enabled: true, min_spacing_minutes: 30, ...input, id };
      const errors = validateBody(body, opts);
      if (!body.context?.purpose) errors.push('context.purpose: is required — say why this responsibility exists');
      if (!Array.isArray(body.context?.process) || body.context.process.length === 0) {
        errors.push('context.process: is required — the steps a firing follows');
      }
      if (errors.length) return invalid(errors);
      return { ok: true, doc: { ...base, mode: 'own', body }, summary: `created '${id}'` };
    }

    case 'update': {
      if (!input || Object.keys(input).length === 0) return fail('nothing to update');
      if (current?.mode === 'own' && isActive(current)) {
        const body = applyPatch(current.body, input);
        const errors = validateBody(body, opts);
        if (errors.length) return invalid(errors);
        const kept = current.adopted_from ? { adopted_from: current.adopted_from } : {};
        return { ok: true, doc: { ...base, mode: 'own', body, ...kept }, summary: `updated '${id}'` };
      }
      if (shipped || !shippedKnown || current?.mode === 'override') {
        const prior = current?.mode === 'override' && isActive(current) ? current.patch : {};
        const patch = applyPatch(prior, input);
        delete patch.id;
        const errors = shipped ? validateOverride(shipped, patch, opts) : validatePatch(patch, opts);
        if (errors.length) return invalid(errors);
        const summary = shipped || current?.mode === 'override'
          ? `overrode ${Object.keys(input).join(', ')} on '${id}'`
          : `overrode ${Object.keys(input).join(', ')} on '${id}' (applies if the agent ships '${id}')`;
        return { ok: true, doc: { ...base, mode: 'override', patch }, summary };
      }
      return fail(`'${id}' is not one of this agent's responsibilities — create it first`);
    }

    case 'remove': {
      if (current?.mode === 'own' && isActive(current)) {
        const kept = current.adopted_from ? { adopted_from: current.adopted_from } : {};
        return { ok: true, doc: { ...base, mode: 'own', body: current.body, status: 'removed', ...kept }, summary: `removed '${id}'` };
      }
      if (shipped || current?.mode === 'override') {
        return fail(`'${id}' is a shipped default — turn it off with toggle, or drop your changes with reset`);
      }
      return fail(`'${id}' is not one of this agent's own responsibilities`);
    }

    case 'reset': {
      if (current?.mode === 'override' && isActive(current)) {
        return { ok: true, doc: { ...base, mode: 'override', patch: current.patch, status: 'removed' }, summary: `'${id}' is back to its shipped default` };
      }
      if (current?.mode === 'own' && isActive(current) && current.adopted_from) {
        // Once the product stops shipping it, "back to the default" would silently delete it.
        if (shippedKnown && !shipped) {
          return fail(`'${id}' no longer ships as a default — it is only this agent's own now; use remove to delete it`);
        }
        return { ok: true, doc: { ...base, mode: 'own', body: current.body, status: 'removed', adopted_from: current.adopted_from }, summary: `'${id}' is back to its shipped default` };
      }
      return fail(`'${id}' has no changes to reset`);
    }

    case 'adopt': {
      if (!shipped) {
        return fail(shippedKnown
          ? `'${id}' is not a shipped default on this agent`
          : 'adopt runs on the agent itself — it needs the shipped default it copies');
      }
      if (current?.mode === 'own' && isActive(current)) return fail(`'${id}' is already this agent's own`);
      const limit = overLimit();
      if (limit) return limit;
      const prior = current?.mode === 'override' && isActive(current) ? current.patch : {};
      const body = { ...applyPatch(withoutScratch(applyPatch(shipped, prior)), input), id };
      const errors = validateBody(body, floorOpts(opts, body.schedule, shipped.schedule));
      if (errors.length) return invalid(errors);
      return {
        ok: true,
        doc: { ...base, mode: 'own', body, adopted_from: shipped._source || 'shipped' },
        summary: `'${id}' is now this agent's own (adopted from ${shipped._source || 'shipped'})`,
      };
    }

    case 'revert': {
      if (!current) return fail(`'${id}' has no history`);
      if (!revisionDoc) return fail('no such revision');
      const restored = {
        ...base,
        mode: revisionDoc.mode,
        status: revisionDoc.status || 'active',
        reverted_from: revisionDoc.revision,
        ...(revisionDoc.mode === 'own' ? { body: revisionDoc.body } : { patch: revisionDoc.patch }),
        ...(revisionDoc.adopted_from ? { adopted_from: revisionDoc.adopted_from } : {}),
      };
      if (restored.status === 'active') {
        let errors;
        if (restored.mode === 'own') {
          const record = { ...(restored.body || {}), id };
          errors = validateBody(record, floorOpts(opts, record.schedule, shipped?.schedule));
        } else {
          errors = shipped ? validateOverride(shipped, restored.patch || {}, opts) : validatePatch(restored.patch || {}, opts);
        }
        if (errors.length) return invalid(errors);
      }
      return { ok: true, doc: restored, summary: `'${id}' restored to revision ${revisionDoc.revision}` };
    }

    default:
      return fail(`unknown verb '${verb}'`);
  }
}
