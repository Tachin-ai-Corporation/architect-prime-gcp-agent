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
