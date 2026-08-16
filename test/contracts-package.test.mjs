// test/contracts-package.test.mjs — the contracts package is the authority
//
// Everything downstream (the Fleet Definition registry, the compiler, the
// control plane's generated types) rests on these properties holding:
//
//   * a schema rejects what it does not declare, and says where and why;
//   * a revision's identity is its content — same content, same revision,
//     regardless of who sealed it or when (C-31);
//   * content edited outside the lifecycle is detectable;
//   * every aggregate has exactly one declared plane and one storage path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMAS, COMPILED_SCHEMAS, DEFINITION_KINDS, CATALOG,
  validate, assertValid, coerce, fieldPaths,
  canonicalJson, contentDigest, bytesDigest, treeDigest, sameContent, shortDigest,
  sealRevision, verifyRevision, schemaFor, planeOfSchema,
  isValidId, toId, pathFor, planeOf, aggregatesInPlane, revisionFromDigest,
  ROLE_SCHEMA, PERSONA_SCHEMA, SKILL_SCHEMA, PROCESS_SCHEMA, RESPONSIBILITY_SCHEMA,
  WORK_SCHEMA, APPROVAL_SCHEMA, PLATFORM_FINDING_SCHEMA,
  EFFECTIVE_AGENT_SPEC_SCHEMA, FOUNDATION_RELEASE_SCHEMA, EVALUATION_SCHEMA,
  TERMINAL_STATUSES, ENVELOPE_STATUSES,
} from '../platform/contracts/index.mjs';

const AT = '2026-08-15T12:00:00Z';
const SEAL = { actor: 'maintainer@example.com', now: AT };

const goodProcess = () => ({
  id: 'p-deploy',
  name: 'Staged deploy',
  description: 'How a site change reaches production without surprising anyone.',
  narrative:
    'When a site change goes well, it lands on a preview channel first, someone looks at the ' +
    'rendered page rather than the exit code, and only then is it promoted. The promotion re-uses ' +
    'the reviewed build instead of rebuilding from whatever happens to be on disk.',
  intent_keywords: ['deploy', 'staging', 'promote'],
});

const goodRole = () => ({
  id: 'web-master',
  name: 'Web Master',
  purpose: 'Own the public website end to end — content, structure, deploys, and what visitors see.',
  owned_outcomes: ['The live site reflects the agreed content', 'Every deploy is reversible'],
  default_skills: ['firebase', 'site-audit'],
  capabilities: ['tool.firebase.deploy', 'tool.gcloud.read'],
});

// ── Validator ──────────────────────────────────────────────────────────

test('validate accepts a well-formed record', () => {
  const sealed = sealRevision('process', goodProcess(), SEAL);
  const { valid, errors } = validate(PROCESS_SCHEMA, sealed);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('validate reports every problem at once, each with a path', () => {
  const { valid, errors } = validate(PROCESS_SCHEMA, {
    id: 'Not A Valid Id',
    name: '',
    narrative: 'too short',
    intent_keywords: [],
  });
  assert.equal(valid, false);
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes('id'), 'bad id reported');
  assert.ok(paths.includes('narrative'), 'short narrative reported');
  assert.ok(paths.includes('intent_keywords'), 'empty keywords reported');
  assert.ok(errors.some((e) => e.message === 'is required'), 'missing required fields reported');
  assert.ok(errors.length >= 4, 'errors accumulate rather than short-circuiting');
});

test('validate rejects undeclared fields', () => {
  const sealed = sealRevision('process', goodProcess(), SEAL);
  const { valid, errors } = validate(PROCESS_SCHEMA, { ...sealed, sneaky_field: 'x' });
  assert.equal(valid, false);
  assert.equal(errors[0].path, 'sneaky_field');
  assert.match(errors[0].message, /not a declared field/);
});

test('validate ignores leading-underscore runtime scratch fields', () => {
  const sealed = sealRevision('process', goodProcess(), SEAL);
  const { valid } = validate(PROCESS_SCHEMA, { ...sealed, _files: [], _cp_spine: {} });
  assert.equal(valid, true, 'runtime scratch is threaded in flight, never persisted contract');
});

test('validate distinguishes integer from number', () => {
  const int = { type: 'object', properties: { n: { type: 'integer', required: true } } };
  assert.equal(validate({ id: 't', version: 1, spec: int }, { n: 3 }).valid, true);
  assert.equal(validate({ id: 't', version: 1, spec: int }, { n: 3.5 }).valid, false);
});

test('validate honors nullable independently of required', () => {
  const spec = {
    type: 'object',
    properties: {
      a: { type: 'string', required: true, nullable: true },
      b: { type: 'string', required: true },
    },
  };
  const schema = { id: 't', version: 1, spec };
  assert.equal(validate(schema, { a: null, b: 'x' }).valid, true);
  assert.equal(validate(schema, { a: 'x', b: null }).valid, false);
});

test('assertValid throws with every error in one message', () => {
  assert.throws(
    () => assertValid(PROCESS_SCHEMA, { id: 'ok' }, 'process/ok'),
    (err) => /process\/ok/.test(err.message) && /is required/.test(err.message)
  );
});

test('coerce applies defaults without mutating its input', () => {
  const draft = { id: 'r-x', name: 'X', trigger: { kind: 'event', event: 'push' }, instruction: 'do the thing', success_criteria: 'the thing is done' };
  const out = coerce(RESPONSIBILITY_SCHEMA, draft);
  assert.equal(out.enabled, true, 'default applied');
  assert.equal(out.trigger.timezone, 'UTC', 'nested default applied');
  assert.equal(draft.enabled, undefined, 'input untouched');
});

test('validate never mutates the record it judges', () => {
  const draft = { id: 'p-x' };
  const before = JSON.stringify(draft);
  validate(PROCESS_SCHEMA, draft);
  assert.equal(JSON.stringify(draft), before);
});

test('fieldPaths enumerates nested and array-of-object paths', () => {
  const paths = fieldPaths(RESPONSIBILITY_SCHEMA.spec);
  assert.ok(paths.includes('trigger'));
  assert.ok(paths.includes('trigger.cron'));
  const skillPaths = fieldPaths(SKILL_SCHEMA.spec);
  assert.ok(skillPaths.includes('recovery[].symptom'));
});

// ── Digest and revision identity (C-31) ────────────────────────────────

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test('canonical JSON preserves array order', () => {
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test('a revision is derived from content, not from who sealed it or when', () => {
  const a = sealRevision('process', goodProcess(), { actor: 'alice', now: '2026-01-01T00:00:00Z' });
  const b = sealRevision('process', goodProcess(), { actor: 'bob', now: '2027-06-30T00:00:00Z' });
  assert.equal(a.revision, b.revision, 'identical content must not manufacture history');
  assert.equal(a.digest, b.digest);
});

test('any content change produces a different revision', () => {
  const a = sealRevision('process', goodProcess(), SEAL);
  const b = sealRevision('process', { ...goodProcess(), name: 'Staged deploy v2' }, SEAL);
  assert.notEqual(a.revision, b.revision);
});

test('a sealed revision verifies, and tampering is detected', () => {
  const sealed = sealRevision('process', goodProcess(), SEAL);
  assert.equal(verifyRevision('process', sealed).ok, true);

  const tampered = { ...sealed, narrative: sealed.narrative.replace('preview', 'production') };
  const verdict = verifyRevision('process', tampered);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /digest mismatch/);
});

test('a forged revision id is rejected even when the digest matches', () => {
  const sealed = sealRevision('process', goodProcess(), SEAL);
  const verdict = verifyRevision('process', { ...sealed, revision: 'rev-000000000000' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /revision does not derive/);
});

test('sealRevision refuses an anonymous author', () => {
  assert.throws(() => sealRevision('process', goodProcess(), {}), /requires an actor/);
});

test('sealRevision refuses a non-authorable kind', () => {
  assert.throws(() => sealRevision('work', {}, SEAL), /not authorable Fleet Definition content/);
  assert.throws(() => sealRevision('fleetRelease', {}, SEAL), /not authorable/);
});

test('sameContent ignores revision metadata', () => {
  const a = sealRevision('process', goodProcess(), { actor: 'alice', now: '2026-01-01T00:00:00Z' });
  const b = { ...a, created_by: 'bob', created_at: '2027-01-01T00:00:00Z' };
  assert.equal(sameContent(a, b), true);
});

test('tree digest changes when a file moves', () => {
  const a = treeDigest({ 'workspace/SOUL.md': 'x', 'skills/a/SKILL.md': 'y' });
  const b = treeDigest({ 'workspace/SOUL.md': 'x', 'skills/b/SKILL.md': 'y' });
  assert.notEqual(a, b, 'a bundle is its paths as well as its bytes');
});

test('bytesDigest and shortDigest are stable and readable', () => {
  assert.match(bytesDigest('hello'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(shortDigest('sha256:abcdef0123456789' + '0'.repeat(48)), 'abcdef01');
});

test('revisionFromDigest refuses a malformed digest', () => {
  assert.throws(() => revisionFromDigest('not-a-digest'), /Cannot derive a revision/);
});

// ── Domain rules that catch real defects ───────────────────────────────

test('a soul overlay carrying tool syntax is rejected (C-28)', () => {
  const bad = {
    id: 'web-master-cortex', organ: 'cortex', role_id: 'web-master',
    body: 'I deploy carefully. Always run `firebase deploy --only hosting` before promoting.',
  };
  assert.throws(() => sealRevision('persona', bad, SEAL), /command flag/);
});

test('a playbook written as an executable step list is rejected (C-15)', () => {
  const bad = {
    ...goodProcess(),
    narrative:
      '1. Run gcloud auth login and confirm the account.\n' +
      '2. Then run the deploy and wait for the URL to appear in the output.\n' +
      '3. Finally promote it once the check passes and record the result somewhere.',
  };
  assert.throws(() => sealRevision('process', bad, SEAL), /executable step list/);
});

test('a playbook containing a code block is rejected (C-28)', () => {
  const bad = { ...goodProcess(), narrative: goodProcess().narrative + '\n```\nfirebase deploy\n```' };
  assert.throws(() => sealRevision('process', bad, SEAL), /code block/);
});

test('a role that delegates to itself is rejected', () => {
  const bad = { ...goodRole(), collaboration: { delegates_to: ['web-master'] } };
  assert.throws(() => sealRevision('role', bad, SEAL), /delegates to itself/);
});

test('a capability must be a well-formed provider reference', () => {
  const bad = { ...goodRole(), capabilities: ['deploy the site'] };
  assert.throws(() => sealRevision('role', bad, SEAL), /capabilities/);
});

test('a sandbox package declaring host egress must name its hosts (C-33)', () => {
  const bad = {
    id: 'scraper', name: 'Scraper', summary: 'Fetches a page and extracts a value.',
    triggers: ['scrape a page'], procedure: 'Run the packaged script against the target URL.',
    tool_bindings: ['tool.http.get'],
    package: {
      entrypoint: 'main.mjs', runtime: 'node',
      limits: { cpu_seconds: 10, memory_mb: 128, egress: 'declared', filesystem: 'workspace' },
    },
  };
  assert.throws(() => sealRevision('skill', bad, SEAL), /names no hosts/);
});

test('a schedule trigger without cron, and an event trigger without an event, are rejected', () => {
  const base = { id: 'r-x', name: 'X', instruction: 'do the thing', success_criteria: 'the thing is done' };
  assert.throws(() => sealRevision('responsibility', { ...base, trigger: { kind: 'schedule' } }, SEAL), /requires a cron/);
  assert.throws(() => sealRevision('responsibility', { ...base, trigger: { kind: 'event' } }, SEAL), /requires an event/);
});

test('an evaluation comparing across different models is rejected', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  const record = {
    id: 'fe-x', schema_version: 1, created_at: AT, suite_id: 'suite-a',
    baseline: { release: null, agent_spec_digest: digest, platform_version: 'v1', model: 'gemini-3.6-flash' },
    candidate: { change_id: null, agent_spec_digest: digest, platform_version: 'v1', model: 'claude-opus-4-6' },
    results: [], status: 'running',
  };
  const { valid, errors } = validate(EVALUATION_SCHEMA, record);
  assert.equal(valid, false);
  assert.match(errors.map((e) => e.message).join(' '), /cannot attribute/);
});

test('a Platform Finding that failed its privacy scan is rejected (C-8)', () => {
  const finding = {
    id: 'pf-x', schema_version: 1, created_at: AT, created_by: 'prime',
    title: 'A new connector is required for the ticketing system',
    severity: 'medium', frequency: 'twice a week across two agents', affected_scope: 'support role',
    platform_version: 'v2026.08.15.2.0',
    evidence: { mission_ids: ['m-1'] },
    desired_invariant: 'An agent can read tickets without a human copying them by hand.',
    why_not_definition: 'No approved provider exposes the ticket API; a skill cannot create one.',
    required_class: 'provider',
    privacy_scan: { scanned_at: AT, secrets_found: 1, pii_found: 0 },
    status: 'open',
  };
  const { valid, errors } = validate(PLATFORM_FINDING_SCHEMA, finding);
  assert.equal(valid, false);
  assert.match(errors.map((e) => e.message).join(' '), /sanitize before filing/);
});

test('an effective spec carrying a secret value rather than a handle is rejected (C-8)', () => {
  const digest = 'sha256:' + 'b'.repeat(64);
  const spec = {
    schema_version: 1, agent_id: 'millie', platform_version: 'v1', fleet_release: 'fr-1',
    digest, compiled_at: AT,
    role: { id: 'assistant', revision: 'rev-000000000001' },
    personas: [], skills: [], responsibilities: [],
    capabilities: [], secret_handles: ['firebase-token=ghp_realtokenvalue'],
    egress_class: 'tenant', model_policy: {}, memory_policy: {},
    bundle: { tree_digest: digest, files: {} },
  };
  const { valid, errors } = validate(EFFECTIVE_AGENT_SPEC_SCHEMA, spec);
  assert.equal(valid, false);
  assert.match(errors.map((e) => e.message).join(' '), /handles, not values/);
});

test('a Foundation release cannot activate a mutable image tag (C-35)', () => {
  const digest = 'sha256:' + 'c'.repeat(64);
  const base = {
    schema_version: 1, release_id: 'v2026.08.15.2.0', source_sha: 'a'.repeat(40), created_at: AT,
    artifacts: {
      corekit_digest: digest,
      control_plane_image: 'us-docker.pkg.dev/p/r/control-plane:latest',
      installer_digest: digest, manifest_graph_digest: digest,
    },
    epochs: { contract_epoch: 1, state_schema_epoch: 1, fleet_definition_schema: { min: 1, max: 1 } },
    migrations: [],
    provenance: { builder: 'cloud-build', built_at: AT },
    rollback_target: null,
  };
  assert.equal(validate(FOUNDATION_RELEASE_SCHEMA, base).valid, false, ':latest is not activatable');

  const pinned = { ...base, artifacts: { ...base.artifacts, control_plane_image: `us-docker.pkg.dev/p/r/control-plane@${digest}` } };
  assert.equal(validate(FOUNDATION_RELEASE_SCHEMA, pinned).valid, true, JSON.stringify(validate(FOUNDATION_RELEASE_SCHEMA, pinned).errors));
});

test('an active release without validation evidence is rejected (C-31)', () => {
  const digest = 'sha256:' + 'd'.repeat(64);
  const release = {
    id: 'fr-1', schema_version: 1, created_at: AT, created_by: 'prime', change_ids: ['fc-1'],
    content_ref: { repo: 'system-fleet-config', branch: 'main', commit: 'e'.repeat(40) },
    digest, parent_release: null,
    platform_compat: { min: 'v1', max: null },
    evidence: { validated: false, evaluation_ids: [] },
    status: 'active',
  };
  const { valid, errors } = validate(SCHEMAS.fleetRelease, release);
  assert.equal(valid, false);
  assert.match(errors.map((e) => e.message).join(' '), /validation evidence/);
});

// ── Work envelope rules (C-15) ─────────────────────────────────────────

const envelope = (over = {}) => ({
  id: 'w-1', type: 'T', parent_id: 'c-1', owner: 'a@example.com', status: 'active',
  intent: 'do', instruction: 'do the thing', accept_criteria: 'the thing is done',
  source_channel: 'chat', created_at: AT, updated_at: AT, iteration: 0, ...over,
});

test('a Mission may not nest under another envelope (C-15)', () => {
  const { valid, errors } = validate(WORK_SCHEMA, envelope({ type: 'M', parent_id: 'm-0' }));
  assert.equal(valid, false);
  assert.match(errors.map((e) => e.message).join(' '), /may not nest/);
});

test('a delegated Mission may point at its delegating checkpoint', () => {
  const { valid } = validate(WORK_SCHEMA, envelope({
    type: 'M', parent_id: 'c-1', source_meta: { delegation_parent: 'c-1' },
  }));
  assert.equal(valid, true, 'delegation is a durable handoff, not a nested mission');
});

test('Tasks and Checkpoints require a parent (C-15)', () => {
  assert.equal(validate(WORK_SCHEMA, envelope({ type: 'T', parent_id: null })).valid, false);
  assert.equal(validate(WORK_SCHEMA, envelope({ type: 'C', parent_id: null })).valid, false);
});

test('a complete envelope must record when it completed', () => {
  assert.equal(validate(WORK_SCHEMA, envelope({ status: 'complete' })).valid, false);
  assert.equal(validate(WORK_SCHEMA, envelope({ status: 'complete', completed_at: AT })).valid, true);
});

test('terminal statuses are a subset of the declared status set', () => {
  for (const s of TERMINAL_STATUSES) assert.ok(ENVELOPE_STATUSES.includes(s), `${s} must be a declared status`);
});

test('an approval token binds to an action digest and is consumed once', () => {
  const paths = fieldPaths(APPROVAL_SCHEMA.spec);
  for (const f of ['action_digest', 'scope', 'expires_at', 'consumed_at']) {
    assert.ok(paths.includes(f), `approval must carry ${f}`);
  }
  const digest = 'sha256:' + 'f'.repeat(64);
  const base = {
    id: 'ap-1', envelope_id: 'w-1', owner: 'a@example.com', requested_at: AT, requested_by: 'prime',
    action_summary: 'Promote the site to production', action_digest: digest,
    stakes: 'destructive_or_public', scope: 'once', expires_at: AT,
  };
  assert.equal(validate(APPROVAL_SCHEMA, { ...base, status: 'approved' }).valid, false, 'approved requires a resolver');
  assert.equal(validate(APPROVAL_SCHEMA, { ...base, status: 'approved', resolved_by: 'chill@example.com' }).valid, true);
  assert.equal(validate(APPROVAL_SCHEMA, { ...base, status: 'consumed' }).valid, false, 'consumed requires a timestamp');
});

// ── Catalog and planes (C-29) ──────────────────────────────────────────

test('every schema has exactly one declared plane', () => {
  for (const kind of Object.keys(SCHEMAS)) {
    const plane = planeOfSchema(kind);
    assert.ok(['foundation', 'fleet-definition', 'runtime-state'].includes(plane), `${kind}: ${plane}`);
  }
  for (const kind of Object.keys(COMPILED_SCHEMAS)) {
    assert.equal(planeOfSchema(kind), 'foundation');
  }
});

test('every catalogued aggregate has a schema, and every schema is catalogued', () => {
  for (const kind of Object.keys(CATALOG)) {
    if (kind === 'coreMemory' || kind === 'fleetAgent') continue; // state without a definition schema yet
    assert.ok(SCHEMAS[kind], `catalog entry '${kind}' has no schema`);
  }
  for (const kind of Object.keys(SCHEMAS)) {
    assert.ok(CATALOG[kind], `schema '${kind}' has no storage path`);
  }
});

test('authorable definition kinds are exactly the fleet-definition content aggregates', () => {
  for (const kind of DEFINITION_KINDS) {
    assert.equal(planeOf(kind), 'fleet-definition', `${kind} must be Fleet Definition`);
    assert.equal(CATALOG[kind].store, 'git-store', `${kind} content belongs in the tenant registry`);
  }
});

test('work artifacts are deployment-rooted, not prime-scoped (C-1)', () => {
  assert.equal(pathFor('work', 'w-1'), 'work/w-1');
  assert.equal(pathFor('project', 'p-1'), 'projects/p-1');
  assert.equal(pathFor('approval', 'a-1'), 'approvals/a-1');
  // Actor state legitimately stays prime-scoped.
  assert.equal(pathFor('fleetAgent', 'chuck', 'millie'), 'primes/chuck/fleet/millie');
});

test('pathFor refuses an unknown aggregate', () => {
  assert.throws(() => pathFor('plans', 'x'), /Unknown aggregate/);
  assert.throws(() => schemaFor('plan'), /No schema for/);
});

test('the three planes partition the catalog', () => {
  const all = Object.keys(CATALOG).sort();
  const partitioned = [
    ...aggregatesInPlane('foundation'),
    ...aggregatesInPlane('fleet-definition'),
    ...aggregatesInPlane('runtime-state'),
  ].sort();
  assert.deepEqual(partitioned, all, 'no aggregate is in two planes or none');
});

// ── ID grammar ─────────────────────────────────────────────────────────

test('ids are lowercase kebab-case and path-safe', () => {
  for (const ok of ['a', 'web-master', 'p-deploy-verify', 'agent1']) assert.ok(isValidId(ok), ok);
  for (const bad of ['', '-lead', 'trail-', 'Has Caps', 'has_underscore', 'has/slash', 'a'.repeat(65)]) {
    assert.ok(!isValidId(bad), `${bad} must be rejected`);
  }
});

test('toId normalizes a human name, or refuses', () => {
  assert.equal(toId('  Customer Support Analyst '), 'customer-support-analyst');
  assert.equal(toId('Deploy → Staging!'), 'deploy-staging');
  assert.equal(toId('!!!'), null, 'nothing legal survives — refuse rather than mangle');
});
