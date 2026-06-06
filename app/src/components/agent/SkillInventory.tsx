"use client";

import { useState, useCallback } from "react";
import { useIntrospect } from "@/hooks/useIntrospect";
import styles from "./SkillInventory.module.css";

/* ================================================================
   Types
   ================================================================ */

export interface SkillTool {
  name: string;
  description: string;
}

export interface Skill {
  name: string;
  description: string;
  version?: string;
  tools: SkillTool[];
  source: string; // 'installed' | 'builtin'
}

export interface SkillData {
  skills: Skill[];
}

interface SkillInventoryProps {
  primeId: string;
  agentName: string;
}

/* ================================================================
   Component
   ================================================================ */

export function SkillInventory({ primeId, agentName }: SkillInventoryProps) {
  const { data, loading, error, refresh } = useIntrospect<SkillData>({
    primeId,
    agent: agentName,
    type: "skills",
  });

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>Loading skills…</span>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.error}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        <button className={styles.retryBtn} onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  /* ---- Empty ---- */
  const skills = data?.skills ?? [];
  if (skills.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>📦</div>
        No skills installed
      </div>
    );
  }

  /* ---- Grid ---- */
  return (
    <div className={styles.grid}>
      {skills.map((skill) => (
        <SkillCard key={skill.name} skill={skill} />
      ))}
    </div>
  );
}

/* ================================================================
   SkillCard — individual card with expandable tool list
   ================================================================ */

function SkillCard({ skill }: { skill: Skill }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <div className={styles.card}>
      {/* Header */}
      <div className={styles.cardHeader}>
        <span className={styles.cardName}>{skill.name}</span>
      </div>

      {/* Description */}
      {skill.description && (
        <div className={styles.cardDesc}>{skill.description}</div>
      )}

      {/* Badges */}
      <div className={styles.badges}>
        {skill.version && (
          <span className={`${styles.badge} ${styles.badgeVersion}`}>
            v{skill.version}
          </span>
        )}
        <span className={`${styles.badge} ${styles.badgeTools}`}>
          {skill.tools.length} tool{skill.tools.length !== 1 ? "s" : ""}
        </span>
        <span
          className={`${styles.badge} ${
            skill.source === "builtin" ? styles.badgeBuiltin : styles.badgeInstalled
          }`}
        >
          {skill.source}
        </span>
      </div>

      {/* Tool list toggle */}
      {skill.tools.length > 0 && (
        <>
          <button className={styles.toolToggle} onClick={toggle}>
            <span
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
            >
              ▸
            </span>
            {expanded ? "Hide tools" : "Show tools"}
          </button>

          {expanded && (
            <div className={styles.toolList}>
              {skill.tools.map((tool) => (
                <div key={tool.name} className={styles.toolRow}>
                  <span className={styles.toolName}>{tool.name}</span>
                  {tool.description && (
                    <span className={styles.toolDesc}>{tool.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
