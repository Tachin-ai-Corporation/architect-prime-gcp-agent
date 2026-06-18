// agent-output.mjs — Agent response analysis utilities
// Phase 3.1: Motor failure detection moved from callAgent transport to callers

import { toStr } from './to-str.mjs';

// Motor failure patterns — previously in callAgent content inspection
const MOTOR_FAILURE_PATTERNS = [
  { pattern: /DWD token expired/i, type: 'auth', detail: 'DWD token expired' },
  { pattern: /Permission denied/i, type: 'auth', detail: 'Permission denied' },
  { pattern: /PERMISSION_DENIED/i, type: 'auth', detail: 'API permission denied' },
  { pattern: /Authentication error/i, type: 'auth', detail: 'Authentication error' },
  { pattern: /exit code [1-9]\d*/i, type: 'exit_code', detail: 'Non-zero exit code' },
  { pattern: /command failed/i, type: 'exit_code', detail: 'Command failed' },
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
