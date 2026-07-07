// corekit/lib/notifications.mjs — Notification summarization & delivery helpers
// Extracted from agent-brain.mjs Phase 3
//
// Handles type-specific notification summarization (LLM-assisted),
// quick ACK generation, status update delivery, and message extraction.
//
// All external state (Vertex AI, Firestore, gateway, identity) injected via deps.

/**
 * Type-specific summarization configs.
 * Some types route through LLM for distillation; others pass through raw.
 */
const SUMMARY_TYPES = {
  approval_request: {
    llm: true,
    maxChars: 1500,
    prompt: (ctx) => [
      `You are writing a concise approval request notification for a human reviewer.`,
      `Summarize the completed work into a clean, self-contained message.`,
      ``,
      `RULES:`,
      `- 3-8 sentences max, under ${ctx.maxChars || 1500} characters`,
      `- Include ALL relevant URLs, links, and artifact references inline`,
      `- The reader must NOT need any prior context — everything self-contained`,
      `- State what was done, what the outcome is, and what happens next if approved`,
      `- NEVER say "see above", "the link from earlier", or reference prior messages`,
      `- Do NOT include raw command output, JSON blobs, or deployment logs`,
      `- Do NOT include step numbers, agent names (motor, cerebellum), or internal jargon`,
      `- Use markdown for readability (bold for key items, links clickable)`,
      ``,
      ctx.processName ? `PROCESS: ${ctx.processName}` : '',
      ctx.title ? `APPROVAL TITLE: ${ctx.title}` : '',
      ctx.customMessage ? `CUSTOM CONTEXT: ${ctx.customMessage}` : '',
      ``,
      `COMPLETED STEPS:`,
      JSON.stringify(ctx.steps, null, 2),
    ].filter(Boolean).join('\n'),
  },
  completion: {
    llm: true,
    maxChars: 3000,
    prompt: (ctx) => [
      `You are writing the final delivery for a completed mission.`,
      ``,
      `DELIVERY CONTRACT (B-30 — Answer, then reasoning, then risk):`,
      `1. Lead with the answer in actionable form — the decision, number, or recommendation.`,
      `   The first line must be safe to act on alone, or carry its own warning in the same breath.`,
      `2. Then the compressed load-bearing chain a checker would need — audit trail, not proof of effort.`,
      `3. Then risk — what would change this answer, any labeled assumptions (verified/inferred/assumed),`,
      `   what to check before acting. Hedges are information: they live here, not smeared through the answer.`,
      ``,
      `RULES:`,
      `- Under ${ctx.maxChars || 3000} characters`,
      `- Do NOT reorder: answer → reasoning → risk. This order is a contract.`,
      `- Include ALL relevant URLs, links, and artifact references inline`,
      `- Self-contained — never reference prior messages`,
      `- No internal jargon (motor, cerebellum, checkpoint, envelope)`,
      `- Scale to stakes: one-line answer for a lookup, full treatment for anything signed`,
      ``,
      ctx.title ? `MISSION: ${ctx.title}` : '',
      ``,
      `RAW OUTPUT:`,
      ctx.rawText || '(empty)',
    ].filter(Boolean).join('\n'),
  },
  status_update: { llm: false },  // Pass through — already human-readable
  error_report: { llm: false },   // Pass through — errors should be precise
};

/** Generic ACK fallbacks when LLM generation fails */
const ACK_FALLBACKS = [
  '✅ Got it — working on this now.',
  '👍 On it!',
  '✅ Received — let me look into this.',
  '📛 Working on it.',
];

/**
 * Create a notifier instance.
 *
 * @param {object} deps
 * @param {object} deps.vertexText           - vertex-text.mjs client instance (has .transform())
 * @param {function} deps.firestoreWrite     - async (collection, docId, data) => result
 * @param {function} deps.firestoreRead      - async (collection, docId) => doc or null
 * @param {function} deps.addressFromMeta    - (sourceMeta, sourceChannel) => Address object
 * @param {function} deps.logger             - (level, msg) logging function
 * @param {function} deps.generateId         - (prefix) => unique ID
 * @param {function} deps.cachedReadFile     - (path) => file content or null
 * @param {function} deps.getGatewayConfig   - () => { url, token, route }
 * @param {function} deps.getProjects        - () => projects map (live reference)
 * @param {object}   deps.config
 * @param {string}   deps.config.primeId     - e.g. 'chucknorris'
 * @param {string}   deps.config.agentId     - e.g. 'stan'
 * @param {string}   deps.config.agentEmail  - e.g. 'devops-agent-stan@example.com'
 * @param {string}   deps.config.coreDir     - e.g. '/opt/corekit'
 * @returns {object} Notifier API
 */
export function createNotifier(deps) {
  const {
    vertexText,
    firestoreWrite,
    firestoreRead,
    addressFromMeta,
    generateId,
    cachedReadFile,
    getGatewayConfig,
    getProjects,
    config,
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[notifications] ${level}: ${msg}`));
  const { agentId, agentEmail, coreDir } = config;

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  // =========================================================================
  //  Delivery summarization
  // =========================================================================

  /**
   * Summarize raw notification data for delivery.
   * Type-specific: some types use LLM distillation, others pass through.
   *
   * @param {string} type     - Summary type key (e.g. 'approval_request')
   * @param {string} rawText  - Fallback text if LLM is skipped or fails
   * @param {object} [context={}] - Type-specific context (steps, title, processName, etc.)
   * @returns {Promise<string>} Clean, delivery-ready text
   */
  async function summarizeForDelivery(type, rawText, context = {}) {
    const typeConfig = SUMMARY_TYPES[type];
    if (!typeConfig || !typeConfig.llm) {
      // No LLM needed — return raw text as-is
      return rawText;
    }

    const maxChars = typeConfig.maxChars || 1500;
    const promptText = typeConfig.prompt({ ...context, maxChars });

    try {
      const instruction = 'You are a notification writer. Return ONLY the notification text — no JSON, no markdown fences, no preamble.';
      const content = await vertexText.transform(promptText, instruction, { maxTokens: 2048 });

      if (content && content.length > 0) {
        // Strip any markdown fences or JSON wrapping the LLM might add
        const cleaned = content.replace(/^```[a-z]*\s*/gi, '').replace(/\s*```$/g, '').trim();
        log('INFO', `summarizeForDelivery(${type}): ${cleaned.length} chars (from ${JSON.stringify(context.steps || []).length} chars raw)`);
        return cleaned.substring(0, maxChars);
      }

      log('WARN', `summarizeForDelivery(${type}): empty response — falling back to raw`);
      return rawText;
    } catch (e) {
      log('WARN', `summarizeForDelivery(${type}) error: ${e.message} — falling back to raw`);
      return rawText;
    }
  }

  // =========================================================================
  //  Message extraction
  // =========================================================================

  /**
   * Extract the current user message from a composite intake string.
   * Ears format: "[Chat messages since...]\\ncontext...\\n[Current message - respond to this]\\nUser: actual message"
   *
   * @param {string} intakeText - Raw composite intake text
   * @returns {string} The current message portion
   */
  function extractCurrentMessage(intakeText) {
    if (!intakeText) return intakeText || '';
    const marker = '[Current message - respond to this]';
    const idx = intakeText.indexOf(marker);
    if (idx !== -1) {
      return intakeText.substring(idx + marker.length).trim();
    }
    return intakeText;
  }

  // =========================================================================
  //  Status updates
  // =========================================================================

  /**
   * Write a transient status update envelope for Mouth to pick up and deliver.
   *
   * @param {string} envelopeId - Parent envelope ID
   * @param {string} message    - Human-readable status message
   */
  async function writeStatusUpdate(envelopeId, message) {
    // Read parent envelope to get routing info for delivery
    let parentMeta = {};
    let parentChannel = 'system';
    let deliveryAddr = null;
    try {
      const parent = firestoreRead ? await firestoreRead('work', envelopeId) : null;
      if (parent) {
        parentMeta = parent.source_meta || {};
        parentChannel = parent.source_channel || 'system';
        if (addressFromMeta) {
          deliveryAddr = addressFromMeta(parentMeta, parentChannel);
        }
      }
    } catch (e) {
      log('WARN', `writeStatusUpdate: failed to read parent ${envelopeId}: ${e.message}`);
    }

    const statusId = generateId('status');
    await firestoreWrite('work', statusId, {
      id: statusId,
      type: 'T',
      parent_id: envelopeId,
      owner: agentEmail || agentId,
      status: 'complete',
      intent: 'notification',
      instruction: 'Status update',
      output: message,
      delivery_status: 'pending',
      delivery_address: deliveryAddr,
      source_channel: parentChannel,
      source_meta: parentMeta,
      created_at: now(),
      started_at: now(),
      completed_at: now(),
      updated_at: now(),
      children: [],
      accept_criteria: null,
      context_summary: null,
      context_forward: null,
      error: null,
      iteration: 0,
    });
    log('INFO', `Status update written: ${statusId} — ${message.substring(0, 80)}`);
  }

  // =========================================================================
  //  Quick ACK generation
  // =========================================================================

  /**
   * Generate a brief, personality-aware acknowledgment for incoming work.
   * Falls back to a random generic ACK on failure.
   *
   * @param {string} intakeText       - Raw intake text
   * @param {Array}  activeEnvelopes  - Currently active/blocked envelope summaries
   * @param {Array}  [recentMissions] - Recently completed mission summaries
   * @returns {Promise<string>} Short ACK message (1 sentence, max ~200 chars)
   */
  async function generateAck(intakeText, activeEnvelopes, recentMissions = []) {
    try {
      // Read a personality snippet from IDENTITY.md (first 500 chars)
      const identityPaths = [
        coreDir + `/workspace-${agentId}/IDENTITY.md`,
        coreDir + '/workspace/IDENTITY.md',
      ];
      let identity = '';
      for (const p of identityPaths) {
        const content = cachedReadFile(p);
        if (content) { identity = content.substring(0, 500); break; }
      }

      // Build work context from active/blocked missions
      let workContext = '';
      if (activeEnvelopes && activeEnvelopes.length > 0) {
        const summaries = activeEnvelopes.map(e =>
          `${e.status === 'blocked' ? '🚫 BLOCKED' : '🔵 ACTIVE'}: "${(e.instruction || '').substring(0, 80)}"`
        ).join('\n');
        workContext = `\nYour current work:\n${summaries}`;
      }

      // Build recent mission context
      let recentContext = '';
      if (recentMissions.length > 0) {
        const summaries = recentMissions.map(m =>
          `• "${m.instruction}" → ${m.status}${m.project_id ? ` [${m.project_id}]` : ''}`
        ).join('\n');
        recentContext = `\nYour recent work:\n${summaries}`;
      }

      // Build project context
      let projectContext = '';
      const PROJECTS = getProjects();
      if (Object.keys(PROJECTS).length > 0) {
        const projectNames = Object.values(PROJECTS)
          .map(p => `• ${p.name || p.id}: ${(p.description || '').substring(0, 80)}`)
          .join('\n');
        projectContext = `\nProjects you work on:\n${projectNames}`;
      }

      // Extract the actual current message from the composite intake
      const ackMessage = extractCurrentMessage(intakeText);

      const systemPrompt = [
        `You are a team member acknowledging an incoming message. Write a BRIEF (1 sentence, max 20 words) acknowledgment. Be natural, warm, and varied — never robotic. Reference what the person asked about if you can.`,
        workContext,
        recentContext,
        projectContext,
        `\nIMPORTANT: If the user's message relates to your recent or current work, acknowledge the CONTINUITY — say something like "Picking back up on the sync pipeline" or "Taking another look at this." Don't treat it as brand new if you recognize it from recent history.`,
        `\nYour personality:\n${identity || 'Helpful and professional.'}`,
      ].filter(Boolean).join('\n');

      const { url: gatewayUrl, token: gatewayToken, route: brainRoute } = getGatewayConfig();

      const resp = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gatewayToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: brainRoute,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `[BRAIN-ORCHESTRATED]\nAcknowledge this message briefly:\n"${ackMessage.substring(0, 300)}"` },
          ],
          max_tokens: 60,
          temperature: 0.9,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content && content.length > 2 && content.length < 200) {
          return content;
        }
      }
    } catch (e) {
      log('DEBUG', `ACK generation failed (using fallback): ${e.message}`);
    }
    // Fallback: random generic ack
    return ACK_FALLBACKS[Math.floor(Math.random() * ACK_FALLBACKS.length)];
  }

  return {
    /** Summarize notification data for delivery (type-specific LLM distillation). */
    summarizeForDelivery,
    /** Extract current message from composite intake text. */
    extractCurrentMessage,
    /** Write a transient status update envelope. */
    writeStatusUpdate,
    /** Generate a brief, personality-aware ACK. */
    generateAck,
  };
}
