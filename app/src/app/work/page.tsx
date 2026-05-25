"use client";

import { Suspense, useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { useWorkEnvelopes, matchAgent } from "@/components/work/useWorkEnvelopes";
import { WorkTree } from "@/components/work/WorkTree";
import { WorkDetail } from "@/components/work/WorkDetail";
import { api } from "@/lib/api";

/* ---- Tab types ---- */
type TabId = "current" | "queue" | "previous";

const PAGE_SIZE = 10;

export default function WorkPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <WorkPage />
    </Suspense>
  );
}

function WorkPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { primes, sidebarFleet } = usePrime();

  /* ---- Prime selection from URL param or first available ---- */
  const paramPrime = searchParams.get("prime");
  const paramAgent = searchParams.get("agent");

  const selectedPrimeId = paramPrime && primes.find((p) => p.id === paramPrime)
    ? paramPrime
    : primes[0]?.id || null;

  const fleet = selectedPrimeId ? sidebarFleet[selectedPrimeId] || [] : [];

  /* ---- Agent filter — from URL param or local state ---- */
  const [localAgent, setLocalAgent] = useState<string | null>(paramAgent || null);

  // Sync URL param on mount / change
  useEffect(() => {
    if (paramAgent) setLocalAgent(paramAgent);
  }, [paramAgent]);

  const selectedAgent = localAgent;

  /* ---- Data hook ---- */
  const { current, queue, previous, allEnvelopes, loading } = useWorkEnvelopes(
    selectedPrimeId,
    selectedAgent
  );

  /* ---- UI state ---- */
  const [activeTab, setActiveTab] = useState<TabId>("current");
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [prevPage, setPrevPage] = useState(0);
  const [primeDropdownOpen, setPrimeDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [projects, setProjects] = useState<{id: string; name: string}[]>([]);

  /* ---- Project filter (client-side) ---- */
  const filteredEnvelopes = useMemo(() => {
    if (!projectFilter) return { current, queue, previous };
    const filterFn = (nodes: typeof current) => nodes.filter(n =>
      projectFilter === '__none__' ? !(n as any).project_id : (n as any).project_id === projectFilter
    );
    return {
      current: filterFn(current),
      queue: filterFn(queue),
      previous: filterFn(previous),
    };
  }, [current, queue, previous, projectFilter]);

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

  /* ---- Fetch projects ---- */
  useEffect(() => {
    if (!selectedPrimeId) return;
    api<{ projects: { id: string; name: string }[] }>(`/api/primes/${selectedPrimeId}/projects`)
      .then((data) => {
        if (data?.projects) setProjects(data.projects);
      });
  }, [selectedPrimeId]);

  /* ---- Update URL params helper ---- */
  const updateParams = useCallback(
    (prime: string | null, agent: string | null) => {
      const params = new URLSearchParams();
      if (prime) params.set("prime", prime);
      if (agent) params.set("agent", agent);
      const qs = params.toString();
      router.replace(`/work${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router]
  );

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
          matchAgent(e.owner, agent.name) &&
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
  const totalPrevPages = Math.ceil(filteredEnvelopes.previous.length / PAGE_SIZE);
  const filteredPrevSlice = filteredEnvelopes.previous.slice(prevPage * PAGE_SIZE, (prevPage + 1) * PAGE_SIZE);

  /* ---- Handlers ---- */
  const handleSelectAgent = useCallback(
    (name: string) => {
      const next = localAgent === name ? null : name;
      setLocalAgent(next);
      setActiveTab("current");
      setPrevPage(0);
      updateParams(selectedPrimeId, next);
    },
    [localAgent, selectedPrimeId, updateParams]
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
      setLocalAgent(null);
      setActiveTab("current");
      setPrevPage(0);
      updateParams(primeId, null);
    },
    [updateParams]
  );

  /* ---- Loading state ---- */
  if (loading && !allEnvelopes.length) {
    return (
      <div className={styles.shell}>
        <div className={styles.loading}>
          <span className={styles.loadingDots}>Loading work tree…</span>
        </div>
      </div>
    );
  }

  const prime = primes.find((p) => p.id === selectedPrimeId);

  return (
    <div className={styles.shell}>
      {/* ---- Page Header ---- */}
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Work</h1>

        {/* Needs input pill */}
        {needsInputCount > 0 && (
          <span className={styles.needsPill}>⚡ {needsInputCount} needs input</span>
        )}

        {/* Prime selector */}
        {primes.length > 0 && (
          <div className={styles.primeSelector} ref={dropdownRef}>
            <button
              className={styles.primeSelectorBtn}
              onClick={() => setPrimeDropdownOpen((v) => !v)}
            >
              {prime?.name || selectedPrimeId || "Select Prime"}
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
                    className={`${styles.primeSelectorItem} ${p.id === selectedPrimeId ? styles.primeSelectorItemActive : ""}`}
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

      {/* ---- Project Filter ---- */}
      {projects.length > 0 && (
        <div className={styles.projectFilter}>
          <select
            className={styles.projectSelect}
            value={projectFilter || ""}
            onChange={(e) => setProjectFilter(e.target.value || null)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value="__none__">No project</option>
          </select>
        </div>
      )}

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
              {filteredEnvelopes.current.length}
            </span>
          </button>
          <button
            className={`${styles.tab} ${activeTab === "queue" ? styles.tabOn : ""}`}
            onClick={() => handleSelectTab("queue")}
          >
            In Queue
            <span className={`${styles.badge} ${styles.badgeSlate}`}>
              {filteredEnvelopes.queue.length}
            </span>
          </button>
          <button
            className={`${styles.tab} ${activeTab === "previous" ? styles.tabOn : ""}`}
            onClick={() => handleSelectTab("previous")}
          >
            Previous Work
            <span className={`${styles.badge} ${styles.badgeSlate}`}>
              {filteredEnvelopes.previous.length}
            </span>
          </button>
        </div>

        {/* ---- Tab bodies ---- */}

        {/* Current */}
        <div className={activeTab === "current" ? styles.tabBodyVis : styles.tabBody}>
          {filteredEnvelopes.current.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>◎</div>
              <div className={styles.emptyTitle}>No active work</div>
              <div className={styles.emptySub}>
                Active missions and tasks will appear here
              </div>
            </div>
          ) : (
            <WorkTree
              nodes={filteredEnvelopes.current}
              onSelectNode={handleSelectNode}
              selectedId={selectedWorkId}
            />
          )}
        </div>

        {/* Queue */}
        <div className={activeTab === "queue" ? styles.tabBodyVis : styles.tabBody}>
          {filteredEnvelopes.queue.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>◎</div>
              <div className={styles.emptyTitle}>Queue is empty</div>
              <div className={styles.emptySub}>
                Pending work will appear here
              </div>
            </div>
          ) : (
            <WorkTree
              nodes={filteredEnvelopes.queue}
              onSelectNode={handleSelectNode}
              selectedId={selectedWorkId}
            />
          )}
        </div>

        {/* Previous */}
        <div className={activeTab === "previous" ? styles.tabBodyVis : styles.tabBody}>
          {filteredEnvelopes.previous.length === 0 ? (
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
                nodes={filteredPrevSlice}
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
      {selectedPrimeId && (
        <WorkDetail
          envelope={selectedEnvelope}
          allEnvelopes={allEnvelopes}
          onClose={handleCloseDetail}
          primeId={selectedPrimeId}
        />
      )}
    </div>
  );
}

/* ---- Helpers ---- */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
