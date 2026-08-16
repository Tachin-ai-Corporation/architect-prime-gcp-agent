// platform/deployment/importer.mjs — bundled catalog → Fleet Definition content
//
// Run once, at deployment bootstrap. After that the tenant registry is the
// authority and this catalog is seed content (ADR-001).
//
// What it collapses: a role's identity was spread across three files that had to
// agree by hand — `corekit/config/agent-types.json` (dashboard presentation and
// a skill list), `specialties/<id>/kit.json` (another skill list, split into base
// and specialty), and `infra/manifests/job-<id>.txt` (the file installs). Nothing
// reconciled them; `validate-contracts` grew a "tri-source skill consistency"
// check specifically because they drifted. One Role definition replaces all
// three, and the manifest becomes generated output.
//
// Pure: every function takes already-read file contents. The CLI does the I/O, so
// the import is testable with no filesystem and no GCP.

import { capabilitiesOf } from './packages.mjs';

/**
 * Import one Role from the three sources that used to define it.
 *
 * @param {object} input
 * @param {string} input.id
 * @param {object|null} input.agentType  - the agent-types.json entry
 * @param {object|null} input.kit        - the kit.json
 * @param {Map<string,object>} input.skillJsons - skillId → parsed skill.json
 * @returns {{ role: object, notes: string[] }} an unsealed Role draft
 */
export function importRole({ id, agentType, kit, skillJsons }) {
  const notes = [];
  if (!agentType && !kit) throw new Error(`role '${id}': no source to import from`);

  // Skill list: the union of both authorities, because they disagreed and
  // silently dropping either side would remove capability an agent has today.
  const fromKit = [...(kit?.base_skills || []), ...(kit?.specialty_skills || [])];
  const fromTypes = agentType?.skills || [];
  const skills = [...new Set([...fromKit, ...fromTypes])].sort();

  const onlyKit = fromKit.filter((s) => !fromTypes.includes(s));
  const onlyTypes = fromTypes.filter((s) => !fromKit.includes(s));
  if (onlyKit.length) notes.push(`kit.json listed skills absent from agent-types.json: ${onlyKit.join(', ')}`);
  if (onlyTypes.length) notes.push(`agent-types.json listed skills absent from kit.json: ${onlyTypes.join(', ')}`);

  // Capabilities are derived, never authored: a role holds exactly the
  // executables its skills drive. Authoring them by hand would immediately
  // reintroduce a second authority for the same fact.
  const capabilities = new Set();
  for (const skillId of skills) {
    const meta = skillJsons.get(skillId);
    if (!meta) { notes.push(`no skill.json for '${skillId}' — capabilities may be incomplete`); continue; }
    for (const cap of capabilitiesOf(meta)) capabilities.add(cap);
  }

  const description = kit?.description || agentType?.specialty || '';
  const purpose = description.length >= 20
    ? description
    : `Own the ${agentType?.title || kit?.name || id} surface for this deployment.`;

  const role = {
    id,
    name: kit?.name || agentType?.title || id,
    purpose,
    // The catalog never recorded outcomes — a role was defined by the tools it
    // held rather than the results it owned. Seeded from the description so the
    // field is honest about being derived, and rewritten by whoever owns the role.
    owned_outcomes: [deriveOutcome(description, id)],
    decision_posture: '',
    collaboration: { delegates_to: [], accepts_from: [], escalation: '' },
    default_skills: skills,
    responsibilities: [],
    capabilities: [...capabilities].sort(),
    secret_handles: [],
    souls: {},
    model_policy: null,
    memory_policy: null,
  };

  return { role, notes };
}

function deriveOutcome(description, id) {
  const first = String(description).split(/[.;]/)[0].trim();
  if (first.length >= 10) return first.replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/^/, 'Delivers ');
  return `Delivers the outcomes of the ${id} role`;
}

/**
 * Import a soul overlay.
 *
 * The organ is taken from the path rather than the content — the file *is* the
 * statement of which organ it composes onto, and inferring it from prose would
 * be guessing.
 */
export function importPersona({ roleId, organ, body }) {
  return {
    id: `${roleId}-${organ}`,
    organ,
    role_id: roleId,
    body: String(body).trim(),
    layer: 'role',
  };
}

/**
 * Import a Skill from its `skill.json` + `SKILL.md` pair.
 *
 * The SKILL.md body becomes the procedure verbatim. It is not re-parsed into
 * sections: the document is the authority on its own structure, and a lossy
 * round trip through an imposed schema would quietly drop the parts an organ
 * relies on.
 */
export function importSkill({ meta, doc }) {
  const triggers = deriveTriggers(meta, doc);
  return {
    id: meta.id,
    name: meta.name || meta.id,
    summary: (meta.description || meta.name || meta.id).slice(0, 500),
    triggers,
    procedure: String(doc).trim(),
    recovery: extractRecovery(doc),
    tool_bindings: capabilitiesOf(meta),
    // `agent_part` is a string in 49 of the 50 shipping packages and an array in
    // one (`skill-introspect`, served by both cortex and prefrontal). The
    // definition normalizes to a list, because "which organs may use this" is
    // genuinely plural — the single-value form was the convention, not the truth.
    organs: normalizeOrgans(meta.agent_part),
    package: null,
    eval_suite: null,
  };
}

function normalizeOrgans(agentPart) {
  if (Array.isArray(agentPart)) return agentPart.filter((o) => typeof o === 'string' && o);
  if (typeof agentPart === 'string' && agentPart) return [agentPart];
  return [];
}

function deriveTriggers(meta, doc) {
  const out = [];
  if (meta.when_to_use) {
    // `when_to_use` is one sentence describing several occasions; split it so a
    // selection cue is a cue rather than a paragraph.
    for (const part of String(meta.when_to_use).split(/,\s+(?=or\b|when\b)|;\s*/)) {
      const t = part.replace(/^(When|when)\s+/, '').trim().replace(/\.$/, '');
      if (t.length >= 3) out.push(t);
    }
  }
  if (!out.length && meta.description) out.push(String(meta.description).slice(0, 200));
  if (!out.length) out.push(`use the ${meta.id} capability`);
  return out;
}

/**
 * Pull error-recovery rows out of a SKILL.md table.
 *
 * Recovery guidance is the difference between a skill and a man page, and it is
 * already written in most of the catalog as a `| symptom | cause | action |`
 * table. Lifting it into structure lets the compiler render it consistently and
 * lets a validator notice when a skill has none.
 */
export function extractRecovery(doc) {
  const rows = [];
  const lines = String(doc).split('\n');
  let inTable = false;
  let cols = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) { inTable = false; cols = null; continue; }

    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (!inTable) {
      const header = cells.map((c) => c.toLowerCase());
      const symptomAt = header.findIndex((h) => /symptom|error|failure|problem/.test(h));
      const actionAt = header.findIndex((h) => /action|fix|recovery|do this|resolution/.test(h));
      if (symptomAt !== -1 && actionAt !== -1) {
        inTable = true;
        cols = { symptom: symptomAt, cause: header.findIndex((h) => /cause|why|reason/.test(h)), action: actionAt };
      }
      continue;
    }
    if (/^[-: ]+$/.test(cells.join(''))) continue; // separator row
    const symptom = cells[cols.symptom];
    const action = cells[cols.action];
    if (!symptom || !action) continue;
    rows.push({
      symptom,
      ...(cols.cause !== -1 && cells[cols.cause] ? { cause: cells[cols.cause] } : {}),
      action,
    });
  }
  return rows;
}

/** Import a narrative playbook from a bundled process JSON. */
export function importProcess(raw) {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description || raw.name,
    narrative: String(raw.narrative || '').trim(),
    intent_keywords: raw.intent_keywords?.length ? raw.intent_keywords : [raw.id],
  };
}

/**
 * Recognize an unrendered template placeholder.
 *
 * The repo is a public template, so its catalog deliberately ships
 * `YOUR_GCP_PROJECT` / `your-gcp-project` / `${VAR}` markers for an operator to
 * replace. A placeholder that survives into runtime state is a literal that
 * looks like a value — the same class of defect as the `${AGENT_USER_EMAIL}`
 * owner that once stamped 548 work envelopes. Importing it as null makes the
 * absence honest.
 */
export function isTemplatePlaceholder(value) {
  if (typeof value !== 'string') return false;
  return /^YOUR[_-]/i.test(value) || /^your-[a-z-]+$/i.test(value) || /\$\{[A-Z_]+\}/.test(value);
}

const orNull = (v) => (isTemplatePlaceholder(v) ? null : (v ?? null));

/** Import a responsibility from a bundled responsibilities file entry. */
export function importResponsibility(raw, roleId) {
  const kind = raw.schedule || raw.cron ? 'schedule' : 'event';
  return {
    id: raw.id || `${roleId}-${String(raw.name || 'responsibility').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: raw.name || raw.id,
    trigger: {
      kind,
      cron: raw.cron || raw.schedule || null,
      timezone: raw.timezone || 'UTC',
      event: raw.event || null,
      catch_up: raw.catch_up || 'once',
    },
    instruction: raw.instruction || raw.description || '',
    success_criteria: raw.success_criteria || raw.accept_criteria || 'The scheduled work completed and reported its outcome.',
    target_agent: orNull(raw.target_agent),
    project_id: orNull(raw.project_id),
    enabled: raw.enabled !== false,
  };
}

/**
 * Presentation metadata the dashboard reads.
 *
 * Kept beside the Role rather than inside it: glyph and accent colour are how a
 * deployment *displays* a role, not what the role is, and they should not churn
 * a role revision that agents run on.
 */
export function importPresentation({ id, agentType }) {
  return {
    id,
    title: agentType?.title || id,
    glyph: agentType?.glyph || '🤖',
    accent: agentType?.accent || '#94a3b8',
    email_pattern: agentType?.emailPattern || `${id}-agent-{name}`,
  };
}
