"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { usePrime } from "@/contexts/PrimeContext";
import { BrainInspector } from "@/components/agent/BrainInspector";
import { MemoryViewer } from "@/components/agent/MemoryViewer";
import { AgentProjects } from "@/components/agent/AgentProjects";
import { AgentPlans } from "@/components/agent/AgentPlans";
import { AgentProcesses } from "@/components/agent/AgentProcesses";
import { LiveIndicator } from "@/components/LiveIndicator";
import { ChatPanel } from "@/components/ChatPanel";
import { AgentWorkPanel } from "@/components/work/AgentWorkPanel";
import { PersonaPanel } from "@/components/agent/PersonaPanel";
import { useIntrospect } from "@/hooks/useIntrospect";
import styles from "./page.module.css";

/* ---- Skeleton helper ---- */
function LoadingSkeleton() {
  return (
    <div className={styles.skeleton}>
      <div className={styles.skeletonLine} />
      <div className={styles.skeletonLine} />
      <div className={styles.skeletonLine} />
      <div className={styles.skeletonLine} />
      <div className={styles.skeletonLine} />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className={styles.errorState}>
      <div className={styles.errorIcon}>⚠️</div>
      <div className={styles.errorTitle}>Failed to load</div>
      <div className={styles.errorDesc}>
        {message || "The agent may be offline or the introspection request timed out."}
      </div>
      {onRetry && (
        <button className={styles.errorRetryBtn} onClick={onRetry}>
          ↻ Retry
        </button>
      )}
    </div>
  );
}

const TABS = [
  { key: "overview", label: "Persona", icon: "🎭" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "brain", label: "Brain", icon: "🧠" },
  { key: "projects", label: "Projects", icon: "📁" },
  { key: "plans", label: "Plans", icon: "🗺️" },
  { key: "processes", label: "Processes", icon: "⚙️" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "chat", label: "Chat", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** Specialty → visual theme */
const SPECIALTY_THEMES: Record<string, { glyph: string; accent: string; name: string }> = {
  devops:              { glyph: "⚙️", accent: "#38bdf8", name: "DevOps Engineer" },
  engineer:            { glyph: "🧪", accent: "#a78bfa", name: "Software Engineer" },
  swe:                 { glyph: "🧪", accent: "#a78bfa", name: "Software Engineer" },
  qa:                  { glyph: "🧭", accent: "#2dd4bf", name: "QA Engineer" },
  pm:                  { glyph: "🗂️", accent: "#fbbf24", name: "Project Manager" },
  finance:             { glyph: "📊", accent: "#34d399", name: "Finance Analyst" },
  data:                { glyph: "🧮", accent: "#818cf8", name: "Data Analyst" },
  security:            { glyph: "🛡️", accent: "#fb7185", name: "Security Engineer" },
  assistant:           { glyph: "🎯", accent: "#94a3b8", name: "Assistant" },
  "product-architect": { glyph: "📐", accent: "#f472b6", name: "Product Architect" },
};


export default function AgentDeepDivePage({
  params,
}: {
  params: Promise<{ id: string; agent: string }>;
}) {
  const { id, agent } = use(params);
  const { primes, sidebarFleet } = usePrime();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

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
          const theme = SPECIALTY_THEMES[agentData?.specialty || ""] || { glyph: "🤖", accent: "#94a3b8", name: agentData?.specialty || "Agent" };
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

        {/* Chat */}
        {activeTab === "chat" && (
          <div className={styles.chatTabContent}>
            <ChatPanel
              primeId={id}
              agentName={agent}
              entityName={agent}
              entityStatus={agentData?.status}
              specialty={agentData?.specialty}
              inline
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
