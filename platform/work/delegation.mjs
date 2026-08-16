// platform/work/delegation.mjs — Cross-agent delegation marker compose/parse
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

/**
 * Symmetric mirror of checkDelegationCapability. Where that guard catches a mis-directed
 * delegation (sending a teammate work THIS agent should do itself), this one catches the
 * opposite: a LOCAL execution task that invokes a distinctive capability the EXECUTING
 * agent's own specialty LACKS but another specialty OWNS. Running it locally can only fail —
 * no skill, no perms — so it should be delegated to the specialty that owns it. This is the
 * generic linchpin behind the observed live failure: a product-architect ran a Firebase
 * deploy on its own motor (it has no firebase skill, no deploy perms) instead of delegating
 * to the devops teammate, then falsely reported success.
 *
 * Pure and conservative, exactly like checkDelegationCapability: fires ONLY when the task
 * instruction *explicitly invokes* a distinctive capability (a skill/CLI id like `firebase`,
 * `gcloud`, `docker`) as a standalone token — never on a filename/path match, never on a
 * GENERIC_SKILL every specialty carries. Returns no reroute when the executor's caps are
 * unknown (never guess), when nothing distinctive is invoked, or when the only owner IS the
 * executor's own specialty.
 *
 * Target selection is deterministic: among specialties that own an invoked-and-missing
 * capability, rank by (1) membership in the project roster, (2) how many of the offending
 * capabilities the specialty covers, (3) specialty id alphabetically. The chosen target is a
 * SPECIALTY id — the caller resolves it to an online agent via the fleet registry (which
 * applies the existing online/self/concurrent/cap/dedup delegation guards).
 *
 * @param {object} o
 * @param {string} o.instruction        - the local task instruction text
 * @param {string} o.executorSpecialty  - the executing agent's specialty id (e.g. 'product-architect')
 * @param {Object<string,string[]>} o.specialtySkills - specialty id -> skill ids
 * @param {string[]} [o.rosterSpecialties] - specialties present on the project roster (preferred targets)
 * @returns {{ reroute: boolean, targetSpecialty: string|null, offending: string[], reason: string }}
 */
export function checkExecutionCapability({ instruction, executorSpecialty, specialtySkills, rosterSpecialties = [] } = {}) {
  const clear = { reroute: false, targetSpecialty: null, offending: [], reason: '' };
  if (!instruction || !executorSpecialty || !specialtySkills) return clear;
  const own = specialtySkills[executorSpecialty];
  if (!Array.isArray(own)) return clear; // unknown executor caps → don't guess
  const ownSet = new Set(own);
  const text = String(instruction).toLowerCase();
  // For each OTHER specialty, the distinctive skills it owns that the executor LACKS and
  // whose id appears as a standalone token in the instruction. Same token-match rule as
  // checkDelegationCapability: boundaries exclude word chars, dots and slashes on both sides
  // so `firebase.json` in an edit task does not read as "deploy via firebase".
  const ownedBy = new Map(); // skill id -> [specialty ids that own it]
  for (const [spec, skills] of Object.entries(specialtySkills)) {
    if (spec === executorSpecialty) continue;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (GENERIC_SKILLS.has(skill) || ownSet.has(skill)) continue;
      const s = escapeRe(String(skill).toLowerCase());
      if (!new RegExp(`(?:^|[^\\w./-])${s}(?:[^\\w./-]|$)`).test(text)) continue;
      if (!ownedBy.has(skill)) ownedBy.set(skill, []);
      ownedBy.get(skill).push(spec);
    }
  }
  const offending = [...ownedBy.keys()];
  if (offending.length === 0) return clear;
  // Tally candidate target specialties across all offending capabilities.
  const tally = new Map(); // specialty -> count of offending caps it covers
  for (const specs of ownedBy.values()) {
    for (const spec of specs) tally.set(spec, (tally.get(spec) || 0) + 1);
  }
  const rosterSet = new Set(Array.isArray(rosterSpecialties) ? rosterSpecialties : []);
  const ranked = [...tally.entries()].sort((a, b) => {
    const ra = rosterSet.has(a[0]) ? 1 : 0, rb = rosterSet.has(b[0]) ? 1 : 0;
    if (rb !== ra) return rb - ra;          // roster members first
    if (b[1] !== a[1]) return b[1] - a[1];  // then most offending caps covered
    return a[0] < b[0] ? -1 : 1;            // then alphabetical (determinism)
  });
  const targetSpecialty = ranked[0][0];
  return {
    reroute: true,
    targetSpecialty,
    offending,
    reason: `local task invokes ${offending.join(', ')} — a capability this '${executorSpecialty}' agent lacks but '${targetSpecialty}' owns; delegate it rather than run it locally`,
  };
}

// ---- Delegation result summarization (childResults / cpResults) ----

/**
 * The agent label for a delegation result. Use the DELEGATE's email
 * (`source_meta.target_agent_email`) — NOT the delegation envelope's `owner`, which
 * is the DELEGATOR. Labelling with `owner` made a COMPLETED delegation read back to
 * cortex as a failed "self-delegation" and triggered a needless re-plan / self-execute.
 * Falls back to `owner`, then `'unknown'`. Pure.
 * @param {object} env - delegation child/task envelope
 * @returns {string}
 */
export function delegationResultAgent(env) {
  if (!env) return 'unknown';
  return (env.source_meta && env.source_meta.target_agent_email) || env.owner || 'unknown';
}

/**
 * Summarize a terminal delegation envelope into the result shape a waiting mission
 * forwards to cortex. Pure; `toStr` coerces possibly-structured fields to a string
 * (inject the daemon's `toStr`). Success = complete|archived — `archived` is a
 * terminal SUCCESS for a delegation (the sweeper archived a delivered result).
 * @param {object} env
 * @param {(v:any)=>string} [toStr]
 * @param {{taskMax?:number, resultMax?:number}} [limits]
 * @returns {{agent:string, task:string, result:string, success:boolean}}
 */
export function summarizeDelegationResult(env, toStr, { taskMax = 200, resultMax = 4000 } = {}) {
  const s = typeof toStr === 'function' ? toStr : (v) => (v == null ? '' : String(v));
  const e = env || {};
  const isSuccess = e.status === 'complete' || e.status === 'archived';
  return {
    agent: delegationResultAgent(e),
    task: s(e.instruction).substring(0, taskMax),
    result: isSuccess ? s(e.output).substring(0, resultMax) : `[FAILED] ${e.error || e.status}`,
    success: isSuccess,
  };
}

// ---- Re-delegation cap (bounded retries → honest escalation) ----
// A checkpoint whose delegation returns with failures is re-queued to cortex, which
// typically re-delegates. Unbounded, a delegate that STRUCTURALLY cannot succeed (an
// input it can't reach, a member it can't add) loops: one live delivery re-delegated
// the same failing review ~6 times over 35 min, then false-completed. These helpers
// bound the retries so the mission escalates to the operator instead of looping.
// Pure, deterministic (B-19).

/**
 * A stable per-checkpoint key for the re-delegation counter. Keys on the delegated
 * checkpoint's OUTCOME (title/instruction) — which the spine pins across re-plans, so
 * re-delegating "the same checkpoint" bumps the same counter even though each re-plan
 * mints a fresh checkpoint envelope id. Pure.
 * @param {object} child - the delegated checkpoint (C) envelope
 * @returns {string}
 */
export function redelegationKey(child) {
  const c = child || {};
  const raw = (c.title || c.instruction || c.id || '').toString();
  const norm = raw.slice(0, 100).toLowerCase().replace(/\s+/g, ' ').trim();
  return norm ? `cp:${norm}` : `id:${c.id || 'unknown'}`;
}

/**
 * Bump the re-delegation counter for a checkpoint. Returns the updated counter map
 * (input not mutated), the new attempt count, and whether the cap is now exceeded.
 * `exceeded` is true once attempts pass `cap` — with cap=2 that is the THIRD failed
 * round (attempts 1 and 2 still re-delegate; the enriched retry gets its chance).
 * Pure.
 * @param {Object<string,number>|undefined} counters
 * @param {string} key
 * @param {number} [cap=2]
 * @returns {{counters: Object<string,number>, attempts: number, exceeded: boolean}}
 */
export function bumpRedelegation(counters, key, cap = 2) {
  const c = { ...(counters || {}) };
  c[key] = (c[key] || 0) + 1;
  return { counters: c, attempts: c[key], exceeded: c[key] > cap };
}

/**
 * Compose the operator-facing escalation when a checkpoint's re-delegation cap is hit.
 * Names the outstanding checkpoint, the delegate, and its last reported reason — an
 * honest "I'm stuck on X, here's why, here's what I need" instead of a false-green.
 * Pure.
 * @param {object} o
 * @param {string} [o.goal]              - the mission goal
 * @param {string} [o.checkpointOutcome] - the checkpoint that keeps failing
 * @param {string} [o.agentLabel]        - the delegate (email/name)
 * @param {string} [o.reason]            - the delegate's last failure summary
 * @param {number} [o.attempts]          - failed rounds so far
 * @returns {string}
 */
export function composeRedelegationEscalation({ goal, checkpointOutcome, agentLabel, reason, attempts } = {}) {
  const lines = [];
  lines.push(`I'm blocked on this delivery and need your input.`);
  if (checkpointOutcome) lines.push('', `**Stuck on:** ${checkpointOutcome}`);
  if (agentLabel) lines.push(`**Delegated to:** ${agentLabel} — ${attempts || 'several'} attempt(s), each unresolved.`);
  if (reason) lines.push('', `**Last reported reason:** ${String(reason).slice(0, 500)}`);
  if (goal) lines.push('', `I can't finish "${String(goal).slice(0, 200)}" until this is resolved.`);
  lines.push('', `Re-delegating again would just loop. What would you like me to do — supply the missing input, adjust the plan, or have me take a different approach?`);
  return lines.join('\n');
}
