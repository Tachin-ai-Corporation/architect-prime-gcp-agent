// platform/context/history.mjs — Envelope history writer
// Extracted from agent-brain.mjs Phase 3
//
// Appends state transition records to Firestore history subcollections
// under work/{envelopeId}/history/. Uses a monotonic counter for intra-ms
// ordering to guarantee unique, ordered history IDs.
//
// All Firestore access uses injected wrappers — no raw REST globals.

/**
 * Create a history writer instance.
 *
 * @param {object} deps
 * @param {function} deps.firestoreWrite - async (collection, docId, data) => result
 * @param {function} deps.logger         - (level, msg) logging function
 * @returns {object} History writer API
 */
export function createHistoryWriter(deps) {
  const { firestoreWrite } = deps;
  const log = deps.logger || ((level, msg) => console.log(`[history] ${level}: ${msg}`));

  // ---- Internal state: monotonic tiebreaker ----
  let _historyCounter = 0;
  let _historyLastMs = 0;

  /**
   * Append a state transition record to an envelope's history subcollection.
   *
   * Each record gets a unique ID based on `{ms}-{counter}` where counter
   * increments within the same millisecond to prevent collisions.
   *
   * CP4: Optional logicalKey parameter for replay dedup. When provided,
   * uses the logical key as the document ID instead of the timestamp-based
   * key. Firestore PATCH is upsert semantics, so replaying the same
   * logical transition produces an overwrite rather than a duplicate.
   *
   * @param {string}      envelopeId - Envelope ID (parent document)
   * @param {string|null} prevStatus - Previous status (null for creation)
   * @param {string}      newStatus  - New status being transitioned to
   * @param {string}      agent      - Agent or system that triggered the transition
   * @param {string}      detail     - Human-readable description (truncated to 1000 chars)
   * @param {string}      [logicalKey] - Optional dedup key for replay-safe writes
   */
  async function write(envelopeId, prevStatus, newStatus, agent, detail, logicalKey) {
    let historyId;
    if (logicalKey) {
      // CP4: Use logical key as doc ID — replay-safe (Firestore PATCH = upsert)
      historyId = logicalKey;
    } else {
      const ms = Date.now();
      if (ms === _historyLastMs) {
        _historyCounter++;
      } else {
        _historyCounter = 0;
        _historyLastMs = ms;
      }
      historyId = `${ms}-${_historyCounter}`;
    }
    await firestoreWrite(`work/${envelopeId}/history`, historyId, {
      seq: Date.now(),
      prev_status: prevStatus,
      new_status: newStatus,
      agent,
      timestamp: new Date().toISOString(),
      detail: (detail || '').substring(0, 1000),
    });
  }

  return {
    /** Append a state transition record to an envelope's history. */
    write,
  };
}
