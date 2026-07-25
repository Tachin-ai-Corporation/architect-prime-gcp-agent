"use client";

import { use, useState, useEffect } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { BrainInspector } from "@/components/agent/BrainInspector";
import { MemoryViewer } from "@/components/agent/MemoryViewer";
import { AgentProjects } from "@/components/agent/AgentProjects";
import { AgentPlans } from "@/components/agent/AgentPlans";
import { AgentProcesses } from "@/components/agent/AgentProcesses";
import { ContractsViewer } from "@/components/agent/ContractsViewer";
import { ChatPanel } from "@/components/ChatPanel";
import { FleetCommsReadOnly } from "@/components/FleetCommsReadOnly";
import { AgentWorkPanel } from "@/components/work/AgentWorkPanel";
import { ApprovalQueue } from "@/components/work/ApprovalQueue";
import { PersonaPanel } from "@/components/agent/PersonaPanel";
import { useIntrospect } from "@/hooks/useIntrospect";
import styles from "./page.module.css";

const TABS = [
  { key: "overview", label: "Persona", icon: "🎭" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "brain", label: "Models", icon: "🧠" },
  { key: "contracts", label: "Contracts", icon: "📄" },
  { key: "approvals", label: "Approvals", icon: "✋" },
  { key: "projects", label: "Projects", icon: "📁" },
  { key: "plans", label: "Plans", icon: "🗺️" },
  { key: "processes", label: "Processes", icon: "⚙️" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "chat", label: "Comms", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** Default theme for unknown specialties */
const DEFAULT_THEME = { glyph: "🤖", accent: "#94a3b8", name: "Agent" };

interface AgentTypeTheme {
  id: string;
  title: string;
  glyph: string;
  accent: string;
  aliases?: string[];
}

export default function AgentDeepDivePage({
  params,
}: {
  params: Promise<{ id: string; agent: string }>;
}) {
  const { id, agent } = use(params);
  const { primes, sidebarFleet } = usePrime();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
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
  const prime = primes.find((p) => p.id === id);
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

  /* ---- Hash-based tab switching ---- */
  useEffect(() => {
    const readHash = () => {
      const hash = window.location.hash.replace("#", "");
      if (TABS.some((t) => t.key === hash)) {
        setActiveTab(hash as TabKey);
      }
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const handleTabClick = (key: TabKey) => {
    setActiveTab(key);
    window.location.hash = key;
  };

  return (
    <div className={styles.agentPage}>
      <div className={styles.pageLayout}>
        {/* ---- Left Sidebar ---- */}
        <div className={styles.sidebar}>
          <div className={styles.sidebarIdentity}>
            <div className={styles.sidebarAvatar}>
              {agent.charAt(0).toUpperCase()}
            </div>
            <div className={styles.sidebarName}>{agent}</div>
            {agentData?.email && (
              <div className={styles.sidebarEmail}>{agentData.email}</div>
            )}
            <div className={styles.sidebarStatus}>
              <span className={`badge badge-${agentData?.status || "offline"}`}>
                {agentData?.status || "unknown"}
              </span>
            </div>
            {agentData?.specialty && (
              <div className={styles.sidebarSpecialty}>{agentData.specialty}</div>
            )}
          </div>
          <div className={styles.sidebarDivider} />
          <nav className={styles.sidebarNav}>
            {TABS.map((tab, i) => (
              <button
                key={tab.key}
                className={`${styles.sidebarNavItem}${activeTab === tab.key ? ` ${styles.sidebarNavItemActive}` : ""}`}
                onClick={() => handleTabClick(tab.key)}
                style={i === 2 ? { marginTop: 8 } : undefined}
              >
                <span className={styles.sidebarNavIcon}>{tab.icon}</span>
                <span className={styles.sidebarNavLabel}>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* ---- Mobile Tab Dropdown ---- */}
        <div className={styles.tabDropdownWrap}>
          <select
            className={styles.tabDropdown}
            value={activeTab}
            onChange={(e) => handleTabClick(e.target.value as TabKey)}
          >
            {TABS.map((tab) => (
              <option key={tab.key} value={tab.key}>
                {tab.icon} {tab.label}
              </option>
            ))}
          </select>
        </div>

        {/* ---- Main Content ---- */}
        <div className={styles.mainContent}>
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
              <div
                className={styles.heroGlow}
                style={{ background: theme.accent }}
              />
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

        {/* Plans */}
        {activeTab === "plans" && (
          <AgentPlans primeId={id} agentEmail={agentData?.email || ""} />
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
            <FleetCommsReadOnly
              primeId={id}
              agentName={agent}
            />
          </div>
        )}

        {/* Contracts — contracts.json viewer (read-only) */}
        {activeTab === "contracts" && (
          <ContractsViewer primeId={id} />
        )}

        {/* Approvals — pending approval queue */}
        {activeTab === "approvals" && (
          <ApprovalQueue primeId={id} />
        )}
        </div>
      </div>
    </div>
  );
}
