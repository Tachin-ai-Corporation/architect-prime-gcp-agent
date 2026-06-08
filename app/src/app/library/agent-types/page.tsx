"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import styles from "./page.module.css";

/* ---- Types ---- */
interface Responsibility {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
}

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
  responsibilities: Responsibility[];
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.loading}>
          <span className={styles.loadingDots}>Loading agent types…</span>
        </div>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.shell}>
        <div className={styles.error}>Failed to load agent types: {error}</div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="agent-types-page">
      {/* ---- Header ---- */}
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Agent Types</h1>
        <span className={styles.countPill}>{specialties.length} specialties</span>
      </div>
      <div className={styles.pgSub}>
        Fleet class roster — each specialty defines the brain layers, skills, and duties an agent receives at hire
      </div>

      {/* ---- Grid ---- */}
      <div className={styles.grid}>
        {specialties.map((spec, i) => {
          const isExpanded = expandedId === spec.id;

          return (
            <div
              key={spec.id}
              className={styles.card}
              id={`agent-type-${spec.id}`}
              style={{
                animationDelay: `${i * 60}ms`,
                boxShadow: isExpanded
                  ? `0 0 0 1px ${spec.accent}40, 0 0 24px ${spec.accent}18, 0 8px 28px rgba(0,0,0,0.24)`
                  : undefined,
              }}
              onClick={() => toggleExpand(spec.id)}
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
                    {/* Glow effect */}
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

              {/* Expand hint */}
              <div className={styles.expandHint}>
                <span className={`${styles.expandChevron} ${isExpanded ? styles.expandChevronOpen : ""}`}>
                  ▼
                </span>
              </div>

              {/* ---- Expanded detail ---- */}
              {isExpanded && (
                <div className={styles.detailPanel}>
                  {/* Skills */}
                  <div className={styles.detailSection}>
                    <div className={styles.detailSectionTitle}>Skills</div>
                    <div className={styles.skillTags}>
                      {spec.base_skills.map((s) => (
                        <span key={s} className={styles.skillTag}>{s}</span>
                      ))}
                      {spec.specialty_skills.map((s) => (
                        <span key={s} className={`${styles.skillTag} ${styles.skillTagSpecialty}`}>{s}</span>
                      ))}
                      {spec.totalSkills === 0 && (
                        <span className={styles.noData}>No skills configured</span>
                      )}
                    </div>
                  </div>

                  {/* Responsibilities */}
                  <div className={styles.detailSection}>
                    <div className={styles.detailSectionTitle}>
                      Responsibilities ({spec.responsibilityCount})
                    </div>
                    {spec.responsibilities.length > 0 ? (
                      <div className={styles.respList}>
                        {spec.responsibilities.map((r) => (
                          <div key={r.id} className={styles.respItem}>
                            <span
                              className={`${styles.respDot} ${
                                r.enabled ? styles.respDotEnabled : styles.respDotDisabled
                              }`}
                            />
                            <span className={styles.respName}>{r.name}</span>
                            <span className={styles.respSchedule}>{r.schedule}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className={styles.noData}>No responsibilities defined</span>
                    )}
                  </div>

                  {/* Version + Detail link */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                    <div className={styles.versionBadge}>v{spec.version}</div>
                    <Link
                      href={`/library/agent-types/${spec.id}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: spec.accent,
                        textDecoration: 'none',
                        transition: 'opacity 180ms',
                      }}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '0.75'; }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '1'; }}
                    >
                      View Class Sheet →
                    </Link>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

