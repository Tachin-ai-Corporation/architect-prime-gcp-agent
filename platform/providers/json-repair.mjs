// platform/providers/json-repair.mjs — JSON parsing and repair utilities
// Extracted from agent-brain.mjs Phase 0C
// Pure functions with zero dependencies. Used to parse and repair
// truncated/malformed JSON from LLM responses.

const warn = (...args) => console.warn('[json-repair]', ...args);

/**
 * Parse a raw LLM response string into a JSON object.
 * Handles markdown fences, legacy Action: blocks, bracket-balanced extraction,
 * greedy regex matching, and truncation repair as progressive fallbacks.
 *
 * @param {string} raw - Raw LLM response text
 * @returns {object} Parsed JSON object, or { error: 'parse_failed', raw: '...' }
 */
export function parseJsonResponse(raw) {
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  // Strip legacy Action: blocks that may follow JSON
  cleaned = cleaned.replace(/\nAction:.*$/s, '');

  // Try bracket-balanced JSON extraction
  const extracted = extractBalancedJson(cleaned);
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      if (parsed.action) return parsed;
    } catch {}
  }

  // Try greedy regex match
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      warn(`JSON parse failed (greedy): ${e.message}`);
      // If greedy match found a { but couldn't parse, try repair
      const repaired = repairTruncatedJson(jsonMatch[0]);
      if (repaired) {
        warn(`JSON repair succeeded — recovered truncated response`);
        return repaired;
      }
    }
  }

  // Try repair on the whole cleaned string (truncated JSON without closing braces)
  const repaired = repairTruncatedJson(cleaned);
  if (repaired) {
    warn(`JSON repair succeeded on raw input — recovered truncated response`);
    return repaired;
  }

  // Fallback: try the whole string
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    warn(`Could not parse response: ${raw.substring(0, 300)}`);
    return { error: 'parse_failed', raw: raw.substring(0, 500) };
  }
}

/**
 * Attempt to repair truncated JSON from LLM responses.
 * When an LLM hits its output token limit, the JSON gets cut off mid-field.
 * This function closes open strings, arrays, and objects to recover a parseable
 * structure. The repaired JSON will be missing some fields but the action/checkpoints
 * already emitted will be preserved — better than a total parse_failed.
 *
 * @param {string} text - Potentially truncated JSON string
 * @returns {object|null} Parsed object if repair succeeded, null otherwise
 */
export function repairTruncatedJson(text) {
  if (!text || text.length < 10) return null;

  // Find the start of the JSON object
  const start = text.indexOf('{');
  if (start === -1) return null;

  let json = text.substring(start);

  // Track state by scanning through the string
  let inString = false;
  let escape = false;
  const stack = []; // tracks open delimiters: '{' or '['

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}') { if (stack.length && stack[stack.length-1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack.length && stack[stack.length-1] === '[') stack.pop(); }
  }

  // If balanced already, nothing to repair
  if (stack.length === 0 && !inString) return null;

  // Close open string
  if (inString) {
    // Remove the partial string value (likely truncated mid-word)
    // Find the last complete key-value pair by backing up to last ","
    const lastComma = json.lastIndexOf(',');
    const lastColon = json.lastIndexOf(':');
    if (lastComma > lastColon && lastComma > json.length - 500) {
      // Truncate at the last comma (dropping the incomplete field)
      json = json.substring(0, lastComma);
    } else {
      // Just close the string
      json += '"';
    }
  }

  // Re-scan after string fix
  inString = false;
  escape = false;
  stack.length = 0;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}') { if (stack.length && stack[stack.length-1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack.length && stack[stack.length-1] === '[') stack.pop(); }
  }

  // Close remaining open delimiters in reverse order
  let suffix = '';
  while (stack.length > 0) {
    const open = stack.pop();
    suffix += (open === '{') ? '}' : ']';
  }

  if (!suffix) return null;

  const candidate = json + suffix;
  try {
    const parsed = JSON.parse(candidate);
    // Validate it has the minimum required structure
    if (parsed.action || parsed.classification) {
      warn(`repairTruncatedJson: closed ${suffix.length} delimiters, recovered action=${parsed.action || parsed.classification}`);
      return parsed;
    }
  } catch (e) {
    warn(`repairTruncatedJson: repair failed: ${e.message}`);
  }
  return null;
}

/**
 * Extract the first balanced JSON object from a text string.
 * Tracks brace depth and string escaping to find the matching closing brace.
 *
 * @param {string} text - Text potentially containing a JSON object
 * @returns {string|null} The extracted JSON substring, or null if not found
 */
export function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.substring(start, i + 1);
        return candidate;
      }
    }
  }
  return null;
}
