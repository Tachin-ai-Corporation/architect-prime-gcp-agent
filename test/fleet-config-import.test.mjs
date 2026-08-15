// test/fleet-config-import.test.mjs — golden parity with the shipping catalog
//
// The P2 exit gate: the compiler must reproduce what the repo ships today. Until
// that holds, the registry is a second authority rather than a replacement, and
// switching to it would silently change what agents are.
//
// So this test imports every role, skill, persona and process from the real
// catalog on disk and asserts the result is complete, sealable, internally
// consistent, and compiles to a valid Effective Agent Spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sealRevision, SKILL_SCHEMA, ROLE_SCHEMA, validate } from '../corekit/contracts/index.mjs';
import {
  importRole, importPersona, importSkill, importProcess, importPresentation, extractRecovery,
} from '../corekit/lib/fleet-config/importer.mjs';
import { capabilitiesOf, capabilityFor, resolveSkill, parseManifest } from '../corekit/lib/fleet-config/packages.mjs';
import { compileAgentSpec, capabilityClosure, composePersona, resolveEgress } from '../corekit/lib/fleet-config/compiler.mjs';
import { validateSet, compareVersions, VALIDATOR_NAMES } from '../corekit/lib/fleet-config/validators.mjs';
import { diffSets, diffRevision, renderDiff, impactedAgents } from '../corekit/lib/fleet-config/diff.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const AT = '2026-08-15T12:00:00Z';
const SEAL = { actor: 'importer', now: AT };

// ── Load the real catalog once ─────────────────────────────────────────

const AGENT_TYPES = readJson('corekit/config/agent-types.json').types;
const SPECIALTIES = readdirSync(join(REPO, 'specialties')).filter((d) =>
  statSync(join(REPO, 'specialties', d)).isDirectory()
);

/** skillId → parsed skill.json, across core and specialty catalogs. */
const SKILL_JSONS = new Map();
const SKILL_DOCS = new Map();
const SKILL_OWNER = new Map();

for (const dir of readdirSync(join(REPO, 'skills'))) {
  const metaPath = join(REPO, 'skills', dir, 'skill.json');
  if (!existsSync(metaPath)) continue;
  SKILL_JSONS.set(dir, JSON.parse(readFileSync(metaPath, 'utf8')));
  const docPath = join(REPO, 'skills', dir, 'SKILL.md');
  if (existsSync(docPath)) SKILL_DOCS.set(dir, readFileSync(docPath, 'utf8'));
}
for (const spec of SPECIALTIES) {
  const skillsDir = join(REPO, 'specialties', spec, 'skills');
  if (!existsSync(skillsDir)) continue;
  for (const dir of readdirSync(skillsDir)) {
    const metaPath = join(skillsDir, dir, 'skill.json');
    if (!existsSync(metaPath)) continue;
    SKILL_JSONS.set(dir, JSON.parse(readFileSync(metaPath, 'utf8')));
    SKILL_OWNER.set(dir, spec);
    const docPath = join(skillsDir, dir, 'SKILL.md');
    if (existsSync(docPath)) SKILL_DOCS.set(dir, readFileSync(docPath, 'utf8'));
  }
}

const agentTypeFor = (id) => Object.values(AGENT_TYPES).find((t) => t.id === id) || null;
const kitFor = (id) => {
  const p = join(REPO, 'specialties', id, 'kit.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

// ── Catalog completeness ───────────────────────────────────────────────

test('the catalog holds the 12 roles and 50 skill packages the assessment counted', () => {
  assert.equal(SPECIALTIES.length, 12, `expected 12 specialties, found ${SPECIALTIES.join(', ')}`);
  assert.equal(Object.keys(AGENT_TYPES).length, 12, 'agent-types.json must cover the same 12');
  assert.ok(SKILL_JSONS.size >= 50, `expected at least 50 skill packages, found ${SKILL_JSONS.size}`);
});

test('every specialty has an agent-types entry and vice versa', () => {
  const typeIds = Object.values(AGENT_TYPES).map((t) => t.id).sort();
  assert.deepEqual(typeIds, [...SPECIALTIES].sort(),
    'the two role authorities must name the same roles — this is the drift the Role definition ends');
});

// ── Every role imports, seals, and validates ───────────────────────────

const IMPORTED_ROLES = new Map();
const IMPORTED_PERSONAS = [];

test('every role imports from its three sources and seals into a valid revision', () => {
  for (const id of SPECIALTIES) {
    const { role, notes } = importRole({
      id, agentType: agentTypeFor(id), kit: kitFor(id), skillJsons: SKILL_JSONS,
    });
    const sealed = sealRevision('role', role, SEAL);
    const { valid, errors } = validate(ROLE_SCHEMA, sealed);
    assert.equal(valid, true, `role '${id}': ${JSON.stringify(errors)}`);
    assert.ok(sealed.default_skills.length > 0, `role '${id}' imported no skills`);
    assert.ok(Array.isArray(notes));
    IMPORTED_ROLES.set(id, sealed);
  }
  assert.equal(IMPORTED_ROLES.size, 12);
});

test('the import surfaces the drift between the two skill authorities rather than hiding it', () => {
  // The point of the union: neither source was a superset, so picking one would
  // have silently removed capability an agent has today.
  let disagreements = 0;
  for (const id of SPECIALTIES) {
    const { notes } = importRole({ id, agentType: agentTypeFor(id), kit: kitFor(id), skillJsons: SKILL_JSONS });
    if (notes.some((n) => n.includes('absent from'))) disagreements++;
  }
  assert.ok(disagreements > 0,
    'agent-types.json and kit.json genuinely disagree today — the importer must report it, not paper over it');
});

test('capabilities are derived from the skills a role holds, never authored', () => {
  for (const [id, role] of IMPORTED_ROLES) {
    const expected = new Set();
    for (const s of role.default_skills) {
      const meta = SKILL_JSONS.get(s);
      if (meta) for (const c of capabilitiesOf(meta)) expected.add(c);
    }
    assert.deepEqual(role.capabilities, [...expected].sort(), `role '${id}' capability closure`);
  }
});

test('every soul overlay in the catalog imports and seals', () => {
  for (const spec of SPECIALTIES) {
    const brainDir = join(REPO, 'specialties', spec, 'brain');
    if (!existsSync(brainDir)) continue;
    for (const organ of readdirSync(brainDir)) {
      const p = join(brainDir, organ, 'SOUL_APPEND.md');
      if (!existsSync(p)) continue;
      const draft = importPersona({ roleId: spec, organ, body: readFileSync(p, 'utf8') });
      const sealed = sealRevision('persona', draft, SEAL);
      assert.equal(sealed.organ, organ);
      assert.equal(sealed.role_id, spec);
      assert.ok(sealed.body.length > 0, `${spec}/${organ} overlay is empty`);
      IMPORTED_PERSONAS.push(sealed);
    }
  }
  assert.ok(IMPORTED_PERSONAS.length >= 12, `expected overlays across the fleet, found ${IMPORTED_PERSONAS.length}`);
});

test('every skill package imports and seals into a valid revision', () => {
  let sealedCount = 0;
  const failures = [];
  for (const [id, meta] of SKILL_JSONS) {
    const doc = SKILL_DOCS.get(id);
    if (!doc) { failures.push(`${id}: no SKILL.md`); continue; }
    try {
      const sealed = sealRevision('skill', importSkill({ meta, doc }), SEAL);
      const { valid, errors } = validate(SKILL_SCHEMA, sealed);
      if (!valid) { failures.push(`${id}: ${JSON.stringify(errors)}`); continue; }
      sealedCount++;
    } catch (e) {
      failures.push(`${id}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], 'every shipping skill must survive the round trip');
  assert.ok(sealedCount >= 50, `expected 50+ skills sealed, got ${sealedCount}`);
});

test('recovery guidance is lifted out of the catalog rather than lost', () => {
  let withRecovery = 0;
  for (const [id, doc] of SKILL_DOCS) {
    if (extractRecovery(doc).length) withRecovery++;
  }
  assert.ok(withRecovery >= 5,
    `expected several shipping skills to carry error-recovery tables, found ${withRecovery}`);
});

test('extractRecovery reads a table and ignores unrelated ones', () => {
  const doc = [
    '| Situation | Use |', '|---|---|', '| Some case | Some tool |', '',
    '## Error recovery', '',
    '| Symptom | Cause | Action |',
    '|---|---|---|',
    '| 403 on deploy | missing grant | ask the operator for firebase.admin |',
    '| blank page | wrong public dir | redeploy from a clean clone |',
  ].join('\n');
  const rows = extractRecovery(doc);
  assert.equal(rows.length, 2, 'only the recovery table is read');
  assert.equal(rows[0].symptom, '403 on deploy');
  assert.equal(rows[0].cause, 'missing grant');
  assert.match(rows[1].action, /clean clone/);
});

test('every bundled process imports and seals', () => {
  const dir = join(REPO, 'corekit', 'config', 'processes');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  assert.ok(files.length > 0, 'the catalog ships starter playbooks');
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const sealed = sealRevision('process', importProcess(raw), SEAL);
    assert.equal(sealed.id, raw.id);
    assert.ok(sealed.narrative.length >= 50, `${f}: narrative too short to be a playbook`);
  }
});

test('presentation metadata is imported beside the role, not inside it', () => {
  const p = importPresentation({ id: 'web-master', agentType: agentTypeFor('web-master') });
  assert.equal(p.id, 'web-master');
  assert.ok(p.glyph);
  assert.ok(p.email_pattern.includes('{name}'));
  // A colour change must not churn a revision agents run on.
  assert.equal(IMPORTED_ROLES.get('web-master').accent, undefined);
  assert.equal(IMPORTED_ROLES.get('web-master').glyph, undefined);
});

// ── The whole imported set validates ───────────────────────────────────

test('an empty definition set FAILS validation rather than passing vacuously', () => {
  // Found in production: a change whose content never reached the registry
  // validated clean, because every rule is satisfied by nothing. "Validated"
  // then meant "nothing was checked" — and the change was eligible for release.
  const result = validateSet({ definitions: [], available: {}, platformVersion: 'v1' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'set:empty');
  assert.match(result.errors[0].message, /nothing was validated/);
});

test('a set that is genuinely expected to be empty can say so explicitly', () => {
  const result = validateSet({ definitions: [], available: {}, platformVersion: 'v1', expectDefinitions: false });
  assert.equal(result.ok, true);
});

test('the imported catalog passes every validator', () => {
  const definitions = [
    ...[...IMPORTED_ROLES.values()].map((def) => ({ kind: 'role', def })),
    ...IMPORTED_PERSONAS.map((def) => ({ kind: 'persona', def })),
  ];
  const available = {
    role: new Set(IMPORTED_ROLES.keys()),
    skill: new Set(SKILL_JSONS.keys()),
    responsibility: new Set(),
    policy: new Set(),
    evalSuite: new Set(),
  };
  const result = validateSet({ definitions, available, platformVersion: 'v2026.08.15.3.1' });
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors, null, 2));
  assert.equal(VALIDATOR_NAMES.length, 6, 'every validator is named so an absent check is not a pass');
});

// ── Compilation ────────────────────────────────────────────────────────

test('a role compiles to a valid Effective Agent Spec with a stable digest', () => {
  const role = IMPORTED_ROLES.get('web-master');
  const personas = IMPORTED_PERSONAS.filter((p) => p.role_id === 'web-master');
  const skills = role.default_skills
    .filter((s) => SKILL_JSONS.has(s) && SKILL_DOCS.has(s))
    .map((s) => sealRevision('skill', importSkill({ meta: SKILL_JSONS.get(s), doc: SKILL_DOCS.get(s) }), SEAL));

  const firmware = Object.fromEntries(
    [...new Set(personas.map((p) => p.organ))].map((o) => [o, `# ${o}\n\nBase firmware for ${o}.`])
  );

  const input = {
    agentId: 'tom', platformVersion: 'v2026.08.15.3.1', fleetRelease: 'fr-import',
    role, personas, skills, responsibilities: [], firmware, compiledAt: AT,
  };
  const a = compileAgentSpec(input);
  const b = compileAgentSpec(input);

  assert.equal(a.spec.digest, b.spec.digest, 'compilation is deterministic — the digest is a replay key (C-32)');
  assert.match(a.spec.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.spec.role.revision, role.revision);
  assert.ok(a.spec.skills.length > 0);
  assert.ok(Object.keys(a.files).some((f) => f.endsWith('SOUL.md')), 'the bundle renders personas');
  assert.ok(Object.keys(a.files).some((f) => f.endsWith('SKILL.md')), 'the bundle renders skills');
});

test('a change to any input changes the spec digest', () => {
  const role = IMPORTED_ROLES.get('assistant');
  const base = {
    agentId: 'millie', platformVersion: 'v1', fleetRelease: 'fr-1',
    role, personas: [], skills: [], responsibilities: [],
    firmware: { cortex: '# cortex' }, compiledAt: AT,
  };
  const before = compileAgentSpec(base).spec.digest;

  const edited = sealRevision('role', { ...role, purpose: role.purpose + ' And it reviews its own work.' }, SEAL);
  const after = compileAgentSpec({ ...base, role: edited }).spec.digest;
  assert.notEqual(before, after);
});

test('composition order is firmware, then role, then deployment, then agent', () => {
  const overlays = [
    { id: 'a', organ: 'cortex', layer: 'agent', body: 'AGENT', revision: 'rev-000000000003' },
    { id: 'r', organ: 'cortex', layer: 'role', body: 'ROLE', revision: 'rev-000000000001' },
    { id: 'd', organ: 'cortex', layer: 'deployment', body: 'DEPLOYMENT', revision: 'rev-000000000002' },
  ];
  const out = composePersona('cortex', '# FIRMWARE', overlays);
  const order = ['FIRMWARE', 'ROLE', 'DEPLOYMENT', 'AGENT'].map((t) => out.indexOf(t));
  assert.deepEqual(order, [...order].sort((x, y) => x - y), `composed in the wrong order:\n${out}`);
});

test('an overlay for another organ does not leak into this one', () => {
  const out = composePersona('cortex', '# cortex', [
    { id: 'm', organ: 'motor', layer: 'role', body: 'MOTOR ONLY', revision: 'rev-000000000001' },
  ]);
  assert.ok(!out.includes('MOTOR ONLY'));
});

// ── The boundaries hold (C-33, B-36) ───────────────────────────────────

test('a skill binding a capability its role lacks fails the compile (C-33)', () => {
  const role = IMPORTED_ROLES.get('assistant');
  const rogue = sealRevision('skill', {
    id: 'rogue', name: 'Rogue', summary: 'Drives a binary this role was never granted.',
    triggers: ['do the forbidden thing'], procedure: 'Run the tool that was not granted.',
    tool_bindings: [capabilityFor('kubectl')],
  }, SEAL);

  assert.throws(
    () => compileAgentSpec({
      agentId: 'millie', platformVersion: 'v1', fleetRelease: 'fr-1',
      role, personas: [], skills: [rogue], responsibilities: [],
      firmware: { cortex: '# cortex' }, compiledAt: AT,
    }),
    (e) => /capability closure failed/.test(e.message) && /Platform Finding/.test(e.message)
  );
});

test('capabilityClosure reports both the missing and the unjustified', () => {
  const role = { id: 'r', capabilities: ['tool.a.invoke', 'tool.unused.invoke'] };
  const skills = [
    { id: 's1', tool_bindings: ['tool.a.invoke'] },
    { id: 's2', tool_bindings: ['tool.b.invoke'] },
  ];
  const c = capabilityClosure(role, skills);
  assert.deepEqual(c.missing, [{ capability: 'tool.b.invoke', requiredBy: ['s2'] }]);
  assert.deepEqual(c.unused, ['tool.unused.invoke']);
});

test('an overlay cannot set a protected field (B-36)', () => {
  const role = IMPORTED_ROLES.get('assistant');
  for (const field of ['capabilities', 'egress_class', 'secret_handles', 'bundle']) {
    assert.throws(
      () => compileAgentSpec({
        agentId: 'millie', platformVersion: 'v1', fleetRelease: 'fr-1',
        role, personas: [], skills: [], responsibilities: [],
        firmware: { cortex: '# cortex' }, compiledAt: AT,
        projectOverlay: { [field]: 'anything' },
      }),
      (e) => new RegExp(`protected field '${field}'`).test(e.message),
      `overlay setting ${field} must be refused`
    );
  }
});

test('an overlay may narrow egress but never widen it (C-33)', () => {
  const narrowed = resolveEgress('tenant', [{ id: 'p', egress_class: 'none' }]);
  assert.equal(narrowed.egress_class, 'none');
  assert.equal(narrowed.widened_by, null);

  const widened = resolveEgress('none', [{ id: 'p', egress_class: 'declared', declared_hosts: ['x.example'] }]);
  assert.equal(widened.egress_class, 'none', 'the widening is refused');
  assert.equal(widened.widened_by, 'p', 'and attributed');
});

// ── A new role needs no repo change ────────────────────────────────────

test('a role composed only from existing capabilities compiles with no repo change', () => {
  // The §11.3 scenario: "we need a customer-support analyst who can classify
  // tickets and draft replies", built from what the platform already exposes.
  const borrowed = ['workspace-gmail', 'workspace-docs', 'memory-recall']
    .filter((s) => SKILL_JSONS.has(s) && SKILL_DOCS.has(s));
  assert.ok(borrowed.length >= 2, 'the catalog must already expose reusable skills');

  const skills = borrowed.map((s) =>
    sealRevision('skill', importSkill({ meta: SKILL_JSONS.get(s), doc: SKILL_DOCS.get(s) }), SEAL));

  const capabilities = [...new Set(skills.flatMap((s) => s.tool_bindings))].sort();
  const role = sealRevision('role', {
    id: 'support-analyst',
    name: 'Customer Support Analyst',
    purpose: 'Classify inbound support tickets and draft replies for human review before anything is sent.',
    owned_outcomes: ['Every ticket is classified within the working day', 'Draft replies are accurate and on-tone'],
    decision_posture: 'Drafts, never sends. Escalates anything touching billing or account access.',
    default_skills: borrowed,
    capabilities,
  }, { actor: 'prime', now: AT });

  const { spec, closure, warnings } = compileAgentSpec({
    agentId: 'canary-support', platformVersion: 'v2026.08.15.3.1', fleetRelease: 'fr-candidate',
    role, personas: [], skills, responsibilities: [],
    firmware: { cortex: '# cortex\n\nBase firmware.' }, compiledAt: AT,
  });

  assert.equal(closure.missing.length, 0, 'nothing outside the platform was requested');
  assert.deepEqual(warnings, [], 'no capability was declared without a user');
  assert.match(spec.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(spec.role.id, 'support-analyst');
});

// ── Semantic diff ──────────────────────────────────────────────────────

test('a diff describes what changed about the agent, not a patch', () => {
  const before = IMPORTED_ROLES.get('devops');
  const after = sealRevision('role', {
    ...before,
    default_skills: [...before.default_skills, 'site-audit'].sort(),
    capabilities: before.capabilities,
  }, SEAL);

  const d = diffRevision('role', before, after);
  assert.ok(d.fields.includes('default_skills'));
  assert.match(d.summary, /\+site-audit/);
  assert.ok(!d.summary.includes('@@'), 'a semantic diff is not a patch');
});

test('identical content produces no diff entry', () => {
  const role = IMPORTED_ROLES.get('qa');
  assert.equal(diffRevision('role', role, role), null);
  assert.deepEqual(diffSets(new Map([['role/qa', role]]), new Map([['role/qa', role]])), []);
});

test('a diff set reports adds, updates and deprecations', () => {
  const qa = IMPORTED_ROLES.get('qa');
  const pm = IMPORTED_ROLES.get('pm');
  const updated = sealRevision('role', { ...qa, name: 'Quality Engineering' }, SEAL);

  const entries = diffSets(
    new Map([['role/qa', qa], ['role/pm', pm]]),
    new Map([['role/qa', updated], ['role/security', IMPORTED_ROLES.get('security')]])
  );
  const ops = Object.fromEntries(entries.map((e) => [e.id, e.op]));
  assert.equal(ops.qa, 'update');
  assert.equal(ops.pm, 'deprecate');
  assert.equal(ops.security, 'add');
  assert.match(renderDiff(entries), /\*\*Added\*\*[\s\S]*\*\*Changed\*\*[\s\S]*\*\*Deprecated\*\*/);
});

test('impact analysis answers "who does this touch"', () => {
  const roles = new Map([...IMPORTED_ROLES].map(([id, r]) => [id, r]));
  const assignments = [
    { agent_id: 'millie', role_id: 'assistant' },
    { agent_id: 'stan', role_id: 'devops' },
    { agent_id: 'tom', role_id: 'web-master' },
  ];
  // firebase is held by devops and reused by web-master, not by assistant.
  const touched = impactedAgents([{ kind: 'skill', id: 'firebase', op: 'update' }], roles, assignments);
  assert.ok(touched.includes('stan'));
  assert.ok(touched.includes('tom'));
  assert.ok(!touched.includes('millie'), 'an assistant is untouched by a firebase change');

  // A playbook is fleet-wide know-how.
  const all = impactedAgents([{ kind: 'process', id: 'p-plan', op: 'update' }], roles, assignments);
  assert.deepEqual(all, ['millie', 'stan', 'tom']);
});

// ── Version comparison ─────────────────────────────────────────────────

test('version comparison is component-wise, not lexical', () => {
  assert.equal(compareVersions('v2026.08.15.2.0', 'v2026.08.09.3.2'), 1);
  assert.equal(compareVersions('v2026.08.15.10.0', 'v2026.08.15.9.0'), 1, 'lexical compare gets this wrong');
  assert.equal(compareVersions('v2026.08.15.2.0', 'v2026.08.15.2.0'), 0);
});

// ── Manifest resolution ────────────────────────────────────────────────

test('a reused skill resolves to its owning specialty', () => {
  const catalog = { coreSkills: new Set(SKILL_JSONS.keys()), specialtySkills: SKILL_OWNER };
  const firebase = resolveSkill('firebase', catalog);
  assert.equal(firebase.owner, 'devops', 'firebase is owned by devops even when web-master reuses it');
  assert.equal(firebase.root, 'specialties/devops/skills/firebase');

  const core = resolveSkill('verification', catalog);
  assert.equal(core.owner, null);
  assert.equal(core.root, 'skills/verification');
});

test('the shipping job manifests parse into comparable pairs', () => {
  for (const id of SPECIALTIES) {
    const p = `infra/manifests/job-${id}.txt`;
    const pairs = parseManifest(read(p));
    assert.ok(pairs.length > 0, `${p} parsed to nothing`);
    for (const { source, dest } of pairs) {
      assert.ok(source && dest, `${p}: malformed line`);
      assert.ok(!source.startsWith('#'), `${p}: comment leaked into a pair`);
    }
  }
});

test('a reused skill installs into the reusing role namespace, not the owner (C-9)', () => {
  // The load-bearing rule: skill-setup provisions dependencies only for skills
  // under corekit/specialties/${SPECIALTY}/skills/. web-master reuses firebase
  // from devops, and the shipping manifest installs it into web-master's
  // namespace precisely so its firebase-tools dependency gets installed.
  const pairs = parseManifest(read('infra/manifests/job-web-master.txt'));
  const fb = pairs.find((p) => p.source.endsWith('devops/skills/firebase/SKILL.md'));
  assert.ok(fb, 'web-master must reuse the devops firebase skill');
  assert.equal(fb.dest, 'corekit/specialties/web-master/skills/firebase/SKILL.md',
    'a reused skill installs into the REUSING role namespace — installing it under the owner leaves skill-setup blind to it');
});
