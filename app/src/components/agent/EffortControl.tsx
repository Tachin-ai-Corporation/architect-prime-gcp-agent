"use client";

import { useEffect, useState } from "react";
import styles from "./EffortControl.module.css";

const LEVELS = ["low", "medium", "high", "max"] as const;
type Effort = (typeof LEVELS)[number];

const HINT: Record<Effort, string> = {
  low: "focused — most deterministic",
  medium: "balanced (default)",
  high: "more exploratory",
  max: "widest — most creative",
};

/**
 * Per-prime "Effort" — the reasoning-latitude knob. Scales the brain's dispatch sampling
 * temperature (low < medium < high < max). Persists to primes/{id}/config/settings.effort;
 * the brain daemon picks it up on its throttled refresh (no restart). Prime-only.
 */
export function EffortControl({ primeId }: { primeId: string }) {
  const [effort, setEffort] = useState<Effort>("medium");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/effort?primeId=${encodeURIComponent(primeId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.effort && LEVELS.includes(d.effort)) setEffort(d.effort as Effort);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [primeId]);

  async function choose(next: Effort) {
    if (next === effort || saving) return;
    const prev = effort;
    setEffort(next);
    setSaving(true);
    try {
      const r = await fetch(`/api/effort?primeId=${encodeURIComponent(primeId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effort: next }),
      });
      if (!r.ok) setEffort(prev);
    } catch {
      setEffort(prev);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>Effort</span>
        <span className={styles.sub}>reasoning latitude — scales the brain&apos;s sampling temperature</span>
      </div>
      <div className={styles.segmented} role="radiogroup" aria-label="Effort">
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={effort === l}
            disabled={!loaded || saving}
            className={`${styles.seg} ${effort === l ? styles.active : ""}`}
            onClick={() => choose(l)}
          >
            {l}
          </button>
        ))}
      </div>
      <div className={styles.hint}>{HINT[effort]}</div>
    </div>
  );
}
