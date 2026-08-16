// platform/deployment/validators.mjs — what must hold before content goes live
//
// Schemas judge one record. These judge the *set*: whether references resolve,
// whether the delegation graph terminates, whether a composed persona still fits
// in a prompt, whether anything that must never leave the deployment is about to.
//
// Every validator is pure and returns findings rather than throwing, because a
// change should be able to show an operator all of its problems at once —
// including the ones a compile would never reach because an earlier one aborted.
//
// Findings carry a severity. `error` blocks a release; `warning` does not, but is
// surfaced on the proposal card so nobody promotes past it unknowingly.

const finding = (severity, code, message, subject) => ({ severity, code, message, subject });

/**
 * Patterns for material that must never reach a definition (C-8).
 *
 * Deliberately conservative on the token shapes that are unambiguous, and quiet
 * about anything that would fire on ordinary prose. A false positive here blocks
 * a legitimate change, and a validator that cries wolf gets disabled.
 */
const SECRET_PATTERNS = [
  { code: 'gh-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, what: 'a GitHub token' },
  { code: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/, what: 'a Google API key' },
  { code: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { code: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { code: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: 'a Slack token' },
  { code: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/, what: 'a bearer token' },
  { code: 'pem-block', re: /\bssh-rsa\s+AAAA[0-9A-Za-z+/]{40,}/, what: 'an SSH public key' },
];

/** Text fields worth scanning, per definition kind. */
const TEXT_FIELDS = {
  role: ['purpose', 'decision_posture'],
  persona: ['body'],
  skill: ['summary', 'procedure'],
  process: ['description', 'narrative'],
  responsibility: ['instruction', 'success_criteria'],
  policy: [],
  projectTemplate: ['goal_hint'],
  evalSuite: [],
};

function textOf(kind, def) {
  const fields = TEXT_FIELDS[kind] || [];
  const parts = fields.map((f) => String(def[f] || ''));
  if (kind === 'skill') {
    for (const r of def.recovery || []) parts.push(r.symptom, r.cause || '', r.action);
  }
  if (kind === 'evalSuite') {
    for (const c of def.cases || []) parts.push(c.instruction, c.expect, JSON.stringify(c.fixtures || {}));
  }
  return parts.join('\n');
}

/** C-8: no secret material in any definition, ever. */
export function validateNoSecrets(definitions) {
  const findings = [];
  for (const { kind, def } of definitions) {
    const text = textOf(kind, def);
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) {
        findings.push(finding(
          'error', `secret:${p.code}`,
          `${kind} '${def.id}' contains what looks like ${p.what}. Definitions carry secret *handles*, never values (C-8).`,
          `${kind}/${def.id}`
        ));
      }
    }
  }
  return findings;
}

/**
 * Every reference resolves.
 *
 * The failure this prevents is quiet and expensive: a role listing a skill that
 * does not exist installs nothing, and the agent discovers the gap mid-mission as
 * a capability it was told it had.
 */
export function validateReferences(definitions, available) {
  const findings = [];
  const has = (kind, id) => available[kind]?.has(id);

  for (const { kind, def } of definitions) {
    if (kind === 'role') {
      for (const s of def.default_skills || []) {
        if (!has('skill', s)) {
          findings.push(finding('error', 'ref:skill', `role '${def.id}' assigns unknown skill '${s}'`, `role/${def.id}`));
        }
      }
      for (const r of def.responsibilities || []) {
        if (!has('responsibility', r)) {
          findings.push(finding('error', 'ref:responsibility', `role '${def.id}' enables unknown responsibility '${r}'`, `role/${def.id}`));
        }
      }
      for (const peer of def.collaboration?.delegates_to || []) {
        if (!has('role', peer)) {
          findings.push(finding('warning', 'ref:role', `role '${def.id}' delegates to unknown role '${peer}'`, `role/${def.id}`));
        }
      }
      if (def.model_policy && !has('policy', def.model_policy)) {
        findings.push(finding('error', 'ref:policy', `role '${def.id}' names unknown model policy '${def.model_policy}'`, `role/${def.id}`));
      }
    }
    if (kind === 'persona' && !has('role', def.role_id)) {
      findings.push(finding('error', 'ref:role', `persona '${def.id}' overlays unknown role '${def.role_id}'`, `persona/${def.id}`));
    }
    if (kind === 'skill' && def.eval_suite && !has('evalSuite', def.eval_suite)) {
      findings.push(finding('warning', 'ref:eval', `skill '${def.id}' names unknown eval suite '${def.eval_suite}'`, `skill/${def.id}`));
    }
  }
  return findings;
}

/**
 * The delegation graph terminates.
 *
 * A cycle here is not a crash — it is worse. Work circulates between roles,
 * each hop looks locally reasonable, and the mission burns its iteration budget
 * without anyone doing the work.
 */
export function validateNoCycles(roles) {
  const findings = [];
  const graph = new Map(roles.map((r) => [r.id, r.collaboration?.delegates_to || []]));
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map([...graph.keys()].map((k) => [k, WHITE]));

  const walk = (node, path) => {
    colour.set(node, GREY);
    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue;
      if (colour.get(next) === GREY) {
        const cycle = [...path.slice(path.indexOf(next)), next].join(' → ');
        findings.push(finding('error', 'cycle:delegation', `delegation cycle: ${cycle}`, `role/${node}`));
        continue;
      }
      if (colour.get(next) === WHITE) walk(next, [...path, next]);
    }
    colour.set(node, BLACK);
  };

  for (const id of graph.keys()) if (colour.get(id) === WHITE) walk(id, [id]);
  return findings;
}

/**
 * A composed persona still fits in a prompt (B-4).
 *
 * The runtime already caps SOUL.md at 40,000 characters. Discovering that at
 * install time means a release that validated cleanly fails on the VM; checking
 * the *composed* size here means the operator learns before promoting.
 */
export function validatePromptBudget(composed, limit = 40000) {
  const findings = [];
  for (const [path, text] of Object.entries(composed)) {
    if (!path.endsWith('SOUL.md')) continue;
    if (text.length > limit) {
      findings.push(finding(
        'error', 'budget:prompt',
        `${path} composes to ${text.length} characters, over the ${limit} limit. ` +
        `Every token is paid for on every call (B-4) — trim an overlay rather than raising the cap.`,
        path
      ));
    } else if (text.length > limit * 0.9) {
      findings.push(finding('warning', 'budget:prompt', `${path} is at ${Math.round((text.length / limit) * 100)}% of the prompt budget`, path));
    }
  }
  return findings;
}

/**
 * The release is compatible with the platform it will run on (C-36).
 *
 * Version strings here are the repo's `vYYYY.MM.DD.i.s` form, compared
 * component-wise so `v2026.08.15.2.0` sorts after `v2026.08.09.3.2` — a plain
 * string compare gets that wrong at the index boundary.
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function validateCompatibility(definitions, platformVersion) {
  const findings = [];
  for (const { kind, def } of definitions) {
    const compat = def.platform_compat;
    if (!compat) continue;
    if (compat.min && compareVersions(platformVersion, compat.min) < 0) {
      findings.push(finding(
        'error', 'compat:min',
        `${kind} '${def.id}' requires platform ≥ ${compat.min}, but this deployment runs ${platformVersion}`,
        `${kind}/${def.id}`
      ));
    }
    if (compat.max && compareVersions(platformVersion, compat.max) > 0) {
      findings.push(finding(
        'error', 'compat:max',
        `${kind} '${def.id}' supports platform ≤ ${compat.max}, but this deployment runs ${platformVersion}`,
        `${kind}/${def.id}`
      ));
    }
  }
  return findings;
}

/**
 * A definition may not claim a plane it does not belong to, or smuggle a
 * privileged provider in as content (C-33).
 */
export function validateNoPrivilegeEscalation(definitions) {
  const findings = [];
  for (const { kind, def } of definitions) {
    if (kind !== 'skill') continue;

    // A sandbox package is content; a host binary is a provider. The tell is a
    // package that wants filesystem reach outside the workspace or unlimited
    // egress — both of which the schema already refuses, so this catches the
    // subtler form: a "sandbox" package whose entrypoint is an absolute path.
    const entry = def.package?.entrypoint;
    if (entry && (entry.startsWith('/') || entry.includes('..'))) {
      findings.push(finding(
        'error', 'escalation:entrypoint',
        `skill '${def.id}' package entrypoint '${entry}' escapes its sandbox. ` +
        `A skill that needs a host binary is asking for a capability provider — file a Platform Finding (C-34).`,
        `skill/${def.id}`
      ));
    }
    for (const cap of def.tool_bindings || []) {
      if (cap.endsWith('.gateway') && def.package) {
        findings.push(finding(
          'error', 'escalation:gateway',
          `skill '${def.id}' binds gateway-native tool '${cap}' and also ships a package. ` +
          `Gateway tools are Foundation providers; a package cannot re-implement one.`,
          `skill/${def.id}`
        ));
      }
    }
  }
  return findings;
}

/**
 * Run every validator over a candidate definition set.
 *
 * @param {object} input
 * @param {Array<{kind:string, def:object}>} input.definitions
 * @param {Record<string, Set<string>>} input.available - kind → ids that resolve
 * @param {Record<string,string>} [input.composed]      - rendered bundle, when available
 * @param {string} input.platformVersion
 * @returns {{ ok: boolean, findings: object[], errors: object[], warnings: object[] }}
 */
export function validateSet(input) {
  const { definitions, available, composed = {}, platformVersion, expectDefinitions = true } = input;

  // An empty set satisfies every rule below, which made "validated" mean
  // "nothing was checked" — the worst possible reading of a green result. It
  // happened for real: a change whose content failed to reach the store
  // validated clean and was eligible for release. A validation over nothing is
  // a failure, not a pass.
  if (expectDefinitions && definitions.length === 0) {
    const empty = finding(
      'error', 'set:empty',
      'the definition set is empty — nothing was validated. This usually means the change\'s ' +
      'content did not reach the registry; a validation over nothing must never read as a pass.',
      null
    );
    return { ok: false, findings: [empty], errors: [empty], warnings: [] };
  }

  const roles = definitions.filter((d) => d.kind === 'role').map((d) => d.def);

  const findings = [
    ...validateNoSecrets(definitions),
    ...validateReferences(definitions, available),
    ...validateNoCycles(roles),
    ...validatePromptBudget(composed),
    ...validateCompatibility(definitions, platformVersion),
    ...validateNoPrivilegeEscalation(definitions),
  ];

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  return { ok: errors.length === 0, findings, errors, warnings };
}

/** The validator names that ran — recorded on a Change, because an absent check is not a pass. */
export const VALIDATOR_NAMES = Object.freeze([
  'no-secrets', 'references', 'no-cycles', 'prompt-budget', 'compatibility', 'no-privilege-escalation',
]);
