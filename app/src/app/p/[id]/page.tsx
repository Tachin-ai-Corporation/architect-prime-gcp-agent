"use client";

import { use } from "react";
import Link from "next/link";
import { usePrime } from "@/contexts/PrimeContext";
import { BrainInspector } from "@/components/agent/BrainInspector";
import { MemoryViewer } from "@/components/agent/MemoryViewer";
import { AgentProjects } from "@/components/agent/AgentProjects";
import { AgentProcesses } from "@/components/agent/AgentProcesses";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { ChatPanel } from "@/components/ChatPanel";
import { AgentWorkPanel } from "@/components/work/AgentWorkPanel";
import { PersonaPanel } from "@/components/agent/PersonaPanel";
import { ConfigViewer } from "@/components/agent/ConfigViewer";
import { DeepDiveShell, type DeepDiveTab } from "@/components/agent/DeepDiveShell";
import { useHashTab } from "@/hooks/useHashTab";
import { useIntrospect } from "@/hooks/useIntrospect";
import styles from "./page.module.css";

const TABS = [
  { key: "overview", label: "Persona", icon: "🎭" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "brain", label: "Models", icon: "🧠" },
  { key: "fleet", label: "Fleet", icon: "👥" },
  { key: "projects", label: "Projects", icon: "📁" },
  { key: "processes", label: "Processes", icon: "⚙️" },
  { key: "config", label: "Config", icon: "🔧" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "chat", label: "Chat", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
const TAB_KEYS = TABS.map((t) => t.key) as TabKey[];

export default function PrimeDeepDivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { primes, loading } = usePrime();
  const [activeTab, setActiveTab] = useHashTab<TabKey>(TAB_KEYS, "overview");

  /* ---- Resolve prime data ---- */
  const prime = primes.find((p) => p.id === id);

  /* ---- Introspection target ---- */
  const agentName = `prime-${id}`;
  // Internal scoping key for prime-owned projects/processes (not shown to the user).
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
    <DeepDiveShell
      identity={{
        avatarText: prime.name.charAt(0).toUpperCase(),
        name: prime.name,
        status: prime.status,
        specialty: "prime",
      }}
      tabs={TABS as readonly DeepDiveTab[]}
      activeTab={activeTab}
      onTabChange={(k) => setActiveTab(k as TabKey)}
    >
      {/* Overview */}
      {activeTab === "overview" && (() => {
        const theme = { glyph: "🧠", accent: "#22d3ee", name: prime.name };
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
      {activeTab === "fleet" && <FleetPanel primeId={id} />}

      {/* Projects */}
      {activeTab === "projects" && (
        <AgentProjects primeId={id} agentEmail={agentEmail} />
      )}

      {/* Processes */}
      {activeTab === "processes" && (
        <AgentProcesses primeId={id} agentEmail={agentEmail} />
      )}

      {/* Memory */}
      {activeTab === "memory" && (
        <MemoryViewer primeId={id} agentName={agentName} />
      )}

      {/* Config */}
      {activeTab === "config" && <ConfigViewer primeId={id} />}

      {/* Work */}
      {activeTab === "work" && (
        <AgentWorkPanel primeId={id} agentFilter={agentName} />
      )}

      {/* Chat */}
      {activeTab === "chat" && (
        <div className={styles.chatTabContent}>
          <ChatPanel
            primeId={id}
            entityName={id}
            entityStatus={prime.status}
            specialty="prime"
            inline
          />
        </div>
      )}
    </DeepDiveShell>
  );
}
