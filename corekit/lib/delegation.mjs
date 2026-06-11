// corekit/lib/delegation.mjs — Cross-agent delegation marker compose/parse
// Pure functions, zero dependencies, deterministic.
// Both directions (DELEGATION + DELEGATION-RESULT) in one module.
//
// Wire format:
//   @target [DELEGATION ref:<envId> from:<senderEmail> proj:<projectId>]
//   <human-readable body>
//
//   @sender [DELEGATION-RESULT ref:<envId> status:<complete|failed> mission:<missionId>]
//   <human-readable body>

// ---- Regex patterns ----

const DELEGATION_RE = /\[DELEGATION\s+ref:(\S+)\s+from:(\S+)\s+proj:(\S+)\]/;
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

// ---- Compose ----

/**
 * Compose a delegation marker message for sending via chat-send.
 *
 * @param {object} opts
 * @param {string} opts.targetEmail - Target agent's workspace email (for @mention)
 * @param {string} opts.ref - Parent envelope ID (the delegator's task/checkpoint)
 * @param {string} opts.from - Sender agent's email
 * @param {string} opts.project - Project ID
 * @param {string} opts.body - Human-readable delegation instructions
 * @returns {string} Complete delegation message
 */
export function composeDelegationMarker({ targetEmail, ref, from, project, body }) {
  const marker = `[DELEGATION ref:${ref} from:${from} proj:${project || 'none'}]`;
  const mention = targetEmail ? `@${targetEmail} ` : '';
  return `${mention}${marker}\n${body || ''}`.trim();
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
export function composeDelegationResultMarker({ targetEmail, ref, status, missionId, body }) {
  const marker = `[DELEGATION-RESULT ref:${ref} status:${status} mission:${missionId}]`;
  const mention = targetEmail ? `@${targetEmail} ` : '';
  return `${mention}${marker}\n${body || ''}`.trim();
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
  const body = markerEnd >= 0 ? text.substring(markerEnd + 1).trim() : '';

  return {
    ref: match[1],
    from: match[2],
    project: match[3],
    body,
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
