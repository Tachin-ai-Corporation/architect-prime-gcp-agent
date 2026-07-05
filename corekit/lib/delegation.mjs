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

// ---- Compose ----

/**
 * Compose a delegation marker message for sending via chat-send.
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
