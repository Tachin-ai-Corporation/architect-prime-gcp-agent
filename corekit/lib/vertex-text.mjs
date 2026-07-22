// corekit/lib/vertex-text.mjs — Vertex AI text utility layer
// Extracted from agent-brain.mjs Phase 0D
// Used by brain (agent-brain.mjs) and temporal organs
//
// Provides LLM-powered text summarization, title generation, and schema
// enforcement via direct Vertex AI calls (no gateway, no agent routing).

// Shared corekit libraries
import { getGceToken } from './gce-auth.mjs';
import { parseJsonResponse } from './json-repair.mjs';

// ---- Schema definitions for Cortex output enforcement ----

/** @type {Record<string, object>} */
export const CORTEX_SCHEMAS = {
  classify: {
    type: 'OBJECT',
    properties: {
      classification: { type: 'STRING', enum: ['new_mission', 'attach', 'continue', 'cancel', 'respond'] },
      response:       { type: 'STRING' },
      instruction:    { type: 'STRING' },
      intent:         { type: 'STRING' },
      reasoning:      { type: 'STRING' },
      attach_to:      { type: 'STRING' },
      continue_mission: { type: 'STRING' },
      continue_envelope: { type: 'STRING' },
      accept_criteria:{ type: 'STRING' },
      context_summary:{ type: 'STRING' },
      project_id:     { type: 'STRING' },
      process_id:     { type: 'STRING' },
      job_to_be_done: { type: 'STRING' },
      stakes: { type: 'STRING', enum: ['routine', 'consequential', 'irreversible'] },
      reads:  { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['classification', 'reasoning'],
  },
  analyze: {
    type: 'OBJECT',
    properties: {
      objective:     { type: 'STRING' },
      parts: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        id:          { type: 'STRING' },
        summary:     { type: 'STRING' },
        ownership:   { type: 'STRING', enum: ['local', 'teammate'] },
        specialty:   { type: 'STRING' },
        risk:        { type: 'STRING', enum: ['none', 'mutating', 'destructive_or_public'] },
        depends_on:  { type: 'ARRAY', items: { type: 'STRING' } },
        unknowns:    { type: 'ARRAY', items: { type: 'STRING' } },
        check:        { type: 'STRING' },
        assumes:      { type: 'ARRAY', items: { type: 'STRING' } },
        load_bearing: { type: 'BOOLEAN' },
      }, required: ['id', 'summary', 'ownership', 'risk'] }},
      process_match: { type: 'STRING' },
      kill_shot:    { type: 'STRING' },
      premise:      { type: 'STRING', enum: ['sound', 'flawed'] },
      premise_note: { type: 'STRING' },
    },
    required: ['objective', 'parts'],
  },
  decide: {
    type: 'OBJECT',
    properties: {
      action:     { type: 'STRING', enum: [
        'checkpoint_plan', 'synthesize', 'synthesize_with_failure',
        'needs_input', 'blocked', 'follow_process', 'status_update',
        'delegate', 'wait',
      ]},
      reasoning:  { type: 'STRING' },
      checkpoints: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        instruction:     { type: 'STRING' },
        accept_criteria: { type: 'STRING' },
        tasks: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
          agent:           { type: 'STRING' },
          task:            { type: 'STRING' },
          accept_criteria: { type: 'STRING' },
          step_type:       { type: 'STRING', enum: ['standard', 'delegation', 'approval_gate', 'ask'] },
          brief_part:      { type: 'STRING' },
        }, required: ['agent', 'task'] }},
      }, required: ['instruction', 'accept_criteria', 'tasks'] }},
      synthesis:       { type: 'STRING' },
      failure_summary: { type: 'STRING' },
      question:        { type: 'STRING' },
      what_is_needed:  { type: 'STRING' },
      blocker:            { type: 'STRING' },
      blocker_type:       { type: 'STRING' },
      minutes:         { type: 'NUMBER' },
      reason:          { type: 'STRING' },
      then:            { type: 'STRING' },
      escalation_message: { type: 'STRING' },
      processId:  { type: 'STRING' },
      parameters: { type: 'OBJECT' },
      message: { type: 'STRING' },
      target_email:    { type: 'STRING' },
      instruction:     { type: 'STRING' },
      accept_criteria: { type: 'STRING' },
      goal_check: { type: 'OBJECT', properties: {
        criteria_met: { type: 'ARRAY', items: { type: 'STRING' } },
        criteria_unmet: { type: 'ARRAY', items: { type: 'STRING' } },
        confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        assessment: { type: 'STRING' },
      }},
      project_id:      { type: 'STRING' },
      answer: { type: 'STRING' },
      risk:   { type: 'STRING' },
      assumptions: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        claim:  { type: 'STRING' },
        status: { type: 'STRING', enum: ['verified', 'inferred', 'assumed'] },
        note:   { type: 'STRING' },
      }, required: ['claim', 'status'] }},
      // ORGAN_CONTEXT_SHARING_PLAN Phase 2: names one or more result `ref`s whose full
      // content you need before you can decide. The daemon fetches them and returns them in
      // the next turn; your action this turn is deferred. Use only when a result's summary
      // is genuinely insufficient — never to re-observe work you can already read.
      request_context: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['action'],
  },
  plan: {
    type: 'OBJECT',
    properties: {
      checkpoints: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            instruction:     { type: 'STRING' },
            accept_criteria: { type: 'STRING' },
            tasks: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  agent:           { type: 'STRING' },
                  task:            { type: 'STRING' },
                  accept_criteria: { type: 'STRING' },
                  step_type:       { type: 'STRING', enum: ['standard', 'delegation', 'approval_gate', 'ask'] },
                  brief_part:      { type: 'STRING' },
                },
                required: ['agent', 'task']
              }
            }
          },
          required: ['instruction', 'accept_criteria', 'tasks']
        }
      }
    },
    required: ['checkpoints']
  },
  respond_compose: {
    type: 'OBJECT',
    properties: {
      reasoning: { type: 'STRING' },
      response:  { type: 'STRING' },
    },
    required: ['reasoning', 'response'],
  }
};

// ---- Pure helpers ----

/**
 * Truncate text using head/tail strategy, preserving context from both ends.
 * Pure function — no LLM call.
 *
 * @param {string} text - Text to truncate
 * @param {number} budget - Maximum character budget
 * @returns {string} Truncated text with indicator showing how much was cut
 */
export function smartTruncate(text, budget) {
  if (!text || text.length <= budget) return text;
  const headBudget = Math.floor(budget * 0.4);
  const tailBudget = Math.floor(budget * 0.4);
  const head = text.substring(0, headBudget);
  const tail = text.substring(text.length - tailBudget);
  const truncated = text.length - headBudget - tailBudget;
  return `${head}\n[...${truncated} chars truncated...]\n${tail}`;
}

/**
 * Generate a human-readable title from instruction text.
 * Takes the first sentence (up to maxLen chars), trimming at word boundaries.
 * Pure function — no LLM call. Used as heuristic fallback when LLM title
 * generation fails.
 *
 * @param {string} text - Source text to derive a title from
 * @param {number} [maxLen=80] - Maximum title length
 * @returns {string} Generated title
 */
export function summarizeTitle(text, maxLen = 80) {
  if (!text) return 'Untitled';
  let cleaned = text
    .replace(/^\[Current message[^\]]*\]\s*/i, '')
    .replace(/^\[Chat messages since[^\]]*\]\s*/i, '')
    .replace(/^\[Previous context[^\]]*\]\s*/i, '')
    .replace(/^(User|Someone|Human):\s*/i, '')
    .trim();
  cleaned = cleaned.replace(/^```[^\n]*\n?/, '').trim();
  const firstSentence = cleaned.split(/[.\n!?]/)[0].trim();
  if (!firstSentence) return cleaned.substring(0, maxLen);
  if (firstSentence.length <= maxLen) return firstSentence;
  const truncated = firstSentence.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.substring(0, lastSpace) : truncated) + '…';
}

// ---- Client factory ----

/**
 * Create a Vertex AI text utility client.
 *
 * @param {object} config
 * @param {string} config.projectId - GCP project ID
 * @param {string} config.location - Vertex AI location (e.g. 'global', 'us-central1')
 * @param {string} config.model - Model name (e.g. 'gemini-2.5-flash')
 * @param {number} [config.timeoutMs=30000] - Default timeout for Vertex calls
 * @param {function} [config.logger] - Logger function, defaults to console.log
 * @returns {object} Client with summarize/generateTitle/enforceSchema/transform methods
 */
export function createVertexText(config) {
  const log = config.logger || ((...args) => console.log('[vertex-text]', ...args));
  const apiBase = `https://${config.location === 'global' ? '' : config.location + '-'}aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.location}/publishers/google/models`;
  const model = config.model;
  const timeoutMs = config.timeoutMs || 30_000;
  const enforceSchemaTimeoutMs = config.enforceSchemaTimeoutMs || 15_000;
  const enforceSchemaMaxAttempts = config.enforceSchemaMaxAttempts || 2;

  /**
   * Raw Vertex AI text→text call. Internal core used by all other methods.
   *
   * @param {string} text - Input text
   * @param {string} instruction - What to do with the text
   * @param {object} [opts] - Optional overrides
   * @param {number} [opts.maxTokens=1024] - Max output tokens
   * @param {number} [opts.temperature=0.3] - Temperature
   * @param {boolean} [opts.disableThinking] - Disable thinking for trivial tasks
   * @returns {Promise<string|null>} Result text or null on failure
   */
  async function _callVertex(text, instruction, opts = {}) {
    const maxTokens = opts.maxTokens || 1024;
    const temperature = opts.temperature ?? 0.3;

    log('DEBUG', `_callVertex: model=${model}, instruction="${instruction.substring(0, 80)}", input=${text.length} chars`);

    try {
      const token = await getGceToken();
      const url = `${apiBase}/${model}:generateContent`;

      const body = {
        contents: [{ role: 'user', parts: [{ text: `${instruction}\n\n---\n\n${text}` }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: temperature,
        },
      };
      if (opts.disableThinking) {
        body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs || timeoutMs),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        log('ERROR', `_callVertex HTTP ${resp.status}: ${errText.substring(0, 200)}`);
        return null;
      }

      const data = await resp.json();
      // SESSION_CONTEXT_PLAN Phase 0: utility calls were invisible to token
      // accounting — log counts only (never content, C-8).
      const um = data.usageMetadata;
      if (um) {
        log('INFO', `TELEMETRY utility_usage model=${model} input=${um.promptTokenCount || 0} output=${um.candidatesTokenCount || 0} cached=${um.cachedContentTokenCount || 0}`);
      }
      const parts = data.candidates?.[0]?.content?.parts || [];
      let result = '';
      for (const part of parts) {
        if (part.text && !part.thought) result = part.text;
      }
      log('DEBUG', `_callVertex result: ${result.length} chars`);
      return result.trim();
    } catch (err) {
      log('ERROR', `_callVertex failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Summarize text, using LLM if over budget, with smartTruncate fallback.
   * If text is within budget, returns it unchanged (no LLM call).
   *
   * @param {string} text - Text to summarize
   * @param {string} instruction - Summarization instruction
   * @param {object} [opts] - Optional overrides
   * @param {number} [opts.budget] - Max character budget for the result
   * @param {number} [opts.maxTokens] - Max output tokens (auto-computed from budget if not set)
   * @returns {Promise<string>} Summarized text
   */
  async function summarize(text, instruction, opts = {}) {
    const budget = opts.budget;
    if (budget && (!text || text.length <= budget)) return text || '';
    try {
      const maxTokens = opts.maxTokens || (budget ? Math.ceil(budget / 3) : 1024);
      const result = await _callVertex(text, instruction, { ...opts, maxTokens });
      if (result && result.length > 0) {
        if (budget) {
          return result.length <= budget ? result : result.substring(0, budget);
        }
        return result;
      }
    } catch (e) {
      log('WARN', `summarize fallback to truncate: ${e.message}`);
    }
    return budget ? smartTruncate(text, budget) : (text || '');
  }

  /**
   * Generate a clean title for an M, C, or T envelope using Gemini Flash.
   * Falls back to summarizeTitle() on failure.
   *
   * @param {string} text - Source text to generate a title from
   * @param {string} [type='mission'] - Envelope type: 'mission', 'checkpoint', or 'task'
   * @returns {Promise<string>} Generated title
   */
  async function generateTitleFn(text, type = 'mission') {
    if (!text || text.length < 3) return 'Untitled';
    // Only missions need LLM-quality titles; checkpoints/tasks use deterministic path
    if (type !== 'mission') return summarizeTitle(text);
    const prompt = 'A MISSION is a strategic goal — the top-level objective being accomplished. Title it as the outcome or deliverable. 5-12 words.\nNo quotes, no prefixes, no labels. Just the title.';
    try {
      const result = await _callVertex(text.substring(0, 1000), prompt, { maxTokens: 60, temperature: 0.3, disableThinking: true });
      if (result && result.length > 2 && result.length < 120) {
        return result.replace(/^["']|["']$/g, '').replace(/^(Mission|Checkpoint|Task):\s*/i, '').trim();
      }
    } catch (e) {
      log('DEBUG', `generateTitle failed: ${e.message}`);
    }
    return summarizeTitle(text);
  }

  /**
   * Validate a parsed object against known schema requirements.
   * Returns { valid: true } or { valid: false, reason }.
   *
   * @param {object} parsed - Parsed JSON object
   * @param {string} schemaName - Schema name: 'classify', 'decide', or 'analyze'
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateSchema(parsed, schemaName) {
    if (!parsed || typeof parsed !== 'object') return { valid: false, reason: 'not an object' };
    if (schemaName === 'classify') {
      const allowed = ['new_mission', 'attach', 'continue', 'cancel', 'respond'];
      if (!allowed.includes(parsed.classification)) return { valid: false, reason: `classification missing or invalid: ${parsed.classification}` };
      if (parsed.classification === 'respond' && (typeof parsed.response !== 'string' || !parsed.response.trim())) {
        return { valid: false, reason: 'response missing for respond classification' };
      }
      if (typeof parsed.reasoning !== 'string' || !parsed.reasoning) return { valid: false, reason: 'reasoning missing' };
      if (parsed.stakes && !['routine', 'consequential', 'irreversible'].includes(parsed.stakes)) {
        return { valid: false, reason: `stakes invalid: ${parsed.stakes}` };
      }
      return { valid: true };
    }
    if (schemaName === 'respond_compose') {
      if (typeof parsed.reasoning !== 'string' || !parsed.reasoning) return { valid: false, reason: 'reasoning missing' };
      if (typeof parsed.response !== 'string' || !parsed.response) return { valid: false, reason: 'response missing' };
      return { valid: true };
    }
    if (schemaName === 'decide') {
      const allowed = ['checkpoint_plan', 'synthesize', 'synthesize_with_failure', 'needs_input', 'blocked', 'follow_process', 'status_update', 'delegate', 'wait'];
      if (!allowed.includes(parsed.action)) return { valid: false, reason: `action missing or invalid: ${parsed.action}` };
      if (Array.isArray(parsed.assumptions)) {
        for (const a of parsed.assumptions) {
          if (!a || !a.claim || !['verified', 'inferred', 'assumed'].includes(a.status)) {
            return { valid: false, reason: 'assumptions entries require claim and status in {verified,inferred,assumed}' };
          }
        }
      }
      return { valid: true };
    }
    if (schemaName === 'analyze') {
      if (typeof parsed.objective !== 'string' || !parsed.objective) return { valid: false, reason: 'objective missing' };
      if (!Array.isArray(parsed.parts)) return { valid: false, reason: 'parts missing or not array' };
      return { valid: true };
    }
    if (schemaName === 'plan') {
      if (!Array.isArray(parsed.checkpoints)) return { valid: false, reason: 'checkpoints missing or not array' };
      return { valid: true };
    }
    return { valid: false, reason: `unknown schema: ${schemaName}` };
  }

  /**
   * Normalize known field-name aliases in a Cortex response.
   * Pure function — no LLM calls. Runs before validateSchema so that
   * common Cortex field drift (move→action, plan.checkpoints→checkpoints)
   * passes the deterministic path with zero Flash calls.
   *
   * @param {object} parsed - Parsed Cortex JSON
   * @returns {object} The same object, mutated in place
   */
  function normalizeDecision(parsed, schemaName) {
    if (!parsed || typeof parsed !== 'object') return parsed;

    // Action aliases: cortex often returns "move" instead of "action"
    if (parsed.move && !parsed.action) {
      parsed.action = parsed.move;
      log('DEBUG', `normalizeDecision: move → action (${parsed.action})`);
    }

    // Classify aliases: cortex frequently echoes the mode marker as
    // "action":"classify" and puts the actual decision under "type"
    // (mirroring decide's "action" field convention), or sometimes puts the
    // classification value directly under "action" with no wrapper at all.
    // Both silently produced classification=undefined in production — 11 of
    // 15 recent classify calls on prime-candicejr hit this before the alias
    // existed, masked by a since-fixed fast-exit that treated any truthy
    // "action" (always present, since it's the echoed mode marker) as proof
    // of a valid classification (see enforceSchemaFn).
    if (schemaName === 'classify' && !parsed.classification) {
      const CLASSIFY_ENUM = ['new_mission', 'attach', 'continue', 'cancel', 'respond'];
      if (parsed.type && CLASSIFY_ENUM.includes(parsed.type)) {
        parsed.classification = parsed.type;
        log('DEBUG', `normalizeDecision: type → classification (${parsed.classification})`);
      } else if (parsed.action && CLASSIFY_ENUM.includes(parsed.action)) {
        parsed.classification = parsed.action;
        log('DEBUG', `normalizeDecision: action → classification (${parsed.classification})`);
      }
    }

    // Classify aliases: cortex returns attach_to_mission instead of attach_to
    if (parsed.attach_to_mission && !parsed.attach_to) {
      parsed.attach_to = parsed.attach_to_mission;
      log('DEBUG', 'normalizeDecision: attach_to_mission → attach_to');
    }
    if (parsed.continue_to && !parsed.continue_mission) {
      parsed.continue_mission = parsed.continue_to;
      log('DEBUG', 'normalizeDecision: continue_to → continue_mission');
    }

    // Checkpoint nesting aliases: cortex nests checkpoints at varying depths
    if (!parsed.checkpoints) {
      if (parsed.plan?.checkpoints) {
        parsed.checkpoints = parsed.plan.checkpoints;
        log('DEBUG', 'normalizeDecision: plan.checkpoints → checkpoints');
      } else if (parsed.checkpoint_plan?.checkpoints) {
        parsed.checkpoints = parsed.checkpoint_plan.checkpoints;
        log('DEBUG', 'normalizeDecision: checkpoint_plan.checkpoints → checkpoints');
      } else if (parsed.steps && Array.isArray(parsed.steps)) {
        parsed.checkpoints = parsed.steps;
        log('DEBUG', 'normalizeDecision: steps → checkpoints');
      }
    }

    // goal_check aliases
    if (parsed.assessment && !parsed.goal_check) parsed.goal_check = { assessment: parsed.assessment };
    if (parsed.goal_assessment && !parsed.goal_check) parsed.goal_check = parsed.goal_assessment;

    return parsed;
  }

  /**
   * Enforce a JSON schema on raw Cortex output.
   * Tries deterministic parse+validate first (free). On failure, falls back to
   * Gemini structured output (up to 2 attempts), then parseJsonResponse.
   *
   * @param {string|object} raw - Raw Cortex response (string or parsed object)
   * @param {string} schemaName - Schema name: 'classify', 'decide', or 'analyze'
   * @returns {Promise<object>} Parsed and schema-conforming object
   */
  async function enforceSchemaFn(raw, schemaName) {
    const schema = CORTEX_SCHEMAS[schemaName];
    if (!schema) return typeof raw === 'string' ? parseJsonResponse(raw) : raw;

    // Parse + normalize ONCE. The deterministic check and the fast-exit below
    // must see the same (aliased) object — this used to re-parse `raw` twice
    // in separate try-blocks, so an alias applied for the first check never
    // reached the fast-exit's fresh, un-normalized copy.
    let parsed = null;
    try {
      parsed = typeof raw === 'object' ? raw : parseJsonResponse(raw);
      normalizeDecision(parsed, schemaName);
    } catch (e) {
      log('INFO', `enforceSchema deterministic parse failed: ${e.message}`);
    }

    if (parsed) {
      // Fast path: deterministic validate (no LLM call)
      const check = validateSchema(parsed, schemaName);
      if (check.valid) {
        log('DEBUG', `enforceSchema OK (deterministic): action=${parsed.action || parsed.classification}`);
        return parsed;
      }
      log('INFO', `enforceSchema deterministic invalid: ${check.reason} | action=${parsed?.action || 'none'}`);

      // Fast-exit: valid JSON with minimum required fields — skip Flash LLM
      // coercion. The daemon's own legality checks downstream catch illegal
      // actions. classify checks classification ONLY: "action" is never a
      // real classify field — it's always the echoed mode marker
      // ("action":"classify") — so its mere presence can't stand in for a
      // valid decision (this previously let every malformed classify
      // response through unrepaired, since the mode-marker is always set).
      if (schemaName === 'decide' && parsed.action) {
        log('INFO', `enforceSchema fast-exit: valid JSON with action=${parsed.action}`);
        return parsed;
      }
      if (schemaName === 'classify' && parsed.classification) {
        log('INFO', `enforceSchema fast-exit: valid JSON with classification=${parsed.classification}`);
        return parsed;
      }
      if (schemaName === 'respond_compose' && parsed.response) {
        log('INFO', `enforceSchema fast-exit: valid JSON with response`);
        return parsed;
      }
    }

    // Slow path: Flash LLM structured-output coercion
    const input = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const prompt = `Restructure this AI decision into the required JSON schema. Preserve ALL semantic content exactly — do not invent, remove, or modify any decisions, instructions, or reasoning.\n\n---\n${input}`;

    for (let attempt = 1; attempt <= enforceSchemaMaxAttempts; attempt++) {
      try {
        const token = await getGceToken();
        const resp = await fetch(`${apiBase}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: schema,
              maxOutputTokens: 8192,
              temperature: 0.1,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
          signal: AbortSignal.timeout(enforceSchemaTimeoutMs),
        });

        if (!resp.ok) {
          log('WARN', `enforceSchema attempt ${attempt}: HTTP ${resp.status}`);
          continue;
        }

        const data = await resp.json();
        const um = data.usageMetadata;
        if (um) {
          log('INFO', `TELEMETRY utility_usage stage=enforce_schema model=${model} input=${um.promptTokenCount || 0} output=${um.candidatesTokenCount || 0} cached=${um.cachedContentTokenCount || 0}`);
        }
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) { log('WARN', `enforceSchema attempt ${attempt}: empty response`); continue; }

        const parsed = JSON.parse(text);
        log('DEBUG', `enforceSchema OK (attempt ${attempt}): action=${parsed.action || parsed.classification}`);
        return parsed;
      } catch (err) {
        log('WARN', `enforceSchema attempt ${attempt}: ${err.message}`);
      }
    }

    log('WARN', `enforceSchema failed ${enforceSchemaMaxAttempts}x, falling back to parseJsonResponse`);
    try {
      return typeof raw === 'string' ? parseJsonResponse(raw) : raw;
    } catch (_) {
      // Last resort: if raw text is clearly not JSON (cortex produced narrative text),
      // wrap it into a synthesize action so the brain can gracefully close the mission.
      const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const trimmed = rawStr.trim();
      if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        log('WARN', `enforceSchema: raw text is not JSON, wrapping as synthesize action`);
        return { action: 'synthesize', summary: trimmed.substring(0, 2000) };
      }
      throw _;
    }
  }

  /**
   * Raw text→text transformation via Vertex AI. Generic interface for
   * any text transformation task (summarize, rephrase, extract, etc.).
   *
   * @param {string} text - Input text
   * @param {string} instruction - What to do with the text
   * @param {object} [opts] - Optional overrides (maxTokens, temperature, disableThinking)
   * @returns {Promise<string|null>} Transformed text or null on failure
   */
  async function transform(text, instruction, opts = {}) {
    return _callVertex(text, instruction, opts);
  }

  return {
    summarize,
    generateTitle: generateTitleFn,
    enforceSchema: enforceSchemaFn,
    transform,
  };
}
