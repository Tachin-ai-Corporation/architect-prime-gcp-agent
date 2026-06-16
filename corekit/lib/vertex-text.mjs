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
      classification: { type: 'STRING', enum: ['new_mission', 'attach', 'continue', 'cancel'] },
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
      }, required: ['id', 'summary', 'ownership', 'risk'] }},
      process_match: { type: 'STRING' },
    },
    required: ['objective', 'parts'],
  },
  decide: {
    type: 'OBJECT',
    properties: {
      action:     { type: 'STRING', enum: [
        'checkpoint_plan', 'synthesize', 'synthesize_with_failure',
        'needs_input', 'blocked', 'follow_process', 'status_update',
        'delegate',
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
      }, required: ['instruction', 'tasks'] }},
      synthesis:       { type: 'STRING' },
      failure_summary: { type: 'STRING' },
      question:        { type: 'STRING' },
      what_is_needed:  { type: 'STRING' },
      blocker:            { type: 'STRING' },
      blocker_type:       { type: 'STRING' },
      escalation_message: { type: 'STRING' },
      processId:  { type: 'STRING' },
      parameters: { type: 'OBJECT' },
      message: { type: 'STRING' },
      target_email:    { type: 'STRING' },
      instruction:     { type: 'STRING' },
      accept_criteria: { type: 'STRING' },
      project_id:      { type: 'STRING' },
    },
    required: ['action'],
  },
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
    const definitions = {
      mission: 'A MISSION is a strategic goal — the top-level objective being accomplished. Title it as the outcome or deliverable. 5-12 words.',
      checkpoint: 'A CHECKPOINT is a milestone or phase within a mission — a meaningful stage of progress. Title it as the deliverable or verification this phase produces. 5-10 words.',
      task: 'A TASK is an atomic unit of work — a single action performed by one agent. Title it as the specific action being taken. 5-10 words.',
    };
    const prompt = (definitions[type] || definitions.mission) + '\nNo quotes, no prefixes, no labels. Just the title.';
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
   * Enforce a JSON schema on raw Cortex output using Gemini structured output.
   * Makes up to 2 attempts, then falls back to parseJsonResponse.
   *
   * @param {string|object} raw - Raw Cortex response (string or parsed object)
   * @param {string} schemaName - Schema name: 'classify' or 'decide'
   * @returns {Promise<object>} Parsed and schema-conforming object
   */
  async function enforceSchemaFn(raw, schemaName) {
    const schema = CORTEX_SCHEMAS[schemaName];
    if (!schema) return typeof raw === 'string' ? parseJsonResponse(raw) : raw;

    const input = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const prompt = `Restructure this AI decision into the required JSON schema. Preserve ALL semantic content exactly — do not invent, remove, or modify any decisions, instructions, or reasoning.\n\n---\n${input}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
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
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!resp.ok) {
          log('WARN', `enforceSchema attempt ${attempt}: HTTP ${resp.status}`);
          continue;
        }

        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) { log('WARN', `enforceSchema attempt ${attempt}: empty response`); continue; }

        const parsed = JSON.parse(text);
        log('DEBUG', `enforceSchema OK (attempt ${attempt}): action=${parsed.action || parsed.classification}`);
        return parsed;
      } catch (err) {
        log('WARN', `enforceSchema attempt ${attempt}: ${err.message}`);
      }
    }

    log('WARN', `enforceSchema failed 2x, falling back to parseJsonResponse`);
    return typeof raw === 'string' ? parseJsonResponse(raw) : raw;
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
