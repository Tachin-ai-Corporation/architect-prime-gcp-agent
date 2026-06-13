"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import styles from "./page.module.css";

/* ---- Types ---- */
interface SpecialtyDetail {
  id: string;
  name: string;
  version: string;
  description: string;
  glyph: string;
  accent: string;
  base_skills: string[];
  specialty_skills: string[];
  brain_appends: string[];
  totalSkills: number;
  hasResponsibilities: boolean;
  responsibilityCount: number;
}

/* ---- Brain append chip style map ---- */
const BRAIN_CHIP_CLASS: Record<string, string> = {
  cortex: styles.chipCortex,
  motor: styles.chipMotor,
  cerebellum: styles.chipCerebellum,
};

/* ---- Page ---- */
export default function AgentTypesPage() {
  const [specialties, setSpecialties] = useState<SpecialtyDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- Fetch data ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/agent-types/details");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setSpecialties(data.specialties || []);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.loading}>
          <span className={styles.loadingDots}>Loading roles…</span>
        </div>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.shell}>
        <div className={styles.error}>Failed to load roles: {error}</div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="agent-types-page">
      {/* ---- Header ---- */}
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Roles</h1>
        <span className={styles.countPill}>{specialties.length} specialties</span>
      </div>
      <div className={styles.pgSub}>
        Fleet class roster — each role defines the brain layers, skills, and duties an agent receives at hire
      </div>

      {/* ---- Grid ---- */}
      <div className={styles.grid}>
        {specialties.map((spec, i) => (
          <Link
            key={spec.id}
            href={`/library/agent-types/${spec.id}`}
            className={styles.card}
            id={`agent-type-${spec.id}`}
            style={{ animationDelay: `${i * 60}ms`, textDecoration: "none", color: "inherit" }}
          >
            {/* Accent top bar */}
            <div
              className={styles.cardAccent}
              style={{ background: `linear-gradient(90deg, ${spec.accent}, ${spec.accent}66)` }}
            />

            <div className={styles.cardBody}>
              {/* Glyph + info */}
              <div className={styles.cardTop}>
                <div
                  className={styles.glyphContainer}
                  style={{ background: `${spec.accent}12` }}
                >
                  <div
                    className={styles.glyphGlow}
                    style={{ boxShadow: `0 0 20px ${spec.accent}30` }}
                  />
                  <span role="img" aria-label={spec.name}>{spec.glyph}</span>
                </div>
                <div className={styles.cardInfo}>
                  <div className={styles.cardName} style={{ color: spec.accent }}>
                    {spec.name}
                  </div>
                  <div className={styles.cardId}>{spec.id}</div>
                </div>
              </div>

              {/* Description */}
              <div className={styles.cardDesc}>{spec.description}</div>

              {/* Stats */}
              <div className={styles.statsRow}>
                <span className={styles.stat}>
                  <span className={styles.statIcon}>🧠</span>
                  {spec.brain_appends.length} brain
                </span>
                <span className={styles.stat}>
                  <span className={styles.statIcon}>🛠</span>
                  {spec.totalSkills} skills
                </span>
                <span className={styles.stat}>
                  <span className={styles.statIcon}>📋</span>
                  {spec.responsibilityCount} duties
                </span>
              </div>

              {/* Brain append chips */}
              <div className={styles.chipRow}>
                {spec.brain_appends.map((ba) => (
                  <span
                    key={ba}
                    className={`${styles.brainChip} ${BRAIN_CHIP_CLASS[ba] || ""}`}
                  >
                    {ba}
                  </span>
                ))}
              </div>
            </div>

            {/* Version badge */}
            <div style={{ padding: "0 16px 12px", display: "flex", justifyContent: "flex-end" }}>
              <span className={styles.versionBadge}>v{spec.version}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
