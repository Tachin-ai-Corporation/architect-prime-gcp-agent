"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { usePrime } from "@/contexts/PrimeContext";
import { AgentHeader } from "@/components/agent/AgentHeader";
import { BrainInspector } from "@/components/agent/BrainInspector";
import { SkillInventory } from "@/components/agent/SkillInventory";
import { ResponsibilityList } from "@/components/agent/ResponsibilityList";
import { MemoryViewer } from "@/components/agent/MemoryViewer";
import { AgentProjects } from "@/components/agent/AgentProjects";
import { AgentPlans } from "@/components/agent/AgentPlans";
import { AgentProcesses } from "@/components/agent/AgentProcesses";
import { ChatPanel } from "@/components/ChatPanel";
import { WorkTree } from "@/components/work/WorkTree";
import { WorkDetail } from "@/components/work/WorkDetail";
import { useWorkEnvelopes } from "@/components/work/useWorkEnvelopes";
import { useIntrospect } from "@/hooks/useIntrospect";
import type { WorkEnvelope } from "@/lib/types";
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
  { key: "overview", label: "Overview", icon: "📊" },
  { key: "brain", label: "Brain", icon: "🧠" },
  { key: "skills", label: "Skills", icon: "⚡" },
  { key: "fleet", label: "Fleet", icon: "👥" },
  { key: "projects", label: "Projects", icon: "📁" },
  { key: "plans", label: "Plans", icon: "🗺️" },
  { key: "processes", label: "Processes", icon: "⚙️" },
  { key: "responsibilities", label: "Responsibilities", icon: "📌" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "chat", label: "Chat", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const BRAIN_ORGANS = [
  { key: "cortex", label: "Cortex", icon: "🧠", filePath: "SOUL.md", role: "the voice: classify, decide, synthesize", accent: "var(--signal-aqua)" },
  { key: "prefrontal", label: "Prefrontal", icon: "🏗️", filePath: "workspace-prefrontal/SOUL.md", role: "the structurer: M→C→T blueprints", accent: "#a78bfa" },
  { key: "motor", label: "Motor", icon: "⚡", filePath: "workspace-motor/SOUL.md", role: "the hands: tools, exec, files", accent: "#fbbf24" },
  { key: "cerebellum", label: "Cerebellum", icon: "🔄", filePath: "workspace-cerebellum/SOUL.md", role: "the conscience: independent verification", accent: "#2dd4bf" },
  { key: "temporal-memory", label: "Temporal-Memory", icon: "💾", filePath: "workspace-temporal-memory/SOUL.md", role: "internal recall, no external APIs", accent: "#818cf8" },
  { key: "temporal-research", label: "Temporal-Research", icon: "🔍", filePath: "workspace-temporal-research/SOUL.md", role: "external info: grounding + fetch", accent: "#38bdf8" },
];

/** Prime theme */
const PRIME_THEME = { glyph: "🧠", accent: "#22d3ee", name: "Prime Orchestrator" };

export default function PrimeDeepDivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { primes, sidebarFleet, loading } = usePrime();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [selectedWork, setSelectedWork] = useState<WorkEnvelope | null>(null);

  /* ---- Resolve prime data ---- */
  const prime = primes.find((p) => p.id === id);
  const fleet = (sidebarFleet[id] || []).filter((a) => a.status !== "removed");

  /* ---- Introspection target: the prime VM registers as prime-{name} ---- */
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

  /* ---- Work tab ---- */
  const work = useWorkEnvelopes(id, agentName);

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

  /* ---- Overview: Identity & Memory ---- */
  const identityMd = overviewData?.files?.["IDENTITY.md"] || null;
  const memoryMd = overviewData?.files?.["MEMORY.md"] || null;
  const [expandedOrgans, setExpandedOrgans] = useState<Set<string>>(new Set());

  const toggleOrgan = (key: string) => {
    setExpandedOrgans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
      {/* ---- Header (with mini card tabs) ---- */}
      <AgentHeader
        primeId={id}
        agentName={prime.name}
        status={prime.status}
        specialty="prime"
        email={agentEmail}
        tabs={TABS as unknown as { key: string; label: string; icon: string }[]}
        activeTab={activeTab}
        onTabClick={(key) => handleTabClick(key as TabKey)}
      />

      {/* ---- Tab Dropdown (mobile only) ---- */}
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

      {/* ---- Tab Content ---- */}
      <div className={styles.tabContentArea}>
        {/* Overview */}
        {activeTab === "overview" && (() => {
          const theme = PRIME_THEME;
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

            {/* ── Identity + Working Memory ── */}
            <div>
              <h3 className={styles.sectionHeading}>
                <span className={styles.sectionIcon}>📄</span> Identity &amp; Working Memory
              </h3>
              <div className={styles.twoColGrid}>
                <div className={styles.twoColCard}>
                  <h4 className={styles.twoColCardTitle}>IDENTITY.md</h4>
                  {overviewLoading ? (
                    <LoadingSkeleton />
                  ) : identityMd ? (
                    <pre className={styles.identityPre}>{identityMd}</pre>
                  ) : (
                    <div className={styles.emptyHint}>No IDENTITY.md found</div>
                  )}
                </div>
                <div className={styles.twoColCard}>
                  <h4 className={styles.twoColCardTitle}>MEMORY.md</h4>
                  {overviewLoading ? (
                    <LoadingSkeleton />
                  ) : memoryMd ? (
                    <pre className={styles.identityPre}>{memoryMd}</pre>
                  ) : (
                    <div className={styles.emptyHint}>No MEMORY.md found</div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Brain Architecture ── */}
            <div>
              <h3 className={styles.sectionHeading}>
                <span className={styles.sectionIcon}>🧬</span> Brain Architecture
              </h3>
              {overviewLoading ? (
                <LoadingSkeleton />
              ) : (
                <div className={styles.organGrid}>
                  {BRAIN_ORGANS.map((organ) => {
                    const content = overviewData?.files?.[organ.filePath] ?? null;
                    const isExpanded = expandedOrgans.has(organ.key);
                    const hasContent = content !== null;

                    return (
                      <div
                        key={organ.key}
                        className={
                          hasContent
                            ? `${styles.organCard}${isExpanded ? ` ${styles.organCardExpanded}` : ""}`
                            : styles.organCardDisabled
                        }
                        style={{ "--organ-accent": organ.accent } as React.CSSProperties}
                        onClick={() => hasContent && toggleOrgan(organ.key)}
                      >
                        <div className={styles.organHeader}>
                          <span className={styles.organIcon}>{organ.icon}</span>
                          <span className={styles.organLabel}>{organ.label}</span>
                          {hasContent && (
                            <span
                              className={`${styles.organExpandIcon}${isExpanded ? ` ${styles.organExpandIconOpen}` : ""}`}
                            >
                              ▾
                            </span>
                          )}
                        </div>
                        <div className={styles.organRole}>{organ.role}</div>
                        {hasContent ? (
                          <pre
                            className={`${styles.organPreview}${isExpanded ? ` ${styles.organFull}` : ""}`}
                          >
                            {isExpanded ? content : content.slice(0, 400)}
                          </pre>
                        ) : (
                          <div className={styles.organEmptyHint}>Not found on agent</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          );
        })()}

        {/* Brain */}
        {activeTab === "brain" && (
          <BrainInspector primeId={id} agentName={agentName} />
        )}

        {/* Skills */}
        {activeTab === "skills" && (
          <SkillInventory primeId={id} agentName={agentName} />
        )}

        {/* Fleet */}
        {activeTab === "fleet" && (
          <div className={styles.overviewWrap}>
            <Link href={`/p/${id}/fleet`} className={styles.fleetLinkCard}>
              <span className={styles.fleetLinkIcon}>👥</span>
              <div className={styles.fleetLinkBody}>
                <span className={styles.fleetLinkTitle}>Manage Fleet</span>
                <span className={styles.fleetLinkDesc}>
                  View and manage all fleet agents for this prime
                </span>
              </div>
              <span className={styles.fleetLinkBadge}>{fleet.length}</span>
              <span className={styles.fleetLinkArrow}>→</span>
            </Link>
          </div>
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

        {/* Responsibilities */}
        {activeTab === "responsibilities" && (
          <ResponsibilityList primeId={id} agentName={agentName} />
        )}

        {/* Memory */}
        {activeTab === "memory" && (
          <MemoryViewer primeId={id} agentName={agentName} />
        )}

        {/* Work */}
        {activeTab === "work" && (
          <div className={styles.workTabContent}>
            {work.loading ? (
              <div className={styles.loadingPulse}>Loading work envelopes…</div>
            ) : (
              <>
                {work.current.length > 0 && (
                  <div className={styles.workSection}>
                    <h3 className={styles.workSectionTitle}>Currently Working On</h3>
                    <WorkTree
                      nodes={work.current}
                      onSelectNode={(nodeId) => {
                        const e = work.allEnvelopes.find((w) => w.id === nodeId) || null;
                        setSelectedWork(e);
                      }}
                      selectedId={selectedWork?.id || null}
                      onLoadTree={work.loadTree}
                    />
                  </div>
                )}
                {work.queue.length > 0 && (
                  <div className={styles.workSection}>
                    <h3 className={styles.workSectionTitle}>In Queue</h3>
                    <WorkTree
                      nodes={work.queue}
                      onSelectNode={(nodeId) => {
                        const e = work.allEnvelopes.find((w) => w.id === nodeId) || null;
                        setSelectedWork(e);
                      }}
                      selectedId={selectedWork?.id || null}
                      onLoadTree={work.loadTree}
                    />
                  </div>
                )}
                {work.previous.length > 0 && (
                  <div className={styles.workSection}>
                    <h3 className={styles.workSectionTitle}>Previous Work</h3>
                    <WorkTree
                      nodes={work.previous.slice(0, 10)}
                      onSelectNode={(nodeId) => {
                        const e = work.allEnvelopes.find((w) => w.id === nodeId) || null;
                        setSelectedWork(e);
                      }}
                      selectedId={selectedWork?.id || null}
                      onLoadTree={work.loadTree}
                    />
                  </div>
                )}
                {work.current.length === 0 && work.queue.length === 0 && work.previous.length === 0 && (
                  <div className={styles.emptyHint}>No work envelopes found for {agentName}</div>
                )}
              </>
            )}
            {selectedWork && (
              <WorkDetail
                envelope={selectedWork}
                allEnvelopes={work.allEnvelopes}
                primeId={id}
                onClose={() => setSelectedWork(null)}
              />
            )}
          </div>
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
  );
}
