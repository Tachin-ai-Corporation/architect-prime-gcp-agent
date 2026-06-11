"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { usePrime } from "@/contexts/PrimeContext";
import { AgentHeader } from "@/components/agent/AgentHeader";
import { BrainInspector } from "@/components/agent/BrainInspector";
import { SkillInventory } from "@/components/agent/SkillInventory";
import { ResponsibilityList } from "@/components/agent/ResponsibilityList";
import { MemoryViewer } from "@/components/agent/MemoryViewer";
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
  { key: "responsibilities", label: "Responsibilities", icon: "📌" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "chat", label: "Chat", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

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

  return (
    <div className={styles.agentPage}>
      {/* ---- Header ---- */}
      <AgentHeader
        primeId={id}
        agentName={agent}
        status={agentData?.status}
        specialty={agentData?.specialty}
        email={agentData?.email}
      />

      {/* ---- Tab Bar (desktop) ---- */}
      <div className={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ""}`}
            onClick={() => handleTabClick(tab.key)}
          >
            <span className={styles.tabIcon}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Tab Dropdown (mobile) ---- */}
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
        {activeTab === "overview" && (
          <div className={styles.overviewGrid}>
            <div className={styles.overviewCard}>
              <h3 className={styles.overviewCardTitle}>
                Status
                <LiveIndicator
                  lastUpdated={Date.now()}
                  loading={overviewLoading}
                  stale={agentData?.status !== "online"}
                />
              </h3>
              <div className={styles.overviewStatus}>
                <span className={`badge badge-${agentData?.status || "offline"}`}>
                  {agentData?.status || "unknown"}
                </span>
                {agentData?.specialty && (
                  <span className={styles.overviewSpecialty}>{agentData.specialty}</span>
                )}
              </div>
              {prime && (
                <div className={styles.overviewMeta}>
                  <span>Prime: <Link href={`/p/${id}`}>{prime.name}</Link></span>
                  <span>Zone: {prime.zone}</span>
                </div>
              )}
            </div>
            <div className={styles.overviewCard}>
              <h3 className={styles.overviewCardTitle}>Identity</h3>
              {overviewLoading ? (
                <LoadingSkeleton />
              ) : identityMd ? (
                <pre className={styles.identityPre}>{identityMd}</pre>
              ) : (
                <div className={styles.emptyHint}>No IDENTITY.md found</div>
              )}
            </div>
            <div className={styles.overviewCard}>
              <h3 className={styles.overviewCardTitle}>Active Work</h3>
              {work.loading ? (
                <div className={styles.loadingPulse}>Loading…</div>
              ) : work.current.length > 0 ? (
                <div className={styles.overviewWorkList}>
                  {work.current.slice(0, 3).map((w) => (
                    <div key={w.id} className={styles.overviewWorkItem}>
                      <span className={`badge badge-${w.status}`}>{w.status}</span>
                      <span className={styles.overviewWorkTitle}>{w.title || w.type}</span>
                    </div>
                  ))}
                  {work.current.length > 3 && (
                    <button
                      className={styles.overviewMoreBtn}
                      onClick={() => handleTabClick("work")}
                    >
                      +{work.current.length - 3} more →
                    </button>
                  )}
                </div>
              ) : (
                <div className={styles.emptyHint}>No active work</div>
              )}
            </div>
          </div>
        )}

        {/* Brain */}
        {activeTab === "brain" && (
          <BrainInspector primeId={id} agentName={agent} />
        )}

        {/* Skills */}
        {activeTab === "skills" && (
          <SkillInventory primeId={id} agentName={agent} />
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
