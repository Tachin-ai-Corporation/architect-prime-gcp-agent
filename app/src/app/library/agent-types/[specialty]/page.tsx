"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import styles from "./page.module.css";

/* ---- Types ---- */
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
  responsibilities: Responsibility[];
  skills: SkillManifest[];
  workspaceFiles: WorkspaceFile[];
}

/* ---- Brain part display config ---- */
const BRAIN_META: Record<string, { icon: string; accentClass: string }> = {
  cortex:      { icon: "🧠", accentClass: styles.brainAccentCortex },
  motor:       { icon: "⚡", accentClass: styles.brainAccentMotor },
  cerebellum:  { icon: "🔄", accentClass: styles.brainAccentCerebellum },
};

/* ---- File icon map ---- */
const FILE_ICONS: Record<string, string> = {
  "IDENTITY.md": "🪪",
  "SOUL.md": "💎",
  "MEMORY.md": "🧬",
};

/* ---- Format bytes ---- */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

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

  /* Collapsible section states */
  const [soulOpen, setSoulOpen] = useState(false);
  const [expandedBrain, setExpandedBrain] = useState<Record<string, boolean>>({});
  const [expandedResp, setExpandedResp] = useState<string | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  /* ---- Fetch ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/library/agent-types/${specialty}`);
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

  const brainAppendCount = data.brainAppends.filter((b) => b.exists).length;
  const workspaceFileCount = data.workspaceFiles.filter((f) => f.exists).length;

  return (
    <div className={styles.shell} id="agent-type-detail-page">
      {/* ---- Back link ---- */}
      <Link href="/library/agent-types" className={styles.backLink}>
        <span className={styles.backArrow}>←</span> Back to roster
      </Link>

      {/* ================================================================
         Section 1: Hero Banner
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
            <span className={styles.heroStatValue}>{brainAppendCount}</span>
            <span className={styles.heroStatLabel}>brain layers</span>
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
          <span className={styles.heroStat}>
            <span className={styles.heroStatIcon}>📁</span>
            <span className={styles.heroStatValue}>{workspaceFileCount}</span>
            <span className={styles.heroStatLabel}>workspace files</span>
          </span>
        </div>
      </div>

      {/* ================================================================
         Section 2: Identity & Soul
         ================================================================ */}
      <div className={styles.section}>
        <div className={styles.sectionCard}>
          <div
            className={styles.sectionHeader}
            onClick={() => setSoulOpen(!soulOpen)}
          >
            <span className={styles.sectionIcon}>💎</span>
            <span className={styles.sectionTitle}>Identity &amp; Soul</span>
            <span className={styles.sectionCount}>
              {data.soulContent ? `${(data.soulContent.match(/\n/g) || []).length + 1} lines` : "—"}
            </span>
            <span className={`${styles.sectionChevron} ${soulOpen ? styles.sectionChevronOpen : ""}`}>
              ▼
            </span>
          </div>
          {soulOpen && (
            <div className={styles.sectionBody}>
              <div className={styles.soulContainer}>
                {data.soulContent || "No SOUL.md found for this specialty."}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ================================================================
         Section 3: Brain Architecture
         ================================================================ */}
      <div className={styles.section}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionHeaderStatic}>
            <span className={styles.sectionIcon}>🧠</span>
            <span className={styles.sectionTitle}>Brain Architecture</span>
            <span className={styles.sectionCount}>{brainAppendCount} / 3 layers</span>
          </div>
          <div className={styles.sectionBody}>
            <div className={styles.brainGrid}>
              {data.brainAppends.map((ba) => {
                const meta = BRAIN_META[ba.part] || { icon: "🔷", accentClass: "" };
                const isExpanded = expandedBrain[ba.part] || false;

                if (!ba.exists) {
                  return (
                    <div
                      key={ba.part}
                      className={`${styles.brainColumn} ${styles.brainColumnDisabled} ${meta.accentClass}`}
                    >
                      <div className={styles.brainColumnHeaderDisabled}>
                        <span className={styles.brainIcon}>{meta.icon}</span>
                        <span className={styles.brainPartName}>{ba.part}</span>
                        <span className={styles.brainPartDisabledLabel}>Not configured</span>
                      </div>
                    </div>
                  );
                }

                const preview = ba.content.slice(0, 500);
                const hasMore = ba.content.length > 500;

                return (
                  <div key={ba.part} className={`${styles.brainColumn} ${meta.accentClass}`}>
                    <div
                      className={styles.brainColumnHeader}
                      onClick={() =>
                        setExpandedBrain((prev) => ({
                          ...prev,
                          [ba.part]: !prev[ba.part],
                        }))
                      }
                    >
                      <span className={styles.brainIcon}>{meta.icon}</span>
                      <span className={styles.brainPartName}>{ba.part}</span>
                      {hasMore && (
                        <span
                          className={`${styles.brainExpandIcon} ${isExpanded ? styles.brainExpandIconOpen : ""}`}
                        >
                          ▼
                        </span>
                      )}
                    </div>
                    {isExpanded ? (
                      <div className={styles.brainContent}>{ba.content}</div>
                    ) : (
                      <div className={styles.brainPreview}>
                        {preview}
                        {hasMore && <div className={styles.brainFade} />}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================
         Section 4: Responsibilities
         ================================================================ */}
      <div className={styles.section}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionHeaderStatic}>
            <span className={styles.sectionIcon}>📋</span>
            <span className={styles.sectionTitle}>Responsibilities</span>
            <span className={styles.sectionCount}>{data.responsibilities.length} duties</span>
          </div>
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
              <div className={styles.noData}>No responsibilities defined for this specialty.</div>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================
         Section 5: Skills
         ================================================================ */}
      <div className={styles.section}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionHeaderStatic}>
            <span className={styles.sectionIcon}>🛠</span>
            <span className={styles.sectionTitle}>Specialty Skills</span>
            <span className={styles.sectionCount}>{data.skills.length} skills</span>
          </div>
          <div className={styles.sectionBody}>
            {data.skills.length > 0 ? (
              <div className={styles.skillsGrid}>
                {data.skills.map((skill) => {
                  const isExp = expandedSkill === skill.id;
                  return (
                    <div
                      key={skill.id}
                      className={styles.skillCard}
                      onClick={() => setExpandedSkill(isExp ? null : skill.id)}
                    >
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
                      {isExp && skill.skillMdContent && (
                        <div className={styles.skillExpanded}>
                          <div className={styles.skillMdContent}>{skill.skillMdContent}</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.noData}>No specialty skills configured.</div>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================
         Section 6: Workspace Files
         ================================================================ */}
      <div className={styles.section}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionHeaderStatic}>
            <span className={styles.sectionIcon}>📁</span>
            <span className={styles.sectionTitle}>Workspace Files</span>
            <span className={styles.sectionCount}>{workspaceFileCount} files</span>
          </div>
          <div className={styles.sectionBody}>
            <div className={styles.wsFileList}>
              {data.workspaceFiles.map((file) => (
                <div
                  key={file.name}
                  className={`${styles.wsFile} ${!file.exists ? styles.wsFileMissing : ""}`}
                >
                  <span className={styles.wsFileIcon}>{FILE_ICONS[file.name] || "📄"}</span>
                  <div className={styles.wsFileInfo}>
                    <div className={styles.wsFileName}>{file.name}</div>
                    {file.exists && file.preview && (
                      <div className={styles.wsFilePreview}>
                        {file.preview.replace(/\n/g, " ").trim()}
                      </div>
                    )}
                    {!file.exists && (
                      <div className={styles.wsFilePreview}>Not present in workspace</div>
                    )}
                  </div>
                  {file.exists && (
                    <span className={styles.wsFileSize}>{formatBytes(file.sizeBytes)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================
         Section 7: Deployment Info
         ================================================================ */}
      <div className={styles.section}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionHeaderStatic}>
            <span className={styles.sectionIcon}>🚀</span>
            <span className={styles.sectionTitle}>Deployment Kit</span>
          </div>
          <div className={styles.sectionBody}>
            <div className={styles.deployPath}>
              <div className={styles.deployLabel}>Kit Manifest</div>
              <div className={styles.deployValue}>
                specialties/{data.id}/kit.json
              </div>
            </div>

            {/* All skills combined */}
            <div className={styles.skillsList}>
              <div className={styles.deployLabel} style={{ width: "100%", marginTop: 16, marginBottom: 4 }}>
                Base Skills
              </div>
              {data.base_skills.map((s) => (
                <span key={s} className={styles.deploySkillTag}>{s}</span>
              ))}
            </div>
            {data.specialty_skills.length > 0 && (
              <div className={styles.skillsList}>
                <div className={styles.deployLabel} style={{ width: "100%", marginTop: 12, marginBottom: 4 }}>
                  Specialty Skills
                </div>
                {data.specialty_skills.map((s) => (
                  <span key={s} className={`${styles.deploySkillTag} ${styles.deploySkillTagSpecialty}`}>{s}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

