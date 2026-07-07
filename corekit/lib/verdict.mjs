// corekit/lib/verdict.mjs — Structural verdict extraction from tool logs
//
// Extracts verification verdicts from cerebellum tool logs.
// The verdict is the tool name (report_pass / report_fail), which is
// structurally unambiguous. Never parses response text for control flow.

/**
 * Extract a verification verdict from a cerebellum response's tool log.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {'PASS'|'FAIL'|'PROBE'|null} - PASS, FAIL, PROBE, or null if no verdict tool was called
 */
export function extractVerdict(output) {
  if (!output) return null;
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const toolLog = text.match(/\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/)?.[1] || '';
  if (toolLog.includes('[TOOL] report_pass(')) return 'PASS';
  if (toolLog.includes('[TOOL] report_fail(')) return 'FAIL';
  if (toolLog.includes('[TOOL] request_probe(')) return 'PROBE';
  return null; // No verdict tool called → escalate
}

/**
 * Extract the fail recommendation from a report_fail tool call in the log.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {string} - The recommendation text, or a default message
 */
export function extractFailRecommendation(output) {
  if (!output) return 'No recommendation available';
  const text = typeof output === 'string' ? output : JSON.stringify(output);

  // Try to find the tool result JSON from report_fail
  const failMatch = text.match(/\[TOOL\] report_fail\((.*?)(?:\)|$|\n)/);
  if (failMatch) {
    const rawArgs = failMatch[1];
    try {
      const args = JSON.parse(rawArgs);
      return args.recommendation || args.reasoning || 'No recommendation available';
    } catch {
      // Regex fallback for truncated JSON
      const recMatch = rawArgs.match(/"recommendation"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (recMatch) {
        return recMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      }
      const reasoningMatch = rawArgs.match(/"reasoning"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (reasoningMatch) {
        return reasoningMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      }
    }
  }

  // Fallback: look for recommendation in any JSON in the output
  try {
    const jsonMatch = text.match(/\{[\s\S]*"recommendation"[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]);
      return obj.recommendation || obj.reasoning || 'No recommendation available';
    }
  } catch { /* fall through */ }

  return 'No recommendation available';
}

/**
 * Extract the failed checks summary from a report_fail tool call.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {string} - Formatted summary of failed checks
 */
export function extractFailSummary(output) {
  if (!output) return '';
  const text = typeof output === 'string' ? output : JSON.stringify(output);

  const failMatch = text.match(/\[TOOL\] report_fail\((.*?)(?:\)|$|\n)/);
  if (failMatch) {
    const rawArgs = failMatch[1];
    try {
      const args = JSON.parse(rawArgs);
      const failedChecks = (args.checks || []).filter(c => !c.pass);
      if (failedChecks.length > 0) {
        return failedChecks.map(c => `- ${c.criterion}: ${c.evidence}`).join('\n');
      }
      return args.reasoning || '';
    } catch {
      // Regex fallback for truncated JSON
      const reasoningMatch = rawArgs.match(/"reasoning"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (reasoningMatch) {
        return reasoningMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      }
    }
  }

  return '';
}

/**
 * Parse the probes array from a request_probe tool-log entry.
 * Returns [] on any parse failure.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {Array<{claim: string, instruction: string}>}
 */
export function extractProbes(output) {
  if (!output) return [];
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  try {
    const toolLog = text.match(/\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/)?.[1] || '';
    const probeMatch = toolLog.match(/\[TOOL\] request_probe\((.*?)(?:\)|$|\n)/);
    if (!probeMatch) return [];
    const args = JSON.parse(probeMatch[1]);
    if (!Array.isArray(args.probes)) return [];
    return args.probes
      .filter(p => p && typeof p.claim === 'string' && typeof p.instruction === 'string')
      .map(p => ({ claim: String(p.claim), instruction: String(p.instruction) }));
  } catch {
    return [];
  }
}

/**
 * Ordinal stakes comparison.
 * stakesAtLeast('consequential', 'routine') === true means the first meets/exceeds the second.
 *
 * @param {string} stakes - The stakes level to check
 * @param {string} minimum - The minimum required level
 * @returns {boolean}
 */
export function stakesAtLeast(stakes, minimum) {
  const ord = { routine: 0, consequential: 1, irreversible: 2 };
  return (ord[stakes] ?? 0) >= (ord[minimum] ?? 1);
}
