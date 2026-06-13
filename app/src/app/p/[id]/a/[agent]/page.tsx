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
import { LiveIndicator } from "@/components/LiveIndicator";
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
  { key: "overview", label: "Overview", icon: "📊" },
  { key: "brain", label: "Brain", icon: "🧠" },
  { key: "skills", label: "Skills", icon: "⚡" },
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

/** Specialty → visual theme (same as API route THEMES) */
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
  const [selectedWork, setSelectedWork] = useState<WorkEnvelope | null>(null);

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

  /* ---- Work tab: use existing work hook ---- */
  const work = useWorkEnvelopes(id, agent);

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

  /* ---- Overview tab content ---- */
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

  return (
    <div className={styles.agentPage}>
      {/* ---- Header (with mini card tabs) ---- */}
      <AgentHeader
        primeId={id}
        agentName={agent}
        status={agentData?.status}
        specialty={agentData?.specialty}
        email={agentData?.email}
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
        })()
        )}

        {/* Brain */}
        {activeTab === "brain" && (
          <BrainInspector primeId={id} agentName={agent} />
        )}

        {/* Skills */}
        {activeTab === "skills" && (
          <SkillInventory primeId={id} agentName={agent} />
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

        {/* Responsibilities */}
        {activeTab === "responsibilities" && (
          <ResponsibilityList primeId={id} agentName={agent} />
        )}

        {/* Memory */}
        {activeTab === "memory" && (
          <MemoryViewer primeId={id} agentName={agent} />
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
                      onSelectNode={(id) => {
                        const e = work.allEnvelopes.find((w) => w.id === id) || null;
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
                      onSelectNode={(id) => {
                        const e = work.allEnvelopes.find((w) => w.id === id) || null;
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
                      onSelectNode={(id) => {
                        const e = work.allEnvelopes.find((w) => w.id === id) || null;
                        setSelectedWork(e);
                      }}
                      selectedId={selectedWork?.id || null}
                      onLoadTree={work.loadTree}
                    />
                  </div>
                )}
                {work.current.length === 0 && work.queue.length === 0 && work.previous.length === 0 && (
                  <div className={styles.emptyHint}>No work envelopes found for {agent}</div>
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
  );
}
