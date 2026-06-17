// corekit/lib/verdict.mjs — Structural verdict extraction from tool logs
//
// Extracts verification verdicts from cerebellum tool logs.
// The verdict is the tool name (report_pass / report_fail), which is
// structurally unambiguous. Never parses response text for control flow.

/**
 * Extract a verification verdict from a cerebellum response's tool log.
 *
 * @param {string} output - The full agent response including tool execution log
 * @returns {'PASS'|'FAIL'|null} - PASS, FAIL, or null if no verdict tool was called
 */
export function extractVerdict(output) {
  if (!output) return null;
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const toolLog = text.match(/\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/)?.[1] || '';
  if (toolLog.includes('[TOOL] report_pass(')) return 'PASS';
  if (toolLog.includes('[TOOL] report_fail(')) return 'FAIL';
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
  const failMatch = text.match(/\[TOOL\] report_fail\(([\s\S]*?)\)\s*(?:\[RESULT\]|\[TOOL\]|\[END TOOL LOG\])/);
  if (failMatch) {
    try {
      const args = JSON.parse(failMatch[1]);
      return args.recommendation || args.reasoning || 'No recommendation available';
    } catch { /* fall through */ }
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

  const failMatch = text.match(/\[TOOL\] report_fail\(([\s\S]*?)\)\s*(?:\[RESULT\]|\[TOOL\]|\[END TOOL LOG\])/);
  if (failMatch) {
    try {
      const args = JSON.parse(failMatch[1]);
      const failedChecks = (args.checks || []).filter(c => !c.pass);
      if (failedChecks.length > 0) {
        return failedChecks.map(c => `- ${c.criterion}: ${c.evidence}`).join('\n');
      }
      return args.reasoning || '';
    } catch { /* fall through */ }
  }

  return '';
}
