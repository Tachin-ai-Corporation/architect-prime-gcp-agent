// to-str.mjs — Type-safe string conversion

/**
 * Convert any value to a string safely.
 * Handles: null, undefined, objects, arrays, numbers, booleans.
 * Note: For objects, prefers .instruction/.text fields before JSON.stringify
 * to match agent-brain.mjs behavior.
 */
export function toStr(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return typeof v === 'object' ? (v.instruction || v.text || JSON.stringify(v)) : String(v);
}
