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
        accent: ORGAN_ACCENTS[organ.key] || "var(--border-subtle)",
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

  /* ---- Build skill cards ---- */
  const skillCards: FileCardItem[] = useMemo(() => {
    if (!data) return [];
    return data.skills.map((s) => {
      const lines: string[] = [];
      lines.push(s.description);
      if (s.version) lines.push(`\nVersion: ${s.version}`);
      if (s.category) lines.push(`Category: ${s.category}`);
      if (s.agent_part) lines.push(`Agent Part: ${s.agent_part}`);
      if (s.skillMdContent) {
        lines.push("\n--- SKILL.md ---");
        lines.push(s.skillMdContent);
      }

      return {
        key: s.id,
        label: s.name,
        icon: "🛠",
        role: s.description.slice(0, 80),
        accent: "#a78bfa",
        content: lines.join("\n"),
      };
    });
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
          skillCards.length > 0
            ? <FilePreviewGrid items={skillCards} columns={3} />
            : <div className={styles.noData}>No specialty skills configured.</div>
        )}
      </div>
    </div>
  );
}
