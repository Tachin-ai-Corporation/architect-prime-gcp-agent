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

/* ---- Types ---- */
interface Responsibility {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  min_spacing_minutes: number;
  instruction: string;
  has_process: boolean;
  process_steps: number;
  source: string;
}

interface BrainConfig {
  responsibilities: Responsibility[];
  [key: string]: unknown;
}

interface SkillTool {
  name: string;
  description: string;
}

interface Skill {
  name: string;
  description: string;
  version?: string;
  tools: SkillTool[];
  source: string;
}

interface SkillData {
  skills: Skill[];
}

/* ---- Sub-tabs ---- */
const SUB_TABS = [
  { key: "brain", label: "Brain", icon: "🧠" },
  { key: "responsibilities", label: "Responsibilities", icon: "📋" },
  { key: "skills", label: "Skills", icon: "🛠" },
] as const;

type SubTabKey = (typeof SUB_TABS)[number]["key"];

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
      if (r.has_process) lines.push(`Process: ${r.process_steps} steps`);
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

  /* ---- Skill cards ---- */
  const skillCards: FileCardItem[] = useMemo(() => {
    const skills = skillData?.skills || [];
    return skills.map((s) => {
      const lines: string[] = [];
      lines.push(s.description);
      if (s.version) lines.push(`\nVersion: ${s.version}`);
      lines.push(`Source: ${s.source}`);
      if (s.tools.length > 0) {
        lines.push(`\n--- Tools (${s.tools.length}) ---`);
        for (const t of s.tools) {
          lines.push(`• ${t.name}: ${t.description}`);
        }
      }

      return {
        key: s.name,
        label: s.name,
        icon: "🛠",
        role: s.description.slice(0, 80),
        accent: s.source === "installed" ? "#a78bfa" : "#566373",
        content: lines.join("\n"),
      };
    });
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
            skillCards.length > 0
              ? <FilePreviewGrid items={skillCards} columns={3} />
              : <div className={styles.empty}>No skills installed</div>
          )
        )}
      </div>
    </div>
  );
}
