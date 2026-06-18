// ============================================================
// envelope-lifecycle.mjs — Unified completion/blocking ceremony
//
// Every terminal state transition for an envelope goes through
// completeEnvelope(). Ensures consistent execution of:
//   write → history → publish → memory → cleanup →
//   dependents → project → events → delegation → promotion
//
// Phase 2.1 extraction from agent-brain.mjs.
// ============================================================

/**
 * Create a lifecycle handler bound to the given dependencies.
 *
 * @param {object} deps
 * @param {Function} deps.firestoreWrite
 * @param {Function} deps.writeHistory
 * @param {Function} deps.publishArtifacts
 * @param {Function} deps.writeMemory
 * @param {Function} deps.cleanupSharedWorkspace
 * @param {Function} deps.activateDependents
 * @param {Function} deps.checkProjectCompletion
 * @param {Function} deps.fireEventResponsibilities
 * @param {Function} deps.suggestContextPromotions
 * @param {Function} deps.addressFromMeta
 * @param {Function} deps.generateId
 * @param {Function} deps.composeDelegationResultMarker
 * @param {Function} deps.makeAddress
 * @param {Function} deps.toStr
 * @param {Function} deps.now
 * @param {Function} deps.log
 * @param {string}   deps.agentEmail
 * @param {string}   deps.agentId
 * @param {object}   deps.projects  - PROJECTS registry cache
 */
export function createLifecycleHandler(deps) {
  const {
    firestoreWrite, writeHistory, publishArtifacts, writeMemory,
    cleanupSharedWorkspace, activateDependents, checkProjectCompletion,
    fireEventResponsibilities, suggestContextPromotions,
    addressFromMeta, generateId, composeDelegationResultMarker,
    makeAddress, toStr, now, log,
    agentEmail, agentId, projects,
  } = deps;

  /**
   * Execute the full completion/blocking ceremony for an envelope.
   *
   * @param {object} envelope - The envelope to complete/block
   * @param {object} opts
   * @param {'complete'|'blocked'|'needs_input'|'failed'} opts.status
   * @param {string} opts.output - Output text/synthesis
   * @param {string} [opts.historyDetail] - Detail string for writeHistory
   * @param {string} [opts.blocker] - Blocker description (blocked only)
   * @param {string} [opts.blockerType] - Blocker type (blocked only)
   * @param {'on_complete'|'on_failure'} [opts.eventType='on_complete']
   * @param {boolean} [opts.skipArtifacts=false] - Skip artifact publishing
   * @param {boolean} [opts.skipMemory=false] - Skip memory write
   * @param {boolean} [opts.skipCleanup=false] - Skip workspace cleanup
   */
  async function completeEnvelope(envelope, opts) {
    const {
      status,
      output,
      historyDetail,
      blocker = null,
      blockerType = null,
      eventType = status === 'blocked' ? 'on_failure' : 'on_complete',
      skipArtifacts = false,
      skipMemory = false,
      skipCleanup = false,
    } = opts;

    if (envelope.type === 'M' && envelope.parent_id) {
      log('ERROR', `Invariant violation: M-type envelope ${envelope.id} has parent_id ${envelope.parent_id}. Correcting to type C.`);
      envelope.type = 'C';
      envelope.delivery_status = 'internal';
    }

    // ---- Step 1: Set envelope fields ----
    envelope.output = output;
    envelope.status = status;
    envelope.updated_at = now();

    if (status === 'complete') {
      envelope.completed_at = now();
    } else if (status === 'blocked') {
      envelope.blocker = blocker || 'Unknown blocker';
      envelope.blocker_type = blockerType || 'other';
      envelope.blocked_at = now();
    }

    // ---- Step 2: Set delivery ----
    if (!envelope.parent_id) {
      envelope.delivery_status = 'pending';
      envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
    }

    // ---- Step 3: Publish artifacts (before cleanup, so shared/ files exist) ----
    if (!skipArtifacts && envelope.type === 'M') {
      try {
        const artifactLinks = await publishArtifacts(envelope);
        if (artifactLinks && artifactLinks.length > 0) {
          const linkText = artifactLinks.map(a => `- [${a.name}](${a.url})`).join('\n');
          envelope.output = (envelope.output || '') + `\n\n📌 **Artifacts published to Drive:**\n${linkText}`;
        }
      } catch (e) {
        log('WARN', `Artifact publishing failed: ${e.message}`);
      }
    }

    // ---- Step 4: Write to Firestore ----
    await firestoreWrite('work', envelope.id, envelope);
    await writeHistory(
      envelope.id, 'active', status, 'brain',
      historyDetail || `${status}: ${toStr(output).substring(0, 200)}`
    );
    log('INFO', `Envelope ${envelope.id} ${status} (${historyDetail || ''})`);

    // ---- Step 5: Memory + cleanup ----
    if (!skipMemory) {
      try { await writeMemory(envelope); } catch (e) {
        log('WARN', `Memory write failed: ${e.message}`);
      }
    }
    if (!skipCleanup) {
      try { await cleanupSharedWorkspace(envelope.id); } catch (e) {
        log('WARN', `Workspace cleanup failed: ${e.message}`);
      }
    }

    // ---- Step 6: Mission-only post-completion ----
    if (envelope.type === 'M') {
      // Activate dependent missions
      try { await activateDependents(envelope.id); } catch (e) {
        log('WARN', `activateDependents failed: ${e.message}`);
      }

      // Check project completion
      if (envelope.project_id) {
        try { await checkProjectCompletion(envelope.project_id); } catch (e) {
          log('WARN', `checkProjectCompletion failed: ${e.message}`);
        }
      }

      // Fire event responsibilities
      try {
        await fireEventResponsibilities(eventType, {
          mission_id: envelope.id,
          project_id: envelope.project_id,
        });
      } catch (e) {
        log('WARN', `fireEventResponsibilities failed: ${e.message}`);
      }

      // Delegation result reply
      if (status === 'complete' && envelope.source_meta?.delegation_ref) {
        try {
          const resultMarker = composeDelegationResultMarker({
            targetEmail: envelope.source_meta.delegated_from || '',
            ref: envelope.source_meta.delegation_ref,
            status: envelope.status,
            missionId: envelope.id,
            body: toStr(envelope.output).substring(0, 500),
          });
          const resultOutputId = generateId('w');
          await firestoreWrite('work', resultOutputId, {
            id: resultOutputId,
            type: 'T',
            parent_id: envelope.id,
            owner: agentEmail || agentId,
            status: 'complete',
            intent: 'delegation_result',
            title: `Delegation result for ${envelope.source_meta.delegation_ref}`,
            instruction: 'Deliver delegation result marker',
            output: resultMarker,
            delivery_status: 'pending',
            delivery_target: envelope.source_meta.delegated_from || null,
            delivery_space_id: (envelope.project_id && projects[envelope.project_id]?.gchat_space_id) || null,
            delivery_address: makeAddress('gchat', {
              space: (envelope.project_id && projects[envelope.project_id]?.gchat_space_id)
                ? `spaces/${projects[envelope.project_id].gchat_space_id}`
                : null,
            }),
            project_id: envelope.project_id || null,
            source_channel: 'brain',
            source_meta: { delegation_ref: envelope.source_meta.delegation_ref },
            created_at: now(),
            updated_at: now(),
          });
          log('INFO', `Delegation result envelope created: ${resultOutputId} for ref ${envelope.source_meta.delegation_ref}`);
        } catch (e) {
          log('WARN', `Failed to create delegation result envelope: ${e.message}`);
        }
      }

      // Context promotion
      if (envelope.project_id && envelope.context) {
        try { await suggestContextPromotions(envelope); } catch (e) {
          log('WARN', `suggestContextPromotions failed: ${e.message}`);
        }
      }
    }
  }

  return { completeEnvelope };
}
