// corekit/lib/channel.mjs — Channel addressing primitives and delivery
// Extracted from agent-ears.mjs / agent-mouth.mjs
// Used by ears (Gmail/GChat polling) and mouth (GChat delivery)
//
// Single home for all channel logic, ensuring stable addressing.
// Every message carries an immutable Address stamped at ingestion,
// carried through cognition untouched, and obeyed at delivery.

// ---- Config & Initialization ----

const CHAT_API = 'https://chat.googleapis.com/v1';

let CONTRACTS = {};
let FIRESTORE_URL = '';
let PRIME_ID = '';
let AGENT_HOSTNAME = '';

/**
 * Initialize module with runtime config. Call once at daemon startup.
 *
 * @param {object} params
 * @param {object} params.contracts - contracts configuration
 * @param {string} params.firestoreUrl - Firestore API base URL
 * @param {string} params.primeId - Prime ID
 * @param {string} params.agentHostname - Agent hostname
 */
export function initChannel({ contracts, firestoreUrl, primeId, agentHostname }) {
  CONTRACTS = contracts || {};
  FIRESTORE_URL = firestoreUrl || '';
  PRIME_ID = primeId || '';
  AGENT_HOSTNAME = agentHostname || '';
}

// ---- Pure Helpers ----

/**
 * Create a channel Address.
 *
 * @param {"gchat"|"dashboard"} channel - destination channel
 * @param {object} [opts={}] - configuration options
 * @param {string} [opts.space] - GChat space name
 * @param {string} [opts.thread] - GChat thread name
 * @param {string|null} [opts.fleet_agent] - fleet agent identifier
 * @returns {object} Address object
 */
export function makeAddress(channel, opts = {}) {
  if (channel === 'gchat') {
    return {
      channel: 'gchat',
      space: opts.space || null,
      thread: opts.thread || null,
    };
  }
  return {
    channel: 'dashboard',
    fleet_agent: opts.fleet_agent ?? null,
  };
}

/**
 * Serialize an Address into Firestore mapValue fields.
 * Stored under source_meta.address on intake and envelope documents.
 *
 * @param {object} addr - Address object to serialize
 * @returns {object} Firestore mapValue
 */
export function serializeAddress(addr) {
  if (!addr) return {};
  const fields = {
    channel: { stringValue: addr.channel },
  };
  if (addr.channel === 'gchat') {
    if (addr.space) fields.space = { stringValue: addr.space };
    if (addr.thread) fields.thread = { stringValue: addr.thread };
  } else {
    if (addr.fleet_agent !== undefined && addr.fleet_agent !== null) {
      fields.fleet_agent = { stringValue: addr.fleet_agent };
    }
  }
  return { mapValue: { fields } };
}

/**
 * Parse an Address from Firestore source_meta.
 * Handles both the new address sub-map and legacy flat fields.
 *
 * @param {object} sourceMeta - decoded source_meta fields object
 * @param {string} sourceChannel - 'gchat' | 'dashboard' | 'firestore' fallback
 * @returns {object} Address object
 */
export function parseAddress(sourceMeta, sourceChannel) {
  if (!sourceMeta) return makeAddress(sourceChannel === 'gchat' ? 'gchat' : 'dashboard');

  // New canonical path: source_meta.address map
  const addrMap = sourceMeta.address?.mapValue?.fields;
  if (addrMap) {
    const ch = addrMap.channel?.stringValue || 'gchat';
    if (ch === 'gchat') {
      return makeAddress('gchat', {
        space: addrMap.space?.stringValue || null,
        thread: addrMap.thread?.stringValue || null,
      });
    }
    return makeAddress('dashboard', {
      fleet_agent: addrMap.fleet_agent?.stringValue ?? null,
    });
  }

  // Legacy fallback: flat fields (spaceName / space)
  const space = sourceMeta.spaceName?.stringValue || sourceMeta.space?.stringValue || null;
  const thread = sourceMeta.threadName?.stringValue || null;
  if (space) {
    return makeAddress('gchat', { space, thread });
  }

  // Default based on source_channel
  if (sourceChannel === 'gchat') return makeAddress('gchat');
  return makeAddress('dashboard');
}

/**
 * Generate a stable string key for an Address.
 * Used for cursor maps and deduplication.
 *
 * @param {object} addr - Address object
 * @returns {string} Address key
 */
export function addressKey(addr) {
  if (!addr) return 'unknown';
  if (addr.channel === 'gchat') return `gchat:${addr.space || 'unknown'}`;
  return `dashboard:${addr.fleet_agent || 'prime'}`;
}

/**
 * Convert text to basic GChat markdown.
 *
 * @param {string} text - source text
 * @returns {string} converted text
 */
export function toGChatMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, '*$1*')           // bold-italic → bold
    .replace(/^### (.+)$/gm, '*$1*')                  // h3 → bold
    .replace(/^## (.+)$/gm, '*$1*')                   // h2 → bold
    .replace(/^# (.+)$/gm, '*$1*')                    // h1 → bold
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');          // strip links
}

// ---- Effectful Edge API ----

/**
 * Discover all Chat spaces visible to the agent.
 *
 * @param {string} token - DWD bearer token
 * @returns {Promise<string[]>} list of space resource names
 */
export async function discoverSpaces(token) {
  const res = await fetch(`${CHAT_API}/spaces?pageSize=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.spaces || []).map(s => s.name).filter(Boolean);
}

/**
 * Resolve the agent's own Chat user resource ID.
 * Used for stable echo filtering.
 *
 * @param {string} token - DWD bearer token
 * @returns {Promise<string|null>} user ID or null
 */
export async function resolveAgentUserId(token) {
  try {
    const res = await fetch(`${CHAT_API}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.name || null;  // 'users/12345'
  } catch { return null; }
}

/**
 * Ensure a user is a member of a GChat space.
 * Used for delegation delivery.
 *
 * @param {string} spaceName - space resource name
 * @param {string} userEmail - Workspace email to admit
 * @param {string} token - DWD bearer token
 * @returns {Promise<boolean>} true if member or successfully admitted
 */
export async function ensureSpaceMember(spaceName, userEmail, token) {
  try {
    // Check existing members
    const listRes = await fetch(`${CHAT_API}/${spaceName}/members`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const members = listData.memberships || [];
      const already = members.some(m =>
        m.member?.name === `users/${userEmail}` ||
        m.member?.name?.includes(userEmail)
      );
      if (already) return true;
    }

    // Add member
    const addRes = await fetch(`${CHAT_API}/${spaceName}/members`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        member: { name: `users/${userEmail}`, type: 'HUMAN' },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return addRes.ok;
  } catch { return false; }
}

/**
 * Deliver text to a resolved Address.
 * Single delivery primitive used by Mouth and Ears.
 *
 * @param {object} addr - Address object
 * @param {string} text - message text
 * @param {object} [opts={}] - options
 * @param {string} [opts.token] - auth/DWD bearer token
 * @param {string} [opts.deliveryTarget] - delegation target email
 * @param {boolean} [opts.replyInThread] - whether to reply in thread
 * @param {Function} [opts.log] - logging function
 * @returns {Promise<boolean>} true if delivered successfully
 */
export async function deliverToAddress(addr, text, opts = {}) {
  const { token, deliveryTarget, replyInThread = true, log = () => {}, mentions = [] } = opts;

  if (addr.channel === 'gchat') {
    if (!addr.space) {
      log('ERROR: deliverToAddress: no space on gchat address — dropping', { addr });
      return false;
    }

    // Delegation: ensure target is in the space
    if (deliveryTarget) {
      await ensureSpaceMember(addr.space, deliveryTarget, token);
    }

    let finalMarkdown = toGChatMarkdown(text);
    if (mentions && mentions.length > 0) {
      // De-duplicate tags
      const uniqueMentions = [...new Set(mentions)];
      const tags = uniqueMentions.map(m => `<users/${m}>`).join(' ');
      finalMarkdown += `\n\n${tags}`;
    }

    if (finalMarkdown.length > 4096) {
      log('WARN: Truncating message for GChat 4096 limit', { originalLength: finalMarkdown.length });
      finalMarkdown = finalMarkdown.slice(0, 4093) + '...';
    }

    const body = { text: finalMarkdown };
    let url = `${CHAT_API}/${addr.space}/messages`;
    // Thread reply when the origin was threaded
    if (addr.thread && replyInThread) {
      body.thread = { name: addr.thread };
      url += '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log('ERROR: deliverToAddress: GChat POST failed', {
        status: res.status, space: addr.space, error: errText.slice(0, 200),
      });
      return false;
    }
    return true;
  }

  if (addr.channel === 'dashboard') {
    // Dashboard delivery: write to Firestore messages collection
    const basePath = addr.fleet_agent
      ? `${FIRESTORE_URL}/primes/${PRIME_ID}/fleet/${addr.fleet_agent}/messages`
      : `${FIRESTORE_URL}/primes/${PRIME_ID}/messages`;

    const res = await fetch(basePath, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          text: { stringValue: text },
          sender: { stringValue: AGENT_HOSTNAME || 'agent' },
          timestamp: { timestampValue: new Date().toISOString() },
          processed: { booleanValue: true },
        },
      }),
    });
    return res.ok;
  }

  log('ERROR: deliverToAddress: unknown channel', { channel: addr.channel });
  return false;
}

/**
 * Mirror a GChat reply to fleet Firestore for dashboard visibility.
 * This is an observability write, not a reply destination.
 *
 * @param {string} text - message text
 * @param {string} token - GCE auth token
 * @param {object} [opts={}] - options
 * @param {Function} [opts.log] - logging function
 */
export async function mirrorToDashboard(text, token, opts = {}) {
  const { log = () => {} } = opts;
  if (!PRIME_ID || !AGENT_HOSTNAME) return;
  try {
    const path = `${FIRESTORE_URL}/primes/${PRIME_ID}/fleet/${AGENT_HOSTNAME}/messages`;
    await fetch(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          text: { stringValue: text },
          sender: { stringValue: AGENT_HOSTNAME },
          timestamp: { timestampValue: new Date().toISOString() },
          processed: { booleanValue: true },
        },
      }),
    });
  } catch (err) {
    log('WARN: Dashboard mirror failed', { error: err.message });
  }
}

