// corekit/lib/delegation.mjs — Cross-agent delegation marker compose/parse
// Pure functions, zero dependencies, deterministic.
// Both directions (DELEGATION + DELEGATION-RESULT) in one module.
//
// Wire format:
//   @target [DELEGATION ref:<envId> from:<senderEmail> proj:<projectId> drive:<folderId>]
//   <human-readable body>
//
//   @sender [DELEGATION-RESULT ref:<envId> status:<complete|failed> mission:<missionId>]
//   <human-readable body>

// ---- Regex patterns ----

const DELEGATION_RE = /\[DELEGATION\s+ref:(\S+)\s+from:(\S+)\s+proj:(\S+)(?:\s+drive:(\S+))?\]/;
const DELEGATION_RESULT_RE = /\[DELEGATION-RESULT\s+ref:(\S+)\s+status:(\S+)\s+mission:(\S+)\]/;

// ---- Fast detection ----

/**
 * Fast check for delegation marker presence (no full parse).
 * @param {string} text
 * @returns {boolean}
 */
export function isDelegationMarker(text) {
  if (!text) return false;
  return text.includes('[DELEGATION ') && DELEGATION_RE.test(text);
}

/**
 * Fast check for delegation result marker presence.
 * @param {string} text
 * @returns {boolean}
 */
export function isDelegationResultMarker(text) {
  if (!text) return false;
  return text.includes('[DELEGATION-RESULT ') && DELEGATION_RESULT_RE.test(text);
}

// ---- Target email normalization ----

/**
 * Normalize a delegation target email that came out of LLM output or was
 * regex-extracted from free text. Strips @mention prefixes, wrapping
 * brackets/quotes, and trailing sentence punctuation (a bare `[\w.-]+@[\w.-]+`
 * extraction captures a sentence-ending period — "agent@example.com." — which
 * GChat then rejects). Pure, deterministic.
 *
 * @param {string} raw
 * @returns {{ email: string|null, valid: boolean }} normalized email and
 *   whether it has a plausible mailbox@domain.tld shape
 */
export function normalizeTargetEmail(raw) {
  if (!raw || typeof raw !== 'string') return { email: null, valid: false };
  let email = raw.trim();
  if (email.startsWith('@')) email = email.substring(1);
  email = email.replace(/^[<("'[]+/, '').replace(/[>)"'\]]+$/, '');
  email = email.replace(/[.,;:!?]+$/, '');
  email = email.toLowerCase();
  const valid = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email);
  return { email: email || null, valid };
}

// ---- Conversational nudge + correlation tag (B-2) ----
// Under C-27/ME-5 the delegation ping is voiced conversational PROSE (the plain
// instruction/summary), and the MOUTH appends ONE deterministic correlation tag
// AFTER voicing (in channel.mjs, out of the LLM's reach). The recipient's ears
// regex-suppress the tag so the ping never becomes an intake / spurious mission —
// pickup is owned by the envelope reconciler (the durable work T), never the ping.
// Detection is a fixed regex (C-4), never an LLM asked "is this a delegation".

const DELEGATION_PING_RE = /\(delegation(?: result)? ref:\s*(\S+?)\)/i;

/**
 * Deterministic correlation tag appended to a voiced delegation ping (post-voicing).
 * @param {{ref:string, kind?:'send'|'result'}} opts
 * @returns {string} e.g. "(delegation ref: w-123)" or "(delegation result ref: w-123)"
 */
export function composeCorrelationTag({ ref, kind } = {}) {
  if (!ref) return '';
  return kind === 'result' ? `(delegation result ref: ${ref})` : `(delegation ref: ${ref})`;
}

/**
 * True if text carries a delegation correlation tag (send or result). Pure regex.
 * @param {string} text
 * @returns {boolean}
 */
export function isDelegationPing(text) {
  if (!text) return false;
  return DELEGATION_PING_RE.test(text);
}

/**
 * Parse the correlation tag from a ping. Pure.
 * @param {string} text
 * @returns {{ ref: string, kind: 'send'|'result' } | null}
 */
export function parseDelegationPing(text) {
  if (!text) return null;
  const m = text.match(DELEGATION_PING_RE);
  if (!m) return null;
  return { ref: m[1], kind: /result/i.test(m[0]) ? 'result' : 'send' };
}

// ---- Compose ----

/**
 * Compose a delegation marker message. The marker is written to an output
 * envelope and delivered by the MOUTH (channel.mjs deliverToAddress) — never via
 * chat-send (C-27: the mouth is the sole outbound egress; chat-send is not on
 * fleet agents). Converting this marker to a voiced conversational nudge is a
 * tracked follow-on.
 *
 * @param {object} opts
 * @param {string} opts.targetEmail - Target agent's workspace email (for @mention)
 * @param {string} opts.ref - Parent envelope ID (the delegator's task/checkpoint)
 * @param {string} opts.from - Sender agent's email
 * @param {string} opts.project - Project ID
 * @param {string} [opts.drive] - Project Drive folder ID (optional)
 * @param {string} opts.body - Human-readable delegation instructions
 * @returns {string} Complete delegation message
 */
export function composeDelegationMarker({ targetEmail, ref, from, project, drive, body, criteria }) {
  let marker = `[DELEGATION ref:${ref} from:${from} proj:${project || 'none'}`;
  if (drive) marker += ` drive:${drive}`;
  marker += ']';
  const mention = targetEmail ? `@${targetEmail} ` : '';
  let result = `${mention}${marker}\n${body || ''}`;
  // Propagate accept criteria to delegate for outcome contract pinning
  if (criteria) {
    result += `\n\n[ACCEPT-CRITERIA]\n${criteria}\n[/ACCEPT-CRITERIA]`;
  }
  return result.trim();
}

/**
 * Compose a delegation result marker for sending back to the delegator.
 *
 * @param {object} opts
 * @param {string} opts.targetEmail - Delegator's email (for @mention)
 * @param {string} opts.ref - Original delegation ref (parent envelope ID)
 * @param {string} opts.status - 'complete' or 'failed'
 * @param {string} opts.missionId - This agent's mission envelope ID
 * @param {string} opts.body - Human-readable result summary
 * @returns {string} Complete result message
 */
export function composeDelegationResultMarker({ targetEmail, ref, status, missionId, body, trailer }) {
  const marker = `[DELEGATION-RESULT ref:${ref} status:${status} mission:${missionId}]`;
  const mention = targetEmail ? `@${targetEmail} ` : '';
  let result = `${mention}${marker}\n${body || ''}`;
  // Structured trailer: deterministic recovery metadata below separator
  if (trailer) {
    const lines = ['---'];
    if (trailer.fullOutputChars != null) lines.push(`full_output: ${trailer.fullOutputChars} chars · work-output-read ${missionId}`);
    if (trailer.artifactRef) lines.push(`artifacts: ${trailer.artifactRef}`);
    if (trailer.artifactStatus) lines.push(`artifact_status: ${trailer.artifactStatus}`);
    result += '\n' + lines.join('\n');
  }
  return result.trim();
}

// ---- Parse ----

/**
 * Parse a delegation marker from message text.
 *
 * @param {string} text - Full message text
 * @returns {{ ref: string, from: string, project: string, body: string } | null}
 */
export function parseDelegationMarker(text) {
  if (!text) return null;
  const match = text.match(DELEGATION_RE);
  if (!match) return null;

  // Extract body: everything after the marker line
  const markerEnd = text.indexOf(']', text.indexOf('[DELEGATION '));
  let body = markerEnd >= 0 ? text.substring(markerEnd + 1).trim() : '';

  // Extract accept criteria from body if present
  let criteria = null;
  const criteriaMatch = body.match(/\[ACCEPT-CRITERIA\]\n([\s\S]*?)\n\[\/ACCEPT-CRITERIA\]/);
  if (criteriaMatch) {
    criteria = criteriaMatch[1].trim();
    // Remove criteria block from body
    body = body.replace(/\n?\n?\[ACCEPT-CRITERIA\][\s\S]*?\[\/ACCEPT-CRITERIA\]/, '').trim();
  }

  return {
    ref: match[1],
    from: match[2],
    project: match[3],
    drive: match[4] || null,
    body,
    criteria,
  };
}

/**
 * Parse a delegation result marker from message text.
 *
 * @param {string} text - Full message text
 * @returns {{ ref: string, status: string, missionId: string, body: string } | null}
 */
export function parseDelegationResultMarker(text) {
  if (!text) return null;
  const match = text.match(DELEGATION_RESULT_RE);
  if (!match) return null;

  const markerEnd = text.indexOf(']', text.indexOf('[DELEGATION-RESULT '));
  const body = markerEnd >= 0 ? text.substring(markerEnd + 1).trim() : '';

  return {
    ref: match[1],
    status: match[2],
    missionId: match[3],
    body,
  };
}

/**
 * Parse the structured trailer from a delegation result marker body.
 * Pure — no I/O, no LLM.
 *
 * @param {string} text - Full delegation result marker text
 * @returns {{ fullOutputChars: number|null, recoveryCommand: string|null, artifactRef: string|null, artifactStatus: string|null } | null}
 */
export function parseResultTrailer(text) {
  if (!text) return null;
  const sepIdx = text.indexOf('\n---\n');
  if (sepIdx < 0) return null;
  const trailerBlock = text.substring(sepIdx + 5);
  const result = { fullOutputChars: null, recoveryCommand: null, artifactRef: null, artifactStatus: null };
  for (const line of trailerBlock.split('\n')) {
    const trimmed = line.trim();
    const fullOutputMatch = trimmed.match(/^full_output:\s*(\d+)\s*chars\s*·\s*(.+)$/);
    if (fullOutputMatch) {
      result.fullOutputChars = parseInt(fullOutputMatch[1], 10);
      result.recoveryCommand = fullOutputMatch[2].trim();
      continue;
    }
    if (trimmed.startsWith('artifacts:')) {
      result.artifactRef = trimmed.substring('artifacts:'.length).trim();
      continue;
    }
    if (trimmed.startsWith('artifact_status:')) {
      result.artifactStatus = trimmed.substring('artifact_status:'.length).trim();
      continue;
    }
  }
  return (result.fullOutputChars || result.artifactRef) ? result : null;
}

// ---- Capability guard (deterministic delegation backstop) ----

// Base skills every specialty carries — too generic to signal a specialty boundary,
// so they are never treated as a distinctive capability the target "lacks".
const GENERIC_SKILLS = new Set([
  'web-search', 'workspace-drive', 'skill-introspect', 'memory-consolidate',
  'memory-recall', 'work-management', 'verification', 'read-my-skills', 'secrets',
  'delegation',
]);

function escapeRe(s) {
  return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Deterministic guard against a *mis-directed* cross-agent delegation — a delegator
 * handing a teammate work that the teammate's specialty cannot do while the delegator's
 * own specialty can. This is the failure we saw live: a devops agent delegated a Firebase
 * DEPLOY (its own specialty's work) to an engineer with no deploy skill, and the engineer
 * blocked. Pure, direction-aware: fires ONLY when work is sent AWAY from the agent that can
 * do it, never the reverse (an engineer delegating a deploy TO devops is fine).
 *
 * Conservative by design: it fires only when the task instruction *explicitly invokes* a
 * distinctive capability (a skill/CLI id like `firebase`, `gcloud`, `docker`) that the
 * delegator has and the target lacks. Item 1 (ownership routing) is the primary fix; this is
 * the backstop that keeps a mis-delegation from silently blocking a delegate.
 *
 * @param {object} o
 * @param {string} o.instruction        - the delegation task instruction text
 * @param {string} o.delegatorSpecialty - the delegating agent's specialty id (e.g. 'devops')
 * @param {string} o.targetSpecialty    - the delegate's specialty id (e.g. 'engineer')
 * @param {Object<string,string[]>} o.specialtySkills - specialty id -> skill ids
 * @returns {{ ok: boolean, selfCapable: boolean, offending: string[], reason: string }}
 */
export function checkDelegationCapability({ instruction, delegatorSpecialty, targetSpecialty, specialtySkills } = {}) {
  const clear = { ok: true, selfCapable: false, offending: [], reason: '' };
  if (!instruction || !delegatorSpecialty || !targetSpecialty || !specialtySkills) return clear;
  if (delegatorSpecialty === targetSpecialty) return clear; // same specialty → self-delegation guard's job
  const own = specialtySkills[delegatorSpecialty];
  const target = specialtySkills[targetSpecialty];
  if (!Array.isArray(own) || own.length === 0) return clear; // unknown delegator caps → don't guess
  const targetSet = new Set(Array.isArray(target) ? target : []);
  // Gap = distinctive capabilities the delegator has that the target lacks.
  const gap = own.filter(s => !GENERIC_SKILLS.has(s) && !targetSet.has(s));
  if (gap.length === 0) return clear;
  const text = String(instruction).toLowerCase();
  // Match a skill id as a standalone token — NOT as part of a filename/path (so a task to
  // edit `firebase.json` does not read as "deploy via firebase"). Boundaries exclude word
  // chars, dots and slashes on both sides.
  const offending = gap.filter(skill => {
    const s = escapeRe(String(skill).toLowerCase());
    return new RegExp(`(?:^|[^\\w./-])${s}(?:[^\\w./-]|$)`).test(text);
  });
  if (offending.length === 0) return clear;
  return {
    ok: false,
    selfCapable: true, // the offending capabilities are, by construction, the delegator's own
    offending,
    reason: `delegation to '${targetSpecialty}' invokes ${offending.join(', ')} — a capability it lacks but this '${delegatorSpecialty}' agent owns; do it yourself instead of delegating`,
  };
}
