"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { usePrime } from "@/contexts/PrimeContext";
import { BrainInspector } from "@/components/agent/BrainInspector";
import { MemoryViewer } from "@/components/agent/MemoryViewer";
import { AgentProjects } from "@/components/agent/AgentProjects";
import { AgentPlans } from "@/components/agent/AgentPlans";
import { AgentProcesses } from "@/components/agent/AgentProcesses";
import { FleetPanel } from "@/components/fleet/FleetPanel";
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

const TABS = [
  { key: "overview", label: "Persona", icon: "🎭" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "brain", label: "Models", icon: "🧠" },
  { key: "fleet", label: "Fleet", icon: "👥" },
  { key: "projects", label: "Projects", icon: "📁" },
  { key: "plans", label: "Plans", icon: "🗺️" },
  { key: "processes", label: "Processes", icon: "⚙️" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "chat", label: "Chat", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function PrimeDeepDivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { primes, sidebarFleet, loading } = usePrime();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  /* ---- Resolve prime data ---- */
  const prime = primes.find((p) => p.id === id);
  const fleet = (sidebarFleet[id] || []).filter((a) => a.status !== "removed");

  /* ---- Introspection target ---- */
  const agentName = `prime-${id}`;
  const agentEmail = `prime-${id}@system`;

  /* ---- Overview tab: introspect workspace ---- */
  const { data: overviewData, loading: overviewLoading } = useIntrospect<{
    workspaces?: Record<string, { name: string; sizeBytes: number }[]>;
    files?: Record<string, string>;
  }>({
    primeId: id,
    agent: agentName,
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

  if (loading) {
    return <div className={styles.loadingPulse}>Loading…</div>;
  }

  if (!prime) {
    return (
      <div className={styles.loadingPulse}>
        Prime not found — <Link href="/">back to dashboard</Link>
      </div>
    );
  }

  return (
    <div className={styles.agentPage}>
      <div className={styles.pageLayout}>
        {/* ---- Left Sidebar ---- */}
        <div className={styles.sidebar}>
          <div className={styles.sidebarIdentity}>
            <div className={styles.sidebarAvatar}>
              {prime.name.charAt(0).toUpperCase()}
            </div>
            <div className={styles.sidebarName}>{prime.name}</div>
            <div className={styles.sidebarEmail}>{agentEmail}</div>
            <div className={styles.sidebarStatus}>
              <span className={`badge badge-${prime.status}`}>
                {prime.status}
              </span>
            </div>
            <div className={styles.sidebarSpecialty}>prime</div>
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
          const theme = { glyph: "🧠", accent: "#22d3ee", name: "Prime Agent" };
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
              <div className={styles.heroId}>prime · {prime.zone}</div>
            </div>

            {/* ── Persona sub-tabs ── */}
            <PersonaPanel
              primeId={id}
              agentName={agentName}
              workspaceFiles={overviewData?.files || {}}
              workspaceLoading={overviewLoading}
            />
          </div>
          );
        })()}

        {/* Brain */}
        {activeTab === "brain" && (
          <BrainInspector primeId={id} agentName={agentName} />
        )}

        {/* Fleet */}
        {activeTab === "fleet" && (
          <FleetPanel primeId={id} />
        )}

        {/* Projects */}
        {activeTab === "projects" && (
          <AgentProjects primeId={id} agentEmail={agentEmail} />
        )}

        {/* Plans */}
        {activeTab === "plans" && (
          <AgentPlans primeId={id} agentEmail={agentEmail} />
        )}

        {/* Processes */}
        {activeTab === "processes" && (
          <AgentProcesses primeId={id} agentEmail={agentEmail} />
        )}
        {/* Memory */}
        {activeTab === "memory" && (
          <MemoryViewer primeId={id} agentName={agentName} />
        )}

        {/* Work */}
        {activeTab === "work" && (
          <AgentWorkPanel primeId={id} agentFilter={agentName} />
        )}

        {/* Chat */}
        {activeTab === "chat" && (
          <div className={styles.chatTabContent}>
            <ChatPanel
              primeId={id}
              agentName={id}
              entityName={id}
              entityStatus={prime.status}
              specialty="prime"
              inline
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
