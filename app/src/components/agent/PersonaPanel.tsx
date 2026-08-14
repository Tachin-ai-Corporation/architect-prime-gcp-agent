"use client";

import { useState, useMemo } from "react";
import { useIntrospect } from "@/hooks/useIntrospect";
import { FilePreviewGrid } from "@/components/agent/FilePreviewCard";
import type { FileCardItem } from "@/components/agent/FilePreviewCard";
import styles from "./PersonaPanel.module.css";

/* ================================================================
   PersonaPanel — unified Brain / Responsibilities / Skills sub-tabs
   with card→click→modal pattern for all content.
   
   Used by both Prime and Fleet agent detail pages.
   ================================================================ */

/* ---- Brain organ definitions (CANON_ORGANS source of truth) ---- */
const BRAIN_ORGANS = [
  { key: "cortex", label: "Cortex", icon: "🧠", filePath: "SOUL.md", role: "Classify intakes, choose decisions, synthesize outcomes", accent: "var(--signal-aqua)" },
  { key: "prefrontal", label: "Prefrontal", icon: "🏗️", filePath: "workspace-prefrontal/SOUL.md", role: "Turn intent into structure: M→C→T blueprints", accent: "#a78bfa" },
  { key: "motor", label: "Motor", icon: "⚡", filePath: "workspace-motor/SOUL.md", role: "Act: tools, exec, files — the only mutator", accent: "#fbbf24" },
  { key: "cerebellum", label: "Cerebellum", icon: "🔄", filePath: "workspace-cerebellum/SOUL.md", role: "Verify results against accept criteria, independently", accent: "#2dd4bf" },
  { key: "temporal-memory", label: "Temporal-Memory", icon: "💾", filePath: "workspace-temporal-memory/SOUL.md", role: "Recall what the agent already knows", accent: "#818cf8" },
  { key: "temporal-research", label: "Temporal-Research", icon: "🔍", filePath: "workspace-temporal-research/SOUL.md", role: "Bring in what the world knows: search + fetch", accent: "#38bdf8" },
];

/* ---- Organ accent map for skill cards ---- */
const ORGAN_ACCENTS: Record<string, { icon: string; accent: string; label: string }> = {
  cortex:              { icon: "🧠", accent: "var(--signal-aqua, #38bdf8)", label: "Cortex" },
  prefrontal:          { icon: "🏗️", accent: "#a78bfa", label: "Prefrontal" },
  motor:               { icon: "⚡", accent: "#fbbf24", label: "Motor" },
  cerebellum:          { icon: "🔄", accent: "#2dd4bf", label: "Cerebellum" },
  "temporal-memory":   { icon: "💾", accent: "#818cf8", label: "Temporal-Memory" },
  "temporal-research": { icon: "🔍", accent: "#38bdf8", label: "Temporal-Research" },
};

/* ---- Types ---- */
interface Responsibility {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  min_spacing_minutes: number;
  instruction: string;
  has_process: boolean;
  source: string;
}

interface BrainConfig {
  responsibilities: Responsibility[];
  [key: string]: unknown;
}

interface IntrospectSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  agent_part: string | string[];
  category: string;
  origin: string;
  scripts: string[];
  when_to_use: string;
  skillMdContent: string;
}

interface SkillData {
  skills: IntrospectSkill[];
}

/* ---- Sub-tabs ---- */
const SUB_TABS = [
  { key: "brain", label: "Brain", icon: "🧠" },
  { key: "responsibilities", label: "Responsibilities", icon: "📋" },
  { key: "skills", label: "Skills", icon: "🛠" },
] as const;

type SubTabKey = (typeof SUB_TABS)[number]["key"];

/* ---- Organ display order ---- */
const ORGAN_ORDER = BRAIN_ORGANS.map((o) => o.key);

/* ---- Props ---- */
interface PersonaPanelProps {
  primeId: string;
  agentName: string;
  /** Workspace files (IDENTITY.md, MEMORY.md, organ SOULs) from the overview introspect */
  workspaceFiles: Record<string, string>;
  workspaceLoading: boolean;
}

/* ---- Component ---- */
export function PersonaPanel({ primeId, agentName, workspaceFiles, workspaceLoading }: PersonaPanelProps) {
  const [subTab, setSubTab] = useState<SubTabKey>("brain");

  /* ---- Responsibilities data ---- */
  const { data: brainConfig, loading: respLoading } = useIntrospect<BrainConfig>({
    primeId,
    agent: agentName,
    type: "brain_config",
    autoFetch: subTab === "responsibilities",
  });

  /* ---- Skills data ---- */
  const { data: skillData, loading: skillsLoading } = useIntrospect<SkillData>({
    primeId,
    agent: agentName,
    type: "skills",
    autoFetch: subTab === "skills",
  });

  /* ---- Brain cards ---- */
  const brainCards: FileCardItem[] = useMemo(() => {
    const files = workspaceFiles || {};
    return [
      { key: "identity", label: "IDENTITY.md", icon: "📄", role: "Agent identity and persona", accent: "var(--signal-aqua)", content: files["IDENTITY.md"] ?? null },
      { key: "memory", label: "MEMORY.md", icon: "🧠", role: "Working memory", accent: "#818cf8", content: files["MEMORY.md"] ?? null },
      ...BRAIN_ORGANS.map((organ) => ({
        key: organ.key,
        label: organ.label,
        icon: organ.icon,
        role: organ.role,
        accent: organ.accent,
        content: files[organ.filePath] ?? null,
      })),
    ];
  }, [workspaceFiles]);

  /* ---- Responsibility cards ---- */
  const respCards: FileCardItem[] = useMemo(() => {
    const resps = brainConfig?.responsibilities || [];
    return resps.map((r) => {
      const lines: string[] = [];
      lines.push(`Schedule: ${r.schedule}`);
      lines.push(`Enabled: ${r.enabled ? "yes" : "no"}`);
      if (r.min_spacing_minutes) lines.push(`Min spacing: ${r.min_spacing_minutes} min`);
      if (r.has_process) lines.push("Process: attached");
      lines.push(`Source: ${r.source}`);
      lines.push("");
      lines.push("--- Instruction ---");
      lines.push(r.instruction);

      return {
        key: r.id,
        label: r.name,
        icon: r.enabled ? "📋" : "⏸️",
        role: r.schedule,
        accent: r.enabled ? "#2dd4bf" : "#566373",
        content: lines.join("\n"),
      };
    });
  }, [brainConfig]);

  /* ---- Skills grouped by organ ---- */
  const skillsByOrgan: { organ: string; meta: typeof ORGAN_ACCENTS[string]; cards: FileCardItem[] }[] = useMemo(() => {
    const skills = skillData?.skills || [];
    if (skills.length === 0) return [];

    // Group by agent_part
    const grouped: Record<string, IntrospectSkill[]> = {};
    for (const s of skills) {
      const parts = Array.isArray(s.agent_part) ? s.agent_part : [s.agent_part || "motor"];
      for (const part of parts) {
        if (!grouped[part]) grouped[part] = [];
        grouped[part].push(s);
      }
    }

    // Build sections in canonical organ order, then any extras
    const sections: { organ: string; meta: typeof ORGAN_ACCENTS[string]; cards: FileCardItem[] }[] = [];
    const allParts = new Set([...ORGAN_ORDER, ...Object.keys(grouped)]);

    for (const part of allParts) {
      const partSkills = grouped[part];
      if (!partSkills || partSkills.length === 0) continue;

      const meta = ORGAN_ACCENTS[part] || { icon: "🔧", accent: "#566373", label: part };

      const cards: FileCardItem[] = partSkills.map((s) => ({
        key: s.id,
        label: s.name,
        icon: meta.icon,
        role: s.description.slice(0, 100),
        accent: meta.accent,
        content: s.skillMdContent || [
          s.description,
          s.version ? `\nVersion: ${s.version}` : "",
          s.category ? `Category: ${s.category}` : "",
          s.when_to_use ? `\nWhen to use: ${s.when_to_use}` : "",
          s.scripts.length > 0 ? `\nScripts: ${s.scripts.join(", ")}` : "",
        ].filter(Boolean).join("\n"),
      }));

      sections.push({ organ: part, meta, cards });
    }

    return sections;
  }, [skillData]);

  /* ---- Loading skeleton ---- */
  const skeleton = (
    <div className={styles.skeleton}>
      <div className={styles.skeletonLine} />
      <div className={styles.skeletonLine} />
      <div className={styles.skeletonLine} />
    </div>
  );

  return (
    <div className={styles.panel}>
      {/* Sub-tab bar */}
      <div className={styles.subTabBar}>
        {SUB_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`${styles.subTab} ${subTab === tab.key ? styles.subTabActive : ""}`}
            onClick={() => setSubTab(tab.key)}
          >
            <span className={styles.subTabIcon}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={styles.content}>
        {subTab === "brain" && (
          workspaceLoading ? skeleton : <FilePreviewGrid items={brainCards} columns={3} />
        )}
        {subTab === "responsibilities" && (
          respLoading ? skeleton : (
            respCards.length > 0
              ? <FilePreviewGrid items={respCards} columns={3} />
              : <div className={styles.empty}>No responsibilities configured</div>
          )
        )}
        {subTab === "skills" && (
          skillsLoading ? skeleton : (
            skillsByOrgan.length > 0
              ? (
                <div className={styles.organSections}>
                  {skillsByOrgan.map(({ organ, meta, cards }) => (
                    <div key={organ} className={styles.organSection}>
                      <div className={styles.organHeader}>
                        <span
                          className={styles.organAccentBar}
                          style={{ background: meta.accent }}
                        />
                        <span className={styles.organIcon}>{meta.icon}</span>
                        <span className={styles.organLabel}>{meta.label}</span>
                        <span className={styles.organCount}>{cards.length} skill{cards.length !== 1 ? "s" : ""}</span>
                      </div>
                      <FilePreviewGrid items={cards} columns={3} />
                    </div>
                  ))}
                </div>
              )
              : <div className={styles.empty}>No skills installed</div>
          )
        )}
      </div>
    </div>
  );
}
