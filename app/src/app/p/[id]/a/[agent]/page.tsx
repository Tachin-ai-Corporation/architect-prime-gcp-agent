"use client";

import { use, useState, useEffect } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { BrainInspector } from "@/components/agent/BrainInspector";
import { MemoryViewer } from "@/components/agent/MemoryViewer";
import { AgentProjects } from "@/components/agent/AgentProjects";
import { AgentProcesses } from "@/components/agent/AgentProcesses";
import { ContractsViewer } from "@/components/agent/ContractsViewer";
import { FleetCommsReadOnly } from "@/components/FleetCommsReadOnly";
import { AgentWorkPanel } from "@/components/work/AgentWorkPanel";
import { ApprovalQueue } from "@/components/work/ApprovalQueue";
import { PersonaPanel } from "@/components/agent/PersonaPanel";
import { DeepDiveShell, type DeepDiveTab } from "@/components/agent/DeepDiveShell";
import { useHashTab } from "@/hooks/useHashTab";
import { useIntrospect } from "@/hooks/useIntrospect";
import styles from "./page.module.css";

const TABS = [
  { key: "overview", label: "Persona", icon: "🎭" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "brain", label: "Models", icon: "🧠" },
  { key: "contracts", label: "Contracts", icon: "📄" },
  { key: "approvals", label: "Approvals", icon: "✋" },
  { key: "projects", label: "Projects", icon: "📁" },
  { key: "processes", label: "Processes", icon: "⚙️" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "chat", label: "Comms", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
const TAB_KEYS = TABS.map((t) => t.key) as TabKey[];

/** Default theme for unknown specialties */
const DEFAULT_THEME = { glyph: "🤖", accent: "#94a3b8", name: "Agent" };

export default function AgentDeepDivePage({
  params,
}: {
  params: Promise<{ id: string; agent: string }>;
}) {
  const { id, agent } = use(params);
  const { sidebarFleet } = usePrime();
  const [activeTab, setActiveTab] = useHashTab<TabKey>(TAB_KEYS, "overview");
  const [themeMap, setThemeMap] = useState<Record<string, { glyph: string; accent: string; name: string }>>({});

  /* ---- Fetch agent types for theming ---- */
  useEffect(() => {
    fetch("/api/agent-types")
      .then((r) => r.json())
      .then((data) => {
        const map: Record<string, { glyph: string; accent: string; name: string }> = {};
        for (const t of data.types || []) {
          const entry = { glyph: t.glyph || "🔹", accent: t.accent || "#94a3b8", name: t.title };
          map[t.id] = entry;
          for (const alias of t.aliases || []) {
            map[alias] = entry;
          }
        }
        setThemeMap(map);
      })
      .catch(() => {});
  }, []);

  /* ---- Resolve agent metadata from PrimeContext ---- */
  const fleet = sidebarFleet[id] || [];
  const agentData = fleet.find((a) => a.name === agent);

  /* ---- Overview tab: introspect status + identity ---- */
  const { data: overviewData, loading: overviewLoading } = useIntrospect<{
    workspaces?: Record<string, { name: string; sizeBytes: number }[]>;
    files?: Record<string, string>;
  }>({
    primeId: id,
    agent,
    type: "workspace",
    autoFetch: activeTab === "overview",
  });

  return (
    <DeepDiveShell
      identity={{
        avatarText: agent.charAt(0).toUpperCase(),
        name: agent,
        email: agentData?.email,
        status: agentData?.status || "offline",
        specialty: agentData?.specialty,
      }}
      tabs={TABS as readonly DeepDiveTab[]}
      activeTab={activeTab}
      onTabChange={(k) => setActiveTab(k as TabKey)}
    >
      {/* Overview */}
      {activeTab === "overview" && (() => {
        const theme = themeMap[agentData?.specialty || ""] || DEFAULT_THEME;
        return (
          <div className={styles.overviewWrap}>
            {/* ── Hero Banner ── */}
            <div className={styles.hero}>
              <div
                className={styles.heroAccent}
                style={{ background: `linear-gradient(90deg, ${theme.accent}, ${theme.accent}44)` }}
              />
              <div className={styles.heroGlow} style={{ background: theme.accent }} />
              <div className={styles.heroGlyph}>{theme.glyph}</div>
              <h2 className={styles.heroName} style={{ color: theme.accent }}>
                {theme.name}
              </h2>
              <div className={styles.heroId}>{agentData?.specialty || "unknown"}</div>
            </div>

            {/* ── Persona sub-tabs ── */}
            <PersonaPanel
              primeId={id}
              agentName={agent}
              workspaceFiles={overviewData?.files || {}}
              workspaceLoading={overviewLoading}
            />
          </div>
        );
      })()}

      {/* Brain */}
      {activeTab === "brain" && (
        <BrainInspector primeId={id} agentName={agent} />
      )}

      {/* Projects */}
      {activeTab === "projects" && (
        <AgentProjects primeId={id} agentEmail={agentData?.email || ""} />
      )}

      {/* Processes */}
      {activeTab === "processes" && (
        <AgentProcesses primeId={id} agentEmail={agentData?.email || ""} />
      )}

      {/* Memory */}
      {activeTab === "memory" && (
        <MemoryViewer primeId={id} agentName={agent} />
      )}

      {/* Work */}
      {activeTab === "work" && (
        <AgentWorkPanel primeId={id} agentFilter={agent} />
      )}

      {/* Chat / Comms */}
      {activeTab === "chat" && (
        <div className={styles.chatTabContent}>
          <FleetCommsReadOnly primeId={id} agentName={agent} />
        </div>
      )}

      {/* Contracts — contracts.json viewer (read-only) */}
      {activeTab === "contracts" && <ContractsViewer primeId={id} />}

      {/* Approvals — pending approval queue */}
      {activeTab === "approvals" && <ApprovalQueue primeId={id} />}
    </DeepDiveShell>
  );
}
