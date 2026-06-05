// corekit/brain/context.mjs — Conversation Context Manager
//
// Manages conversation history for each agent session. Uses a sliding window
// with rough token-budget-based compaction. Always preserves the system message
// and the last user message.

const DEFAULT_TOKEN_BUDGET = 400_000;

/**
 * Rough token estimate (chars / 4). Good enough for context budgeting.
 * Replace with tiktoken if precision needed.
 */
export function estimateTokens(messages) {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + content.length / 4;
  }, 0);
}

/**
 * Trim oldest messages to fit within token budget.
 * Always preserves:
 *   - The system message (index 0, if role === 'system')
 *   - The last user message
 *
 * @param {Array} messages  Conversation history
 * @param {number} budget   Max estimated tokens (default 400K)
 * @returns {Array}  Trimmed messages (mutated in place)
 */
export function trimToFit(messages, budget = DEFAULT_TOKEN_BUDGET) {
  let trimCount = 0;
  while (estimateTokens(messages) > budget && messages.length > 2) {
    // Remove the second message (oldest non-system)
    const startIdx = messages[0]?.role === 'system' ? 1 : 0;
    if (messages.length <= startIdx + 1) break;
    messages.splice(startIdx, 1);
    trimCount++;
  }
  if (trimCount > 0) {
    console.log(`[context] Trimmed ${trimCount} messages to fit budget (${Math.round(estimateTokens(messages))} tokens)`);
  }
  return messages;
}

/**
 * Append a message and trim if over budget.
 *
 * @param {Array} messages   Conversation history
 * @param {object} newMessage  {role, content} to append
 * @param {number} budget     Max estimated tokens
 * @returns {Array}  Updated messages
 */
export function appendMessage(messages, newMessage, budget = DEFAULT_TOKEN_BUDGET) {
  messages.push(newMessage);
  return trimToFit(messages, budget);
}

/**
 * In-memory session store. Maps sessionId → messages array.
 * For durability, persist to disk periodically (future enhancement).
 */
const sessions = new Map();

/**
 * Get or create a session's message history.
 *
 * @param {string} sessionId
 * @param {string} systemPrompt  System prompt (used only on creation)
 * @returns {Array}  Messages array (mutable reference)
 */
export function getSession(sessionId, systemPrompt = '') {
  if (!sessions.has(sessionId)) {
    const messages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }]
      : [];
    sessions.set(sessionId, messages);
  }
  return sessions.get(sessionId);
}

/**
 * Clear a session's history.
 */
export function clearSession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * List all active session IDs.
 */
export function listSessions() {
  return Array.from(sessions.keys());
}
