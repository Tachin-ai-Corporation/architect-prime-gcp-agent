"use client";

import { useState, useEffect, use, useMemo } from "react";
import Link from "next/link";
import { FilePreviewGrid } from "@/components/agent/FilePreviewCard";
import type { FileCardItem } from "@/components/agent/FilePreviewCard";
import styles from "./page.module.css";

/* ---- Types ---- */
interface OrganDetail {
  key: string;
  label: string;
  icon: string;
  nature: string;
  role: string;
  never: string;
  sourceType: "specialty-append" | "base-brain";
  exists: boolean;
  content: string;
}

interface BrainAppend {
  part: string;
  exists: boolean;
  content: string;
}

interface ResponsibilityContext {
  purpose?: string;
  process?: string[];
  reference_files?: string[];
  success_criteria?: string;
  prior_learnings?: string;
}

interface Responsibility {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  min_spacing_minutes?: number;
  instruction: string;
  context?: ResponsibilityContext;
}

interface SkillManifest {
  id: string;
  name: string;
  description: string;
  category?: string;
  agent_part?: string;
  version?: string;
  skillMdContent?: string;
}

interface WorkspaceFile {
  name: string;
  exists: boolean;
  sizeBytes: number;
  preview: string;
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
  soulContent: string;
  brainAppends: BrainAppend[];
  organs: OrganDetail[];
  responsibilities: Responsibility[];
  skills: SkillManifest[];
  workspaceFiles: WorkspaceFile[];
}

/* ---- Organ accent color map ---- */
const ORGAN_ACCENTS: Record<string, string> = {
  cortex:              "var(--signal-aqua, #38bdf8)",
  prefrontal:          "#a78bfa",
  motor:               "#fbbf24",
  cerebellum:          "#2dd4bf",
  "temporal-memory":   "#818cf8",
  "temporal-research": "#38bdf8",
};

/* ---- Tabs ---- */
const TABS = [
  { key: "brain", label: "Brain", icon: "🧠" },
  { key: "responsibilities", label: "Responsibilities", icon: "📋" },
  { key: "skills", label: "Skills", icon: "🛠" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/* ---- Page ---- */
export default function AgentTypeDetailPage({
  params,
}: {
  params: Promise<{ specialty: string }>;
}) {
  const { specialty } = use(params);

  const [data, setData] = useState<SpecialtyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("brain");
  const [expandedResp, setExpandedResp] = useState<string | null>(null);

  /* ---- Fetch ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/agent-types/${specialty}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setData(json.specialty || null);
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
  }, [specialty]);

  /* ---- Build brain cards for FilePreviewGrid ---- */
  const brainCards: FileCardItem[] = useMemo(() => {
    if (!data) return [];
    const items: FileCardItem[] = [];

    // SOUL.md card
    if (data.soulContent) {
      items.push({
        key: "soul",
        label: "SOUL.md",
        icon: "💎",
        role: "Identity and soul — shared behavioral firmware",
        accent: "var(--signal-aqua, #38bdf8)",
        content: data.soulContent,
      });
    }

    // Organ cards
    for (const organ of (data.organs || [])) {
      items.push({
        key: organ.key,
        label: organ.label,
        icon: organ.icon,
        role: organ.role,
        accent: ORGAN_ACCENTS[organ.key] || "var(--border-subtle)",
        content: organ.exists ? organ.content : null,
      });
    }

    return items;
  }, [data]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.loading}>
          <span className={styles.loadingDots}>Loading class sheet…</span>
        </div>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error || !data) {
    return (
      <div className={styles.shell}>
        <Link href="/library/agent-types" className={styles.backLink}>
          <span className={styles.backArrow}>←</span> Back to roster
        </Link>
        <div className={styles.error}>{error || "Specialty not found"}</div>
      </div>
    );
  }

  const organCount = (data.organs || []).filter((o) => o.exists).length;

  return (
    <div className={styles.shell} id="agent-type-detail-page">
      {/* ---- Back link ---- */}
      <Link href="/library/agent-types" className={styles.backLink}>
        <span className={styles.backArrow}>←</span> Back to roster
      </Link>

      {/* ================================================================
         Hero Banner
         ================================================================ */}
      <div className={styles.hero}>
        <div
          className={styles.heroAccent}
          style={{ background: `linear-gradient(90deg, ${data.accent}, ${data.accent}44)` }}
        />
        <div
          className={styles.heroGlow}
          style={{ background: data.accent }}
        />
        <div className={styles.heroBadge}>v{data.version}</div>

        <div className={styles.heroGlyph}>{data.glyph}</div>
        <h1 className={styles.heroName} style={{ color: data.accent }}>
          {data.name}
        </h1>
        <div className={styles.heroId}>{data.id}</div>
        <div className={styles.heroDesc}>{data.description}</div>

        <div className={styles.heroStats}>
          <span className={styles.heroStat}>
            <span className={styles.heroStatIcon}>🧠</span>
            <span className={styles.heroStatValue}>{organCount}/6</span>
            <span className={styles.heroStatLabel}>organs</span>
          </span>
          <span className={styles.heroStat}>
            <span className={styles.heroStatIcon}>🛠</span>
            <span className={styles.heroStatValue}>{data.skills.length}</span>
            <span className={styles.heroStatLabel}>skills</span>
          </span>
          <span className={styles.heroStat}>
            <span className={styles.heroStatIcon}>📋</span>
            <span className={styles.heroStatValue}>{data.responsibilities.length}</span>
            <span className={styles.heroStatLabel}>duties</span>
          </span>
        </div>
      </div>

      {/* ================================================================
         Tab Navigation
         ================================================================ */}
      <div className={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            <span className={styles.tabIcon}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ================================================================
         Tab Content
         ================================================================ */}
      <div className={styles.tabContent}>
        {/* ---- Brain Tab ---- */}
        {activeTab === "brain" && (
          <FilePreviewGrid items={brainCards} columns={3} />
        )}

        {/* ---- Responsibilities Tab ---- */}
        {activeTab === "responsibilities" && (
          <div className={styles.sectionBody}>
            {data.responsibilities.length > 0 ? (
              <table className={styles.respTable}>
                <thead>
                  <tr>
                    <th className={styles.respTableHead} style={{ width: 28 }}></th>
                    <th className={styles.respTableHead}>Name</th>
                    <th className={styles.respTableHead}>Schedule</th>
                    <th className={styles.respTableHead}>Instruction</th>
                  </tr>
                </thead>
                <tbody>
                  {data.responsibilities.map((resp) => {
                    const isExp = expandedResp === resp.id;
                    return (
                      <>
                        <tr
                          key={resp.id}
                          className={styles.respRow}
                          onClick={() => setExpandedResp(isExp ? null : resp.id)}
                        >
                          <td className={styles.respCell}>
                            <span
                              className={`${styles.respDot} ${resp.enabled ? styles.respDotEnabled : styles.respDotDisabled}`}
                            />
                          </td>
                          <td className={styles.respCell}>
                            <span className={styles.respName}>{resp.name}</span>
                          </td>
                          <td className={styles.respCell}>
                            <span className={styles.respCron}>{resp.schedule}</span>
                          </td>
                          <td className={styles.respCell}>
                            <span className={styles.respInstruction}>{resp.instruction}</span>
                          </td>
                        </tr>
                        {isExp && resp.context && (
                          <tr key={`${resp.id}-detail`}>
                            <td colSpan={4} className={styles.respExpanded}>
                              {resp.context.purpose && (
                                <>
                                  <div className={styles.respExpandedTitle}>Purpose</div>
                                  <div className={styles.respExpandedText}>{resp.context.purpose}</div>
                                </>
                              )}
                              {resp.context.process && resp.context.process.length > 0 && (
                                <>
                                  <div className={styles.respExpandedTitle}>Process Steps</div>
                                  <div className={styles.respStepList}>
                                    {resp.context.process.map((step, i) => (
                                      <div key={i} className={styles.respStep}>
                                        <span className={styles.respStepNum}>{i + 1}</span>
                                        {step}
                                      </div>
                                    ))}
                                  </div>
                                </>
                              )}
                              {resp.context.success_criteria && (
                                <>
                                  <div className={styles.respExpandedTitle}>Success Criteria</div>
                                  <div className={styles.respExpandedText}>{resp.context.success_criteria}</div>
                                </>
                              )}
                              {resp.context.prior_learnings && (
                                <>
                                  <div className={styles.respExpandedTitle}>Prior Learnings</div>
                                  <div className={styles.respExpandedText}>{resp.context.prior_learnings}</div>
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className={styles.noData}>No responsibilities defined for this role.</div>
            )}
          </div>
        )}

        {/* ---- Skills Tab ---- */}
        {activeTab === "skills" && (
          <div className={styles.sectionBody}>
            {data.skills.length > 0 ? (
              <div className={styles.skillsGrid}>
                {data.skills.map((skill) => (
                  <div key={skill.id} className={styles.skillCard}>
                    <div className={styles.skillCardHeader}>
                      <span className={styles.skillName}>{skill.name}</span>
                      {skill.version && (
                        <span className={styles.skillVersion}>v{skill.version}</span>
                      )}
                    </div>
                    <div className={styles.skillDesc}>{skill.description}</div>
                    <div className={styles.skillMeta}>
                      {skill.category && (
                        <span className={`${styles.skillChip} ${styles.skillChipCategory}`}>
                          {skill.category}
                        </span>
                      )}
                      {skill.agent_part && (
                        <span className={`${styles.skillChip} ${styles.skillChipPart}`}>
                          {skill.agent_part}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.noData}>No specialty skills configured.</div>
            )}

            {/* Base + specialty skill tags */}
            <div style={{ marginTop: 24 }}>
              <div className={styles.deployLabel}>Base Skills</div>
              <div className={styles.skillsList}>
                {data.base_skills.map((s) => (
                  <span key={s} className={styles.deploySkillTag}>{s}</span>
                ))}
              </div>
              {data.specialty_skills.length > 0 && (
                <>
                  <div className={styles.deployLabel} style={{ marginTop: 16 }}>Specialty Skills</div>
                  <div className={styles.skillsList}>
                    {data.specialty_skills.map((s) => (
                      <span key={s} className={`${styles.deploySkillTag} ${styles.deploySkillTagSpecialty}`}>{s}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
