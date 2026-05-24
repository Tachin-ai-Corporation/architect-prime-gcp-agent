"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { useWorkEnvelopes } from "@/components/work/useWorkEnvelopes";
import { WorkTree } from "@/components/work/WorkTree";
import { WorkDetail } from "@/components/work/WorkDetail";

/* ---- Tab types ---- */
type TabId = "current" | "queue" | "previous";

const PAGE_SIZE = 10;

export default function WorkPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { primes, sidebarFleet } = usePrime();
  const prime = primes.find((p) => p.id === id);
  const fleet = sidebarFleet[id] || [];

  /* ---- Agent filter ---- */
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  /* ---- Data hook ---- */
  const { current, queue, previous, allEnvelopes, loading } = useWorkEnvelopes(
    id,
    selectedAgent
  );

  /* ---- UI state ---- */
  const [activeTab, setActiveTab] = useState<TabId>("current");
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [prevPage, setPrevPage] = useState(0);
  const [primeDropdownOpen, setPrimeDropdownOpen] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);

  /* ---- Close prime dropdown on outside click ---- */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setPrimeDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ---- Computed ---- */
  const needsInputCount = useMemo(
    () => allEnvelopes.filter((e) => e.status === "needs_input" || e.status === "waiting").length,
    [allEnvelopes]
  );

  const selectedEnvelope = useMemo(
    () => allEnvelopes.find((e) => e.id === selectedWorkId) ?? null,
    [allEnvelopes, selectedWorkId]
  );

  /* ---- Agent strip data ---- */
  const agentInfo = useMemo(() => {
    const agents = fleet.filter((a) => a.status !== "removed");
    return agents.map((agent) => {
      const activeTask = allEnvelopes.find(
        (e) =>
          e.owner === agent.name &&
          (e.status === "active" || e.status === "waiting")
      );
      return {
        name: agent.name,
        working: agent.status === "online" && !!activeTask,
        doing: activeTask
          ? truncate(activeTask.intent || activeTask.instruction, 30)
          : `Idle`,
        status: agent.status,
      };
    });
  }, [fleet, allEnvelopes]);

  /* ---- Previous work pagination ---- */
  const totalPrevPages = Math.ceil(previous.length / PAGE_SIZE);
  const prevSlice = previous.slice(prevPage * PAGE_SIZE, (prevPage + 1) * PAGE_SIZE);

  /* ---- Handlers ---- */
  const handleSelectAgent = useCallback(
    (name: string) => {
      setSelectedAgent((prev) => (prev === name ? null : name));
      setActiveTab("current");
      setPrevPage(0);
    },
    []
  );

  const handleSelectTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    if (tab !== "previous") setPrevPage(0);
  }, []);

  const handleSelectNode = useCallback((nodeId: string) => {
    setSelectedWorkId(nodeId);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedWorkId(null);
  }, []);

  const handleSwitchPrime = useCallback(
    (primeId: string) => {
      setPrimeDropdownOpen(false);
      if (primeId !== id) {
        router.push(`/p/${primeId}/work`);
      }
    },
    [id, router]
  );

  /* ---- Loading state ---- */
  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.loading}>
          <span className={styles.loadingDots}>Loading work tree…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      {/* ---- Back link ---- */}
      <Link href={`/p/${id}`} className={styles.backLink}>
        ← Back to Hub
      </Link>

      {/* ---- Page Header ---- */}
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Work</h1>

        {/* Needs input pill */}
        {needsInputCount > 0 && (
          <span className={styles.needsPill}>⚡ {needsInputCount} needs input</span>
        )}

        {/* Prime selector */}
        {primes.length > 1 && (
          <div className={styles.primeSelector} ref={dropdownRef}>
            <button
              className={styles.primeSelectorBtn}
              onClick={() => setPrimeDropdownOpen((v) => !v)}
            >
              {prime?.name || id}
              <span
                className={`${styles.primeSelectorChev} ${primeDropdownOpen ? styles.primeSelectorChevOpen : ""}`}
              >
                ▾
              </span>
            </button>
            {primeDropdownOpen && (
              <div className={styles.primeSelectorDropdown}>
                {primes.map((p) => (
                  <button
                    key={p.id}
                    className={`${styles.primeSelectorItem} ${p.id === id ? styles.primeSelectorItemActive : ""}`}
                    onClick={() => handleSwitchPrime(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.pgSub}>
        {selectedAgent
          ? `Showing work for ${selectedAgent}`
          : "Select an agent to filter, or view all work"}
      </div>

      {/* ---- Agent Strip ---- */}
      {agentInfo.length > 0 && (
        <div className={styles.agents}>
          {agentInfo.map((agent) => (
            <button
              key={agent.name}
              className={`${styles.ag} ${selectedAgent === agent.name ? styles.agSel : ""}`}
              onClick={() => handleSelectAgent(agent.name)}
            >
              <span
                className={`${styles.agDot} ${agent.working ? styles.agDotOn : styles.agDotIdle}`}
              />
              <div className={styles.agInfo}>
                <span className={styles.agName}>{agent.name}</span>
                <span className={agent.working ? styles.agDoing : styles.agIdle}>
                  {agent.doing}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ---- Tabs ---- */}
      <div className={styles.workPanel}>
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${activeTab === "current" ? styles.tabOn : ""}`}
            onClick={() => handleSelectTab("current")}
          >
            Currently working on
            <span className={`${styles.badge} ${styles.badgeTeal}`}>
              {current.length}
            </span>
          </button>
          <button
            className={`${styles.tab} ${activeTab === "queue" ? styles.tabOn : ""}`}
            onClick={() => handleSelectTab("queue")}
          >
            In Queue
            <span className={`${styles.badge} ${styles.badgeSlate}`}>
              {queue.length}
            </span>
          </button>
          <button
            className={`${styles.tab} ${activeTab === "previous" ? styles.tabOn : ""}`}
            onClick={() => handleSelectTab("previous")}
          >
            Previous Work
            <span className={`${styles.badge} ${styles.badgeSlate}`}>
              {previous.length}
            </span>
          </button>
        </div>

        {/* ---- Tab bodies ---- */}

        {/* Current */}
        <div className={activeTab === "current" ? styles.tabBodyVis : styles.tabBody}>
          {current.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>◎</div>
              <div className={styles.emptyTitle}>No active work</div>
              <div className={styles.emptySub}>
                Active missions and tasks will appear here
              </div>
            </div>
          ) : (
            <WorkTree
              nodes={current}
              onSelectNode={handleSelectNode}
              selectedId={selectedWorkId}
            />
          )}
        </div>

        {/* Queue */}
        <div className={activeTab === "queue" ? styles.tabBodyVis : styles.tabBody}>
          {queue.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>◎</div>
              <div className={styles.emptyTitle}>Queue is empty</div>
              <div className={styles.emptySub}>
                Pending work will appear here
              </div>
            </div>
          ) : (
            <WorkTree
              nodes={queue}
              onSelectNode={handleSelectNode}
              selectedId={selectedWorkId}
            />
          )}
        </div>

        {/* Previous */}
        <div className={activeTab === "previous" ? styles.tabBodyVis : styles.tabBody}>
          {previous.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>◎</div>
              <div className={styles.emptyTitle}>No previous work</div>
              <div className={styles.emptySub}>
                Completed missions will appear here
              </div>
            </div>
          ) : (
            <>
              <WorkTree
                nodes={prevSlice}
                onSelectNode={handleSelectNode}
                selectedId={selectedWorkId}
              />
              {totalPrevPages > 1 && (
                <div className={styles.pager}>
                  <button
                    className={styles.pgBtn}
                    disabled={prevPage === 0}
                    onClick={() => setPrevPage((p) => Math.max(0, p - 1))}
                  >
                    ← Prev
                  </button>
                  <span className={styles.pgInfo}>
                    {prevPage + 1} / {totalPrevPages}
                  </span>
                  <button
                    className={styles.pgBtn}
                    disabled={prevPage >= totalPrevPages - 1}
                    onClick={() => setPrevPage((p) => Math.min(totalPrevPages - 1, p + 1))}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ---- Detail Modal ---- */}
      <WorkDetail
        envelope={selectedEnvelope}
        allEnvelopes={allEnvelopes}
        onClose={handleCloseDetail}
        primeId={id}
      />
    </div>
  );
}

/* ---- Helpers ---- */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
