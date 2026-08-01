// agent-output.mjs — Agent response analysis utilities
// Phase 3.1: Motor failure detection moved from callAgent transport to callers

import { toStr } from './to-str.mjs';

// Motor failure patterns — previously in callAgent content inspection.
// The error prefix accepts every form motor output actually uses: bash tools
// emit `[<tool>] [ERROR] …`, JS/tool failures emit `Error: …` (e.g. the gateway
// tool runner and work-output-read), and unhandled throws emit `Fatal: …`. The
// `/i` flag also covers the lowercase/`ERROR:` variants. Anchoring on `[ERROR]`
// alone silently missed `Error:`-prefixed auth failures.
const ERR_PREFIX = String.raw`(?:\[ERROR\]|Error:|Fatal:)`;
const MOTOR_FAILURE_PATTERNS = [
  { pattern: new RegExp(`${ERR_PREFIX}.*DWD token expired`, 'i'), type: 'auth', detail: 'DWD token expired' },
  { pattern: new RegExp(`${ERR_PREFIX}.*Permission denied`, 'i'), type: 'auth', detail: 'Permission denied' },
  { pattern: new RegExp(`${ERR_PREFIX}.*PERMISSION_DENIED`, 'i'), type: 'auth', detail: 'API permission denied' },
  { pattern: new RegExp(`${ERR_PREFIX}.*Authentication error`, 'i'), type: 'auth', detail: 'Authentication error' },
  { pattern: new RegExp(`${ERR_PREFIX}.*exit code [1-9]\\d*`, 'i'), type: 'exit_code', detail: 'Non-zero exit code' },
  { pattern: new RegExp(`${ERR_PREFIX}.*command failed`, 'i'), type: 'exit_code', detail: 'Command failed' },
];

/**
 * Detect motor-specific failures in agent output.
 * Returns { failed: boolean, type: 'auth'|'exit_code'|null, detail: string }
 * This is motor-specific — only call it on motor agent responses.
 *
 * @param {*} output - Agent response text or object
 * @returns {{ failed: boolean, type: string|null, detail: string }}
 */
export function detectMotorFailure(output) {
  const text = toStr(output);
  for (const { pattern, type, detail } of MOTOR_FAILURE_PATTERNS) {
    if (pattern.test(text)) {
      return { failed: true, type, detail };
    }
  }
  return { failed: false, type: null, detail: '' };
}

/**
 * Is a detected motor failure the task OUTCOME, or a sub-command error the motor RECOVERED
 * from? A multi-command motor task can have ONE command emit "command failed" in its tool log
 * and still finish — writing the full deliverable as its prose answer and self-verifying.
 * detectMotorFailure matches the failure pattern ANYWHERE in the combined output, so it flips
 * such a task to failed; the checkpoint then fails and the mission is reported `blocked` with
 * a complete answer inside it (observed live: a discovery that gathered all 18 service
 * accounts + instances blocked because one count command printed "command failed").
 *
 * The failure is the OUTCOME only when its marker is in the motor's ANSWER (the prose OUTSIDE
 * the [TOOL EXECUTION LOG]) or there is no substantive answer. A marker confined to the tool
 * log, with a real deliverable beside it, is a recovered incident — the caller should annotate
 * it and let checkpoint verification (cerebellum) arbitrate (B-28), not hard-fail the task.
 *
 * Conservative: returns true (recovered) ONLY when ALL hold — (1) the output has a tool-log
 * block, (2) a substantive answer sits outside it (>= minAnswerChars), (3) that answer does
 * NOT itself trip a failure pattern, and (4) the failure pattern IS inside the tool-log block.
 * Every other shape returns false, preserving the strict hard-fail.
 *
 * @param {*} output - the motor's full response (prose answer + tool log)
 * @param {{minAnswerChars?: number}} [opts]
 * @returns {boolean}
 */
export function isRecoveredToolError(output, { minAnswerChars = 200 } = {}) {
  const text = toStr(output);
  const logRe = /\[TOOL EXECUTION LOG\][\s\S]*?(?:\[END TOOL LOG\]|$)/;
  const logMatch = text.match(logRe);
  if (!logMatch) return false;                              // no tool log → any failure is the answer
  const answer = text.replace(new RegExp(logRe, 'g'), '').trim();
  if (answer.length < minAnswerChars) return false;         // no real deliverable → treat as failure
  if (detectMotorFailure(answer).failed) return false;      // the answer itself declares failure
  return detectMotorFailure(logMatch[0]).failed;            // failure lives only in the tool log
}
