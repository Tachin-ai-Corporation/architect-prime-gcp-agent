// corekit/lib/archival.mjs — Periodic envelope archival sweeper
// Extracted from agent-brain.mjs Phase 2C
//
// Archives old completed/failed/cancelled/timed_out envelopes and
// cancels orphaned children whose parents are gone. Runs on a
// configurable interval (default: 1h).
//
// All Firestore access uses injected wrappers — no raw REST globals.

/**
 * Create an archival sweeper instance.
 *
 * @param {object} deps
 * @param {function} deps.logger               - (level, msg) logging function
 * @param {object}   deps.config
 * @param {string}   deps.config.primeId       - e.g. 'chuck'
 * @param {number}   [deps.config.staleCleanupHours=24]       - Hours before failed/complete/cancelled are eligible
 * @param {number}   [deps.config.archiveAgeDays=7]            - Days before force-archiving without memory_written
 * @param {number}   [deps.config.needsInputTimeoutHours=72]  - Hours before stale needs_input are archived
 * @param {function} deps.firestoreWrite       - async (collection, docId, data) => result
 * @param {function} deps.firestoreRead        - async (collection, docId) => data
 * @param {function} deps.firestoreQuery       - async (collection, filters) => results[]
 * @returns {object} Archival sweeper API
 */
export function createArchivalSweeper(deps) {
  const {
    config,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[archival] ${level}: ${msg}`));

  const {
    staleCleanupHours = 24,
    archiveAgeDays = 7,
    needsInputTimeoutHours = 72,
    blockedTimeoutHours = 6,
    waitingTimeoutHours = 8,
    activeTimeoutHours = 12,
  } = config;

  // ---- Internal state ----
  let _intervalId = null;

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  /**
   * Run a single archival sweep.
   *
   * Archives:
   *  1. Failed envelopes older than staleCleanupHours
   *  2. Complete envelopes: children immediately, top-level after staleCleanupHours
   *     (respects delivery_status and memory_written flags)
   *  3. Stale needs_input envelopes older than needsInputTimeoutHours
   *  4. Cancelled envelopes older than staleCleanupHours
   *  5. Timed-out envelopes (always terminal — archive immediately)
   *  6. Orphaned active/pending children whose parents are cancelled/archived/failed
   *
   * NOTE: Blocked and queued envelopes are NEVER archived — they persist for resumption/processing.
   *
   * @returns {Promise<number>} Total number of envelopes archived
   */
  async function sweep() {
    log('INFO', 'Running envelope archival sweep...');
    let totalArchived = 0;
    try {
      // 1. Failed envelopes older than staleCleanupHours
      const failedCutoff = new Date(Date.now() - staleCleanupHours * 60 * 60 * 1000).toISOString();
      const failed = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'failed' } },
      ]);
      let failedCount = 0;
      for (const env of failed) {
        if (env.created_at && env.created_at < failedCutoff) {
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'stale_failed', delivery_status: 'delivered', updated_at: now() });
          failedCount++;
        }
      }
      if (failedCount) log('INFO', `Archived ${failedCount} failed envelopes (>${staleCleanupHours}h old)`);

      // 2. Complete envelopes: archive children immediately, top-level after staleCleanupHours
      const completeCutoff = new Date(Date.now() - staleCleanupHours * 60 * 60 * 1000).toISOString();
      const forceArchiveCutoff = new Date(Date.now() - archiveAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const complete = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'complete' } },
      ]);
      let completeCount = 0;
      for (const env of complete) {
        // Envelopes awaiting delivery MUST NOT be archived yet, regardless of parent_id
        if (env.delivery_status === 'pending') {
          continue;
        }

        // Child envelopes (have parent_id) never need delivery (unless explicitly pending, handled above) — archive immediately
        if (env.parent_id) {
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'child_complete', delivery_status: 'delivered', updated_at: now() });
          completeCount++;
          continue;
        }

        const envAge = env.completed_at || env.updated_at || env.created_at;
        if (envAge && envAge < completeCutoff) {
          if (env.memory_written) {
            // Memory confirmed written — safe to archive
            await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'delivered', delivery_status: 'delivered', updated_at: now() });
            completeCount++;
          } else if (envAge < forceArchiveCutoff) {
            // Force-archive very old envelopes even without memory flag (safety fallback)
            log('WARN', `Force-archiving envelope without memory_written: ${env.id} (age > ${archiveAgeDays}d)`);
            await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'delivered_no_memory', delivery_status: 'delivered', updated_at: now() });
            completeCount++;
          }
        }
      }
      if (completeCount) log('INFO', `Archived ${completeCount} complete envelopes (children + >${staleCleanupHours}h old)`);

      // 3. Stale needs_input envelopes older than needsInputTimeoutHours
      const needsInputCutoff = new Date(Date.now() - needsInputTimeoutHours * 60 * 60 * 1000).toISOString();
      const needsInput = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'needs_input' } },
      ]);
      let needsInputCount = 0;
      for (const env of needsInput) {
        if (env.updated_at && env.updated_at < needsInputCutoff) {
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'unanswered', delivery_status: 'delivered', updated_at: now() });
          needsInputCount++;
          log('WARN', `Archived unanswered needs_input envelope: ${env.id} (last updated ${env.updated_at})`);
        }
      }

      // 4. Cancelled envelopes older than staleCleanupHours
      const cancelled = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'cancelled' } },
      ]);
      let cancelledCount = 0;
      for (const env of cancelled) {
        if (env.cancelled_at && env.cancelled_at < failedCutoff) {
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'cancelled', delivery_status: 'delivered', updated_at: now() });
          cancelledCount++;
        }
      }
      if (cancelledCount) log('INFO', `Archived ${cancelledCount} cancelled envelopes (>${staleCleanupHours}h old)`);

      // 5. Timed-out envelopes — always children, archive immediately (they are terminal)
      const timedOut = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'timed_out' } },
      ]);
      let timedOutCount = 0;
      for (const env of timedOut) {
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'timed_out', delivery_status: 'delivered', updated_at: now() });
        timedOutCount++;
      }
      if (timedOutCount) log('INFO', `Archived ${timedOutCount} timed_out envelopes`);

      // 5b. Stale blocked envelopes — cancel after blockedTimeoutHours
      // Fleet agents create blocked delegations that will never be manually resumed.
      // Cancel (not archive) so orphan cleanup cascades to their children.
      const blockedCutoff = new Date(Date.now() - blockedTimeoutHours * 60 * 60 * 1000).toISOString();
      const blocked = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'blocked' } },
      ]);
      let blockedCount = 0;
      for (const env of blocked) {
        const envAge = env.updated_at || env.created_at;
        if (envAge && envAge < blockedCutoff) {
          await firestoreWrite('work', env.id, {
            ...env,
            status: 'cancelled',
            cancelled_at: now(),
            cancelled_reason: `Stale blocked >${blockedTimeoutHours}h`,
            updated_at: now(),
            completed_at: now(),
          });
          blockedCount++;
        }
      }
      if (blockedCount) log('INFO', `Cancelled ${blockedCount} stale blocked envelopes (>${blockedTimeoutHours}h old)`);

      // 5c. Stale waiting envelopes — cancel after waitingTimeoutHours
      // Waiting envelopes whose children are stuck create cascading deadlocks.
      const waitingCutoff = new Date(Date.now() - waitingTimeoutHours * 60 * 60 * 1000).toISOString();
      const waiting = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'waiting' } },
      ]);
      let waitingCount = 0;
      for (const env of waiting) {
        const envAge = env.updated_at || env.created_at;
        if (envAge && envAge < waitingCutoff) {
          await firestoreWrite('work', env.id, {
            ...env,
            status: 'cancelled',
            cancelled_at: now(),
            cancelled_reason: `Stale waiting >${waitingTimeoutHours}h`,
            updated_at: now(),
            completed_at: now(),
          });
          waitingCount++;
        }
      }
      if (waitingCount) log('INFO', `Cancelled ${waitingCount} stale waiting envelopes (>${waitingTimeoutHours}h old)`);

      // 5d. Stale active envelopes — cancel broken-owner or very old active envelopes
      const activeCutoff = new Date(Date.now() - activeTimeoutHours * 60 * 60 * 1000).toISOString();
      const activeAll = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'active' } },
      ]);
      let staleActiveCount = 0;
      for (const env of activeAll) {
        // Cancel immediately if owner is an unrendered template placeholder
        const isBrokenOwner = env.owner && env.owner.includes('${');
        const envAge = env.updated_at || env.created_at;
        const isStale = envAge && envAge < activeCutoff;
        if (isBrokenOwner || isStale) {
          const reason = isBrokenOwner
            ? `Broken owner: ${env.owner}`
            : `Stale active >${activeTimeoutHours}h`;
          await firestoreWrite('work', env.id, {
            ...env,
            status: 'cancelled',
            cancelled_at: now(),
            cancelled_reason: reason,
            updated_at: now(),
            completed_at: now(),
          });
          staleActiveCount++;
        }
      }
      if (staleActiveCount) log('INFO', `Cancelled ${staleActiveCount} stale/broken active envelopes`);

      // 6. Orphaned children — active/pending/queued C/T whose parent is cancelled/archived
      // Also include blocked and waiting children — if their parent is terminal, they should be too.
      const allNonTerminal = [
        ...activeAll.filter(e => e.parent_id), // Re-use active query, filter to children only
      ];
      // Fetch remaining non-terminal statuses for orphan check
      const pendingChildren = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
      ]);
      const queuedChildren = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'queued' } },
      ]);
      let orphanCount = 0;
      for (const env of [...allNonTerminal, ...pendingChildren, ...queuedChildren, ...blocked.filter(e => e.parent_id), ...waiting.filter(e => e.parent_id)]) {
        if (!env.parent_id) continue; // Only check children
        // Skip if already cancelled in a previous step this sweep
        if (env.status === 'cancelled') continue;
        const parent = await firestoreRead('work', env.parent_id);
        if (!parent || ['cancelled', 'archived', 'failed'].includes(parent.status)) {
          await firestoreWrite('work', env.id, {
            ...env,
            status: 'cancelled',
            cancelled_at: now(),
            cancelled_reason: parent ? `Parent ${env.parent_id} is ${parent.status}` : `Parent ${env.parent_id} not found`,
            updated_at: now(),
            completed_at: now(),
          });
          orphanCount++;
        }
      }
      if (orphanCount) log('INFO', `Cancelled ${orphanCount} orphaned children (parent cancelled/archived/missing)`);

      totalArchived = failedCount + completeCount + needsInputCount + cancelledCount + timedOutCount;
      const totalCancelled = blockedCount + waitingCount + staleActiveCount + orphanCount;
      log('INFO', `Archival sweep complete: ${totalArchived} archived, ${totalCancelled} cancelled (${failedCount} failed, ${completeCount} complete, ${needsInputCount} unanswered, ${cancelledCount} cancelled, ${timedOutCount} timed_out, ${blockedCount} blocked, ${waitingCount} waiting, ${staleActiveCount} stale_active, ${orphanCount} orphans)`);
    } catch (e) {
      log('WARN', `Archival sweep error: ${e.message}`);
    }
    return totalArchived;
  }

  /**
   * Start a periodic archival schedule.
   *
   * @param {number} intervalMs - Interval between sweeps in milliseconds (default: 3600000 = 1h)
   */
  function startSchedule(intervalMs = 3600000) {
    if (_intervalId) return;
    _intervalId = setInterval(() => sweep(), intervalMs);
    log('INFO', `Archival sweep scheduled every ${Math.round(intervalMs / 3600000)}h`);
  }

  /**
   * Stop the periodic archival schedule.
   */
  function stopSchedule() {
    if (_intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  }

  return {
    /** Run a single archival sweep. */
    sweep,
    /** Start periodic archival sweeps. */
    startSchedule,
    /** Stop periodic archival sweeps. */
    stopSchedule,
  };
}
