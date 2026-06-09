// corekit/lib/approvals.mjs — Approval gate polling and resume handler
// Extracted from agent-brain.mjs Phase 2B
//
// Polls Firestore for approved/rejected approvals and resumes the
// corresponding paused envelopes. Handles both process-based (deterministic
// resumption) and non-process (Cortex loop) approval flows.
//
// All Firestore access uses injected dependencies — no raw globals.

import { getGceToken } from './gce-auth.mjs';

/**
 * Create an approval checker instance.
 *
 * @param {object} deps
 * @param {function} deps.logger                - (level, msg) logging function
 * @param {object}   deps.config
 * @param {string}   deps.config.primeId        - e.g. 'chuck'
 * @param {string}   deps.config.gcpProject     - GCP project ID
 * @param {function} deps.resumeProcessPlan     - async (missionEnvelope) => void — deterministic plan resumption
 * @param {function} deps.processEnvelope       - async (envelope, memory) => void — Cortex loop re-entry
 * @param {function} deps.recallMemory          - async (query, ctx) => memory
 * @param {function} deps.firestoreWrite        - async (collection, docId, data) => result
 * @param {function} deps.firestoreRead         - async (collection, docId) => data
 * @param {function} deps.writeHistory          - async (envelopeId, prevStatus, newStatus, actor, detail) => void
 * @returns {object} Approval checker API
 */
export function createApprovalChecker(deps) {
  const {
    config,
    resumeProcessPlan,
    processEnvelope,
    recallMemory,
    firestoreWrite,
    firestoreRead,
    writeHistory,
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[approvals] ${level}: ${msg}`));

  const {
    primeId,
    gcpProject,
  } = config;

  // Firestore REST base for approval queries (uses direct REST, not firestoreQuery,
  // because approvals need single-field filter queries)
  const FIRESTORE_BASE = gcpProject
    ? `https://firestore.googleapis.com/v1/projects/${gcpProject}/databases/(default)/documents`
    : null;

  // ---- Internal state ----
  let _checkCount = 0;
  let _intervalId = null;

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  /**
   * Check for approved or rejected approvals in Firestore and resume
   * the corresponding paused envelopes.
   *
   * Only runs every 5th call (to reduce polling load when called from
   * a fast intake poll loop).
   */
  async function checkPending() {
    _checkCount++;
    // Only check every 5th call (~15s when called from 3s intake poll)
    if (_checkCount % 5 !== 0) return;

    try {
      const token = await getGceToken();
      if (!token || !primeId || !FIRESTORE_BASE) return;

      // Query for approved or rejected approvals
      for (const targetStatus of ['approved', 'rejected']) {
        const queryUrl = `${FIRESTORE_BASE}/primes/${primeId}/approvals:runQuery`;
        const resp = await fetch(queryUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: 'approvals' }],
              where: {
                fieldFilter: {
                  field: { fieldPath: 'status' },
                  op: 'EQUAL',
                  value: { stringValue: targetStatus },
                },
              },
              limit: 5,
            },
          }),
        });
        if (!resp.ok) continue;

        const results = await resp.json();
        for (const row of results) {
          if (!row.document) continue;
          const fields = row.document.fields || {};
          const approvalId = row.document.name.split('/').pop();
          const envelopeId = fields.envelopeId?.stringValue;
          const processed = fields._processed?.booleanValue;

          if (!envelopeId || processed) continue;

          log('INFO', `Approval ${approvalId} ${targetStatus} — resuming envelope ${envelopeId}`);

          // Mark approval as processed to avoid re-processing
          const approvalDocPath = row.document.name.split('/documents/')[1];
          await fetch(`${FIRESTORE_BASE}/${approvalDocPath}?updateMask.fieldPaths=_processed`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { _processed: { booleanValue: true } } }),
          }).catch(() => {});

          // Load the paused envelope
          const envDoc = await firestoreRead('work', envelopeId);
          if (!envDoc || envDoc.status !== 'awaiting_approval') {
            log('WARN', `Approval ${approvalId}: envelope ${envelopeId} not in awaiting_approval state (${envDoc?.status})`);
            continue;
          }

          const meta = envDoc.source_meta || {};
          const pausedCheckpoints = meta.paused_checkpoints;
          const pausedCpIndex = meta.paused_checkpoint_index;
          const pausedTaskIndex = meta.paused_task_index;
          const pausedAllResults = meta.paused_all_results || [];

          if (!pausedCheckpoints || pausedCpIndex === undefined || pausedTaskIndex === undefined) {
            log('WARN', `Approval ${approvalId}: missing resume state on envelope`);
            continue;
          }

          if (targetStatus === 'rejected') {
            // Cancel remaining tasks and mark as failed
            envDoc.status = 'failed';
            envDoc.output = `Process rejected at approval gate (approval ${approvalId})`;
            envDoc.error = fields.reason?.stringValue || 'Approval rejected by user';
            envDoc.completed_at = now();
            envDoc.updated_at = now();
            if (!envDoc.parent_id) envDoc.delivery_status = 'pending';
            await firestoreWrite('work', envelopeId, envDoc);
            await writeHistory(envelopeId, 'awaiting_approval', 'failed', 'brain', `Approval rejected`);
            log('INFO', `Envelope ${envelopeId} rejected at approval gate`);
            continue;
          }

          // Approved — resume execution
          if (envDoc.process_id) {
            // Process work: use deterministic resumption (no Cortex loop)
            log('INFO', `Approved: resuming process plan for ${envelopeId}`);
            await resumeProcessPlan(envDoc);
          } else {
            // Non-process work: resume through Cortex decide loop (legacy)
            log('INFO', `Resuming checkpoint plan from CP${pausedCpIndex + 1} task ${pausedTaskIndex + 2}`);

            envDoc.status = 'active';
            envDoc.updated_at = now();
            // Clean up paused state
            delete envDoc.source_meta.paused_approval_id;
            delete envDoc.source_meta.paused_checkpoints;
            delete envDoc.source_meta.paused_checkpoint_index;
            delete envDoc.source_meta.paused_task_index;
            delete envDoc.source_meta.paused_all_results;
            await firestoreWrite('work', envelopeId, envDoc);

            // Resume processing the envelope through the normal Cortex loop
            const memory = await recallMemory(envDoc.instruction, {
              instruction: envDoc.instruction,
              context_summary: (envDoc.context_summary || '').substring(0, 500),
            });
            await processEnvelope(envDoc, memory);
          }
        }
      }
    } catch (e) {
      log('DEBUG', `Approval check error: ${e.message}`);
    }
  }

  /**
   * Start periodic polling for approved/rejected approvals.
   *
   * @param {number} intervalMs - Polling interval in milliseconds (default: 3000)
   */
  function startPolling(intervalMs = 3000) {
    if (_intervalId) return;
    _intervalId = setInterval(() => checkPending(), intervalMs);
  }

  /**
   * Stop the approval polling interval.
   */
  function stopPolling() {
    if (_intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  }

  return {
    /** Check for pending approved/rejected approvals (throttled: every 5th call). */
    checkPending,
    /** Start periodic polling. */
    startPolling,
    /** Stop periodic polling. */
    stopPolling,
  };
}
