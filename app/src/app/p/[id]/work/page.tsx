"use client";

import { Suspense, use, useState, useMemo, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import { useWorkEnvelopes } from "@/components/work/useWorkEnvelopes";
import { WorkTree } from "@/components/work/WorkTree";
import { WorkDetail } from "@/components/work/WorkDetail";
import { api } from "@/lib/api";

/* ---- Tab types ---- */
type TabId = "current" | "queue" | "previous";

const PAGE_SIZE = 10;

export default function WorkPageWrapper({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <WorkPage primeId={id} />
    </Suspense>
  );
}

function WorkPage({ primeId }: { primeId: string }) {
  const searchParams = useSearchParams();
  const selectedAgent = searchParams.get("agent") || null;

  /* ---- Data hook ---- */
  const { current, queue, previous, allEnvelopes, loading } = useWorkEnvelopes(
    primeId,
    selectedAgent
  );

  /* ---- UI state ---- */
  const [activeTab, setActiveTab] = useState<TabId>("current");
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [prevPage, setPrevPage] = useState(0);
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

  /* ---- Fetch projects ---- */
  useEffect(() => {
    api<{ projects: { id: string; name: string }[] }>(`/api/primes/${primeId}/projects`)
      .then((data) => {
        if (data?.projects) setProjects(data.projects);
      });
  }, [primeId]);

  /* ---- Computed ---- */
  const needsInputCount = useMemo(
    () => allEnvelopes.filter((e) => e.status === "needs_input" || e.status === "waiting").length,
    [allEnvelopes]
  );

  const selectedEnvelope = useMemo(
    () => allEnvelopes.find((e) => e.id === selectedWorkId) ?? null,
    [allEnvelopes, selectedWorkId]
  );

  /* ---- Previous work pagination ---- */
  const totalPrevPages = Math.ceil(filteredEnvelopes.previous.length / PAGE_SIZE);
  const filteredPrevSlice = filteredEnvelopes.previous.slice(prevPage * PAGE_SIZE, (prevPage + 1) * PAGE_SIZE);

  /* ---- Handlers ---- */
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

  return (
    <div className={styles.shell}>
      {/* ---- Project filter ---- */}
      {projects.length > 0 && (
        <div className={styles.subFilters}>
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

      {/* ---- Page Header ---- */}
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Work</h1>

        {/* Needs input pill */}
        {needsInputCount > 0 && (
          <span className={styles.needsPill}>⚡ {needsInputCount} needs input</span>
        )}
      </div>

      {loading && !allEnvelopes.length ? (
        <div className={styles.loading}>
          <span className={styles.loadingDots}>Loading work tree…</span>
        </div>
      ) : (
        <>
          <div className={styles.pgSub}>
            {selectedAgent
              ? `Showing work for ${selectedAgent}`
              : "Select an agent to filter, or view all work"}
          </div>

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
          <WorkDetail
            envelope={selectedEnvelope}
            allEnvelopes={allEnvelopes}
            onClose={handleCloseDetail}
            primeId={primeId}
          />
        </>
      )}
    </div>
  );
}
