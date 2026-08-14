// corekit/lib/approvals.mjs — Approval gate polling and resume handler
// Extracted from agent-brain.mjs Phase 2B
//
// Polls Firestore for approved/rejected approvals and resumes the corresponding
// paused envelopes by continuing their checkpoint plan (resumeCheckpointPlan), or
// fails the envelope on reject.
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
    resumeCheckpointPlan,
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
    agentEmail,
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
        // Root-collection runQuery is `<database>/documents:runQuery` with the
        // collection named in `from` — NOT `<database>/documents/approvals:runQuery`,
        // which addresses a DOCUMENT named "approvals" and returns HTTP 400. The
        // malformed URL made this poll 400 on every cycle (silently swallowed by the
        // `if (!resp.ok) continue`), so APPROVED missions never auto-resumed — they
        // lingered forever in awaiting_approval. `from: collectionId: 'approvals'`
        // (below) already names the collection; the URL must be the documents root.
        const queryUrl = `${FIRESTORE_BASE}:runQuery`;
        const resp = await fetch(queryUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: 'approvals' }],
              where: {
                compositeFilter: {
                  op: 'AND',
                  filters: [
                    {
                      fieldFilter: {
                        field: { fieldPath: 'prime_id' },
                        op: 'EQUAL',
                        value: { stringValue: primeId },
                      },
                    },
                    {
                      fieldFilter: {
                        field: { fieldPath: 'status' },
                        op: 'EQUAL',
                        value: { stringValue: targetStatus },
                      },
                    },
                  ],
                },
              },
              // Raised from 5: this equality query has NO orderBy, so Firestore
              // returns by __name__ ascending — a small window let OLDER approvals
              // (lower apr-<ts> ids) permanently starve a NEWER one out of view, so a
              // just-approved mission never resumed. _processed marking + owner-scope
              // keep the effective per-cycle work small.
              limit: 100,
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
          const apprOwner = fields.owner?.stringValue;

          if (!envelopeId || processed) continue;

          // ---- Owner scope ----
          // EVERY agent's brain runs this poller against the prime-wide `approvals`
          // collection. Resume only THIS agent's OWN missions — the owning agent's
          // poller resumes theirs. Skip a non-owned approval WITHOUT marking it
          // _processed, so the owner still picks it up. (Approval docs carry `owner`
          // since the approval-scope fix; older docs fall back to the envelope owner.)
          if (agentEmail && apprOwner && apprOwner !== agentEmail) continue;

          // Load the paused envelope
          const envDoc = await firestoreRead('work', envelopeId);

          // Fallback owner scope for pre-stamp approval docs (no `owner` field).
          if (agentEmail && envDoc && envDoc.owner && envDoc.owner !== agentEmail) continue;

          log('INFO', `Approval ${approvalId} ${targetStatus} — resuming envelope ${envelopeId}`);

          // Mark approval processed now that THIS agent owns the resume (avoids
          // re-processing on the next poll). Done after the owner check so a
          // non-owned approval is left for its owner.
          const approvalDocPath = row.document.name.split('/documents/')[1];
          await fetch(`${FIRESTORE_BASE}/${approvalDocPath}?updateMask.fieldPaths=_processed`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { _processed: { booleanValue: true } } }),
          }).catch(() => {});

          if (!envDoc || envDoc.status !== 'awaiting_approval') {
            log('WARN', `Approval ${approvalId}: envelope ${envelopeId} not in awaiting_approval state (${envDoc?.status})`);
            continue;
          }

          const meta = envDoc.source_meta || {};
          const pausedCheckpoints = meta.paused_checkpoints;
          const pausedCpIndex = meta.paused_checkpoint_index;
          const pausedTaskIndex = meta.paused_task_index;
          const pausedAllResults = meta.paused_all_results || [];

          const _hasPlan = pausedCheckpoints || (Array.isArray(envDoc._cp_spine) && envDoc._cp_spine.length);
          if (!_hasPlan || pausedCpIndex === undefined || pausedTaskIndex === undefined) {
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

          // Approved — resume execution. Every mission is a checkpoint_plan mission now
          // (the process step-machine was removed in the process-as-narrative migration).
          {
            // CONTINUE the checkpoint plan from the task AFTER the
            // approved gate — deterministically, via resumeCheckpointPlan — NOT the Cortex
            // decide loop. Re-deciding re-plans the gate's checkpoint and re-inserts the SAME
            // approval gate, so a checkpoint bundling a gate + its gated action ("obtain
            // approval" then "promote to prod") re-gates forever (observed: a prod-promote
            // looping iter 1->2->3, a fresh apr- each approve). resumeCheckpointPlan rebuilds
            // the plan (from paused_checkpoints, or the pinned spine when prestamped),
            // continues at CP=ci task=ti+1, and falls back to the decide loop if it cannot.
            log('INFO', `Approved: continuing checkpoint plan for ${envelopeId} at the task after the gate`);
            const memory = await recallMemory(envDoc.instruction, {
              instruction: envDoc.instruction,
              context_summary: (envDoc.context_summary || '').substring(0, 500),
            });
            if (typeof resumeCheckpointPlan === 'function') {
              await resumeCheckpointPlan(envDoc, memory);
            } else {
              // Legacy fallback (older brain without the post-gate continue) — re-enter loop.
              envDoc.status = 'active';
              envDoc.updated_at = now();
              delete envDoc.source_meta.paused_approval_id;
              delete envDoc.source_meta.paused_checkpoints;
              delete envDoc.source_meta.paused_checkpoint_index;
              delete envDoc.source_meta.paused_task_index;
              delete envDoc.source_meta.paused_all_results;
              await firestoreWrite('work', envelopeId, envDoc);
              await processEnvelope(envDoc, memory);
            }
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

/**
 * Pure scope filter for approval resolution (approval-leakage fix).
 *
 * Given the prime-wide set of PENDING approvals and the identity/context of the
 * agent resolving an "approve"/"reject" reply, return only the approvals that
 * agent may resolve: its OWN gates (by owner), refined to the SAME conversation
 * (space / project / channel) when that can be determined. This collapses the
 * cross-agent / cross-mission leak where one agent's "approve" pulled the whole
 * fleet's accumulated pending approvals into a disambiguation (or a bulk
 * "approve all").
 *
 * Semantics:
 *  - Owner scope is STRICT when identity is known: an approval owned by a
 *    different agent is dropped, and a legacy approval with no `owner` is dropped
 *    too — it is stale cross-mission residue (every new doc carries an owner
 *    once the stamping fix in checkpoint-executor ships).
 *  - Conversation refinement only NARROWS and never strands: the most specific
 *    discriminator that actually matches ≥1 of the agent's own approvals wins
 *    (space > project > channel); if none apply (e.g. docs predate the stamp),
 *    the owner-scoped set is returned unchanged.
 *  - With no known agent identity, do NOT over-filter (return the input) — a
 *    safety fallback so a mis-provisioned agent behaves exactly as before.
 *
 * Impure orphan hygiene (voiding approvals whose envelope is no longer
 * awaiting_approval) is intentionally NOT done here — it needs envelope reads
 * and lives in the caller. This function stays pure and unit-testable.
 *
 * @param {Array<object>} approvals - pending approval docs (may carry owner, source_space, project_id, source_channel)
 * @param {object} ctx
 * @param {string} [ctx.agentEmail] - the resolving agent's email (AGENT_EMAIL)
 * @param {string} [ctx.space]      - the conversation's space id, if known
 * @param {string} [ctx.projectId]  - the conversation's project id, if known
 * @param {string} [ctx.channel]    - the conversation's channel, if known
 * @returns {Array<object>} the subset this agent may resolve
 */
export function scopeApprovalsToAgent(approvals, ctx = {}) {
  if (!Array.isArray(approvals) || approvals.length === 0) return [];
  const { agentEmail, space, projectId, channel } = ctx;

  // 1) Owner scope (strict when identity is known).
  let scoped = agentEmail
    ? approvals.filter(a => a && a.owner === agentEmail)
    : approvals.slice();

  if (scoped.length <= 1) return scoped; // nothing left to refine

  // 2) Conversation refinement — narrow to the same conversation when we can,
  //    using the most specific discriminator that actually applies to MY set.
  //    A discriminator matching none of my approvals is skipped (never strand).
  const discriminators = [
    space     ? (a => a.source_space === space)       : null,
    projectId ? (a => a.project_id === projectId)     : null,
    channel   ? (a => a.source_channel === channel)   : null,
  ].filter(Boolean);

  for (const match of discriminators) {
    const narrowed = scoped.filter(match);
    if (narrowed.length > 0) { scoped = narrowed; break; }
  }

  return scoped;
}
