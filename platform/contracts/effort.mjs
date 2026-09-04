// platform/contracts/effort.mjs — per-prime "effort" → dispatch temperature scale.
//
// Effort is a per-PRIME cognitive-latitude control, set from the dashboard (stored at
// primes/{primeId}/config/settings.effort). Higher effort = warmer, more exploratory sampling.
// It multiplies the base per-organ temperature and clamps to a safe ceiling. It applies to
// PRIMES ONLY — a fleet agent always runs at DEFAULT_EFFORT ('medium' = base temps unchanged),
// because it shares its managing prime's config path and the knob is the prime's own cognition.
//
// This is the runtime-adjustable, per-prime companion to the role-based capability posture
// (C-37): the posture (by role) sets the model tier + budgets; effort (per prime) tunes sampling.
// It is a latitude knob only — it never touches the deterministic spine or the fence. Pure (B-19).

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];
export const DEFAULT_EFFORT = 'medium';

// Multiplier applied to the base per-organ temperature. 'medium' = 1.0 (the unchanged baseline).
const SCALE = { low: 0.5, medium: 1.0, high: 1.4, max: 1.8 };
// Effective-temperature ceiling. The Anthropic cortex caps temperature at 1.0; keep every organ
// inside a safe band so 'max' explores without becoming incoherent.
const TEMP_CEILING = 1.0;

/** Coerce any value to a known effort level; unknown/absent → DEFAULT_EFFORT. Pure. */
export function normalizeEffort(effort) {
  return EFFORT_LEVELS.includes(effort) ? effort : DEFAULT_EFFORT;
}

/** The temperature multiplier for an effort level. Pure. */
export function effortScale(effort) {
  return SCALE[normalizeEffort(effort)];
}

/**
 * Scale a base temperature by effort, clamped to [0, TEMP_CEILING]. Pure.
 * 'medium' returns the base unchanged; a non-numeric base falls back to 0.5.
 */
export function applyEffort(baseTemperature, effort) {
  const base = typeof baseTemperature === 'number' ? baseTemperature : 0.5;
  const t = base * effortScale(effort);
  return Math.max(0, Math.min(TEMP_CEILING, t));
}
