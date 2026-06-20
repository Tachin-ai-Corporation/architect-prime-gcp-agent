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
  agent_part?: string | string[];
  version?: string;
  origin?: string;
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

/* ---- Organ display metadata ---- */
const ORGAN_META: Record<string, { icon: string; accent: string; label: string }> = {
  cortex:              { icon: "🧠", accent: "var(--signal-aqua, #38bdf8)", label: "Cortex" },
  prefrontal:          { icon: "🏗️", accent: "#a78bfa", label: "Prefrontal" },
  motor:               { icon: "⚡", accent: "#fbbf24", label: "Motor" },
  cerebellum:          { icon: "🔄", accent: "#2dd4bf", label: "Cerebellum" },
  "temporal-memory":   { icon: "💾", accent: "#818cf8", label: "Temporal-Memory" },
  "temporal-research": { icon: "🔍", accent: "#38bdf8", label: "Temporal-Research" },
};

const ORGAN_ORDER = ["cortex", "prefrontal", "motor", "cerebellum", "temporal-memory", "temporal-research", "all"];

/* ---- Origin display metadata ---- */
const ORIGIN_META: Record<string, { label: string; color: string }> = {
  universal: { label: "Universal", color: "#94a3b8" },
  fleet:     { label: "Fleet",     color: "#38bdf8" },
  specialty: { label: "Specialty", color: "#fbbf24" },
  base:      { label: "Universal", color: "#94a3b8" },
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

  /* ---- Build brain cards ---- */
  const brainCards: FileCardItem[] = useMemo(() => {
    if (!data) return [];
    const items: FileCardItem[] = [];

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

    for (const organ of (data.organs || [])) {
      items.push({
        key: organ.key,
        label: organ.label,
        icon: organ.icon,
        role: organ.role,
        accent: ORGAN_META[organ.key]?.accent || "var(--border-subtle)",
        content: organ.exists ? organ.content : null,
      });
    }

    return items;
  }, [data]);

  /* ---- Build responsibility cards ---- */
  const respCards: FileCardItem[] = useMemo(() => {
    if (!data) return [];
    return data.responsibilities.map((r) => {
      const lines: string[] = [];
      lines.push(`Schedule: ${r.schedule}`);
      lines.push(`Enabled: ${r.enabled ? "yes" : "no"}`);
      if (r.min_spacing_minutes) lines.push(`Min spacing: ${r.min_spacing_minutes} min`);
      lines.push("");
      lines.push("--- Instruction ---");
      lines.push(r.instruction);
      if (r.context?.purpose) {
        lines.push("");
        lines.push("--- Purpose ---");
        lines.push(r.context.purpose);
      }
      if (r.context?.process && r.context.process.length > 0) {
        lines.push("");
        lines.push("--- Process Steps ---");
        r.context.process.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      }
      if (r.context?.success_criteria) {
        lines.push("");
        lines.push("--- Success Criteria ---");
        lines.push(r.context.success_criteria);
      }

      return {
        key: r.id,
        label: r.name,
        icon: r.enabled ? "📋" : "⏸️",
        role: r.schedule,
        accent: r.enabled ? "#2dd4bf" : "#566373",
        content: lines.join("\n"),
      };
    });
  }, [data]);

  /* ---- Skills grouped by organ ---- */
  const skillsByOrgan = useMemo(() => {
    if (!data) return [];
    const skills = data.skills;
    if (skills.length === 0) return [];

    const grouped: Record<string, SkillManifest[]> = {};
    for (const s of skills) {
      const parts = Array.isArray(s.agent_part) ? s.agent_part : [s.agent_part || "motor"];
      for (const part of parts) {
        if (!grouped[part]) grouped[part] = [];
        grouped[part].push(s);
      }
    }

    const sections: { organ: string; meta: typeof ORGAN_META[string]; cards: FileCardItem[] }[] = [];
    const allParts = new Set([...ORGAN_ORDER, ...Object.keys(grouped)]);

    for (const part of allParts) {
      const partSkills = grouped[part];
      if (!partSkills || partSkills.length === 0) continue;
      const meta = ORGAN_META[part] || { icon: "🔧", accent: "#566373", label: part };
      const cards: FileCardItem[] = partSkills.map((s) => {
        const originInfo = ORIGIN_META[s.origin || "base"] || ORIGIN_META.universal;
        const originTag = `[${originInfo.label}]`;
        return {
          key: s.id,
          label: s.name,
          icon: meta.icon,
          role: `${originTag} ${s.description.slice(0, 90)}`,
          accent: meta.accent,
          content: s.skillMdContent || s.description,
        };
      });
      sections.push({ organ: part, meta, cards });
    }

    return sections;
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

  return (
    <div className={styles.shell} id="agent-type-detail-page">
      {/* ---- Back link ---- */}
      <Link href="/library/agent-types" className={styles.backLink}>
        <span className={styles.backArrow}>←</span> Back to roster
      </Link>

      {/* ---- Hero Banner ---- */}
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
      </div>

      {/* ---- Tab Navigation ---- */}
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

      {/* ---- Tab Content ---- */}
      <div className={styles.tabContent}>
        {activeTab === "brain" && (
          <FilePreviewGrid items={brainCards} columns={3} />
        )}

        {activeTab === "responsibilities" && (
          respCards.length > 0
            ? <FilePreviewGrid items={respCards} columns={3} />
            : <div className={styles.noData}>No responsibilities defined for this role.</div>
        )}

        {activeTab === "skills" && (
          skillsByOrgan.length > 0
            ? (
              <div className={styles.organSections}>
                {skillsByOrgan.map(({ organ, meta, cards }) => (
                  <div key={organ} className={styles.organSection}>
                    <div className={styles.organHeader}>
                      <span className={styles.organAccentBar} style={{ background: meta.accent }} />
                      <span className={styles.organIcon}>{meta.icon}</span>
                      <span className={styles.organLabel}>{meta.label}</span>
                      <span className={styles.organCount}>{cards.length} skill{cards.length !== 1 ? "s" : ""}</span>
                    </div>
                    <FilePreviewGrid items={cards} columns={3} />
                  </div>
                ))}
              </div>
            )
            : <div className={styles.noData}>No skills configured for this role.</div>
        )}
      </div>
    </div>
  );
}
