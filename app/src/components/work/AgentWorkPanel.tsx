"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import styles from "./AgentWorkPanel.module.css";
import { useWorkEnvelopes } from "./useWorkEnvelopes";
import { WorkTree } from "./WorkTree";
import { WorkDetail } from "./WorkDetail";
import { api } from "@/lib/api";
import type { WorkEnvelope } from "@/lib/types";

/* ---- Sub-tab types ---- */
type SubTab = "inProgress" | "queue" | "recent" | "archived";

const PAGE_SIZE = 10;

interface AgentWorkPanelProps {
  primeId: string;
  agentFilter: string;
}

export function AgentWorkPanel({ primeId, agentFilter }: AgentWorkPanelProps) {
  /* ---- Live data (tabs 1-3) ---- */
  const { current, queue, previous, allEnvelopes, loading, loadTree } =
    useWorkEnvelopes(primeId, agentFilter);

  /* ---- UI state ---- */
  const [activeTab, setActiveTab] = useState<SubTab>("inProgress");
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [prevPage, setPrevPage] = useState(0);

  /* ---- Archived state ---- */
  const [archivedEnvelopes, setArchivedEnvelopes] = useState<WorkEnvelope[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedCursor, setArchivedCursor] = useState<string | null>(null);
  const [archivedSearch, setArchivedSearch] = useState("");
  const [archivedHasMore, setArchivedHasMore] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Computed ---- */
  const needsInputCount = useMemo(
    () => allEnvelopes.filter((e) => e.status === "needs_input" || e.status === "waiting" || e.status === "blocked").length,
    [allEnvelopes]
  );

  const selectedEnvelope = useMemo(
    () => {
      const fromLive = allEnvelopes.find((e) => e.id === selectedWorkId);
      if (fromLive) return fromLive;
      return archivedEnvelopes.find((e) => e.id === selectedWorkId) ?? null;
    },
    [allEnvelopes, archivedEnvelopes, selectedWorkId]
  );

  /* ---- Previous work pagination ---- */
  const totalPrevPages = Math.ceil(previous.length / PAGE_SIZE);
  const prevSlice = previous.slice(prevPage * PAGE_SIZE, (prevPage + 1) * PAGE_SIZE);

  /* ---- Handlers ---- */
  const handleSelectTab = useCallback((tab: SubTab) => {
    setActiveTab(tab);
    if (tab !== "recent") setPrevPage(0);
  }, []);

  const handleSelectNode = useCallback((nodeId: string) => {
    setSelectedWorkId(nodeId);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedWorkId(null);
  }, []);

  /* ---- Archived: fetch ---- */
  const fetchArchived = useCallback(
    async (search: string, cursor: string | null, append: boolean) => {
      setArchivedLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("agent", agentFilter);
        params.set("limit", "20");
        if (search) params.set("search", search);
        if (cursor) params.set("startAfter", cursor);

        const data = await api<{ envelopes: WorkEnvelope[]; nextCursor: string | null }>(
          `/api/primes/${primeId}/work/archived?${params.toString()}`
        );
        if (data) {
          setArchivedEnvelopes((prev) =>
            append ? [...prev, ...data.envelopes] : data.envelopes
          );
          setArchivedCursor(data.nextCursor);
          setArchivedHasMore(data.nextCursor !== null);
        }
      } catch {
        // silent
      }
      setArchivedLoading(false);
    },
    [primeId, agentFilter]
  );

  /* ---- Archived: auto-fetch on tab switch (once) ---- */
  const archivedFetchedRef = useRef(false);
  useEffect(() => {
    if (activeTab === "archived" && !archivedFetchedRef.current && !archivedLoading) {
      archivedFetchedRef.current = true;
      fetchArchived("", null, false);
    }
  }, [activeTab, archivedLoading, fetchArchived]);

  /* ---- Archived: debounced search ---- */
  const handleSearchChange = useCallback(
    (value: string) => {
      setArchivedSearch(value);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        setArchivedCursor(null);
        fetchArchived(value, null, false);
      }, 300);
    },
    [fetchArchived]
  );

  /* ---- Archived: load more ---- */
  const handleLoadMore = useCallback(() => {
    if (archivedCursor && !archivedLoading) {
      fetchArchived(archivedSearch, archivedCursor, true);
    }
  }, [archivedCursor, archivedLoading, archivedSearch, fetchArchived]);

  /* ---- Status helpers ---- */
  const formatDate = (ts: string | null) => {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      ", " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };

  const formatDuration = (start: string | null, end: string | null) => {
    if (!start || !end) return "—";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
  };

  const statusDotClass = (status: string) => {
    switch (status) {
      case "complete": return styles.dotDone;
      case "failed": case "timed_out": return styles.dotFailed;
      case "cancelled": case "rejected": return styles.dotCancelled;
      default: return styles.dotNeutral;
    }
  };

  const typeLabel = (type: string) => {
    switch (type) {
      case "M": return "Mission";
      case "R": return "Responsibility";
      case "C": return "Checkpoint";
      case "T": return "Task";
      default: return type;
    }
  };

  const ownerName = (owner: string) => {
    if (!owner) return "—";
    const parts = owner.split("@")[0].split("-");
    return parts[parts.length - 1] || owner;
  };

  return (
    <div className={styles.panel}>
      {/* ---- Needs Input Pill ---- */}
      {needsInputCount > 0 && (
        <div className={styles.needsPill}>⚡ {needsInputCount} needs input</div>
      )}

      {loading && !allEnvelopes.length ? (
        <div className={styles.loading}>
          <span className={styles.loadingDots}>Loading work tree…</span>
        </div>
      ) : (
        <>
          {/* ---- Tabs ---- */}
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeTab === "inProgress" ? styles.tabOn : ""}`}
              onClick={() => handleSelectTab("inProgress")}
            >
              In Progress
              <span className={`${styles.badge} ${styles.badgeTeal}`}>
                {current.length}
              </span>
              {needsInputCount > 0 && (
                <span className={`${styles.badge} ${styles.badgeAmber}`}>
                  {needsInputCount}
                </span>
              )}
            </button>
            <button
              className={`${styles.tab} ${activeTab === "queue" ? styles.tabOn : ""}`}
              onClick={() => handleSelectTab("queue")}
            >
              Queue
              <span className={`${styles.badge} ${styles.badgeSlate}`}>
                {queue.length}
              </span>
            </button>
            <button
              className={`${styles.tab} ${activeTab === "recent" ? styles.tabOn : ""}`}
              onClick={() => handleSelectTab("recent")}
            >
              Recent Work
              <span className={`${styles.badge} ${styles.badgeSlate}`}>
                {previous.length}
              </span>
            </button>
            <button
              className={`${styles.tab} ${activeTab === "archived" ? styles.tabOn : ""}`}
              onClick={() => handleSelectTab("archived")}
            >
              Archived
            </button>
          </div>

          {/* ---- Tab Bodies ---- */}

          {/* In Progress */}
          <div className={activeTab === "inProgress" ? styles.tabBodyVis : styles.tabBody}>
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
                onLoadTree={loadTree}
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
                onLoadTree={loadTree}
              />
            )}
          </div>

          {/* Recent Work */}
          <div className={activeTab === "recent" ? styles.tabBodyVis : styles.tabBody}>
            {previous.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>◎</div>
                <div className={styles.emptyTitle}>No recent work</div>
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
                  onLoadTree={loadTree}
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

          {/* Archived Work */}
          <div className={activeTab === "archived" ? styles.tabBodyVis : styles.tabBody}>
            {/* Search */}
            <div className={styles.archiveSearch}>
              <span className={styles.archiveSearchIcon}>🔍</span>
              <input
                className={styles.archiveSearchInput}
                placeholder="Search archived work…"
                value={archivedSearch}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>

            {/* List */}
            {archivedEnvelopes.length === 0 && !archivedLoading ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>📦</div>
                <div className={styles.emptyTitle}>
                  {archivedSearch ? "No results" : "No archived work"}
                </div>
                <div className={styles.emptySub}>
                  {archivedSearch
                    ? "Try a different search term"
                    : "Completed work history will appear here"}
                </div>
              </div>
            ) : (
              <div className={styles.archiveList}>
                {archivedEnvelopes.map((env) => (
                  <button
                    key={env.id}
                    className={styles.archiveRow}
                    onClick={() => setSelectedWorkId(env.id)}
                  >
                    <span className={`${styles.archiveDot} ${statusDotClass(env.status)}`} />
                    <span className={styles.archiveType}>{typeLabel(env.type)}</span>
                    <span className={styles.archiveTitle}>
                      {env.title || env.intent || env.instruction || "Untitled"}
                    </span>
                    <span className={styles.archiveOwner}>{ownerName(env.owner)}</span>
                    <span className={styles.archiveDate}>{formatDate(env.completed_at)}</span>
                    <span className={styles.archiveDuration}>
                      {formatDuration(env.started_at, env.completed_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Loading */}
            {archivedLoading && (
              <div className={styles.archiveLoading}>
                <span className={styles.loadingDots}>Loading…</span>
              </div>
            )}

            {/* Load More */}
            {archivedHasMore && !archivedLoading && (
              <div className={styles.archiveLoadMore}>
                <button className={styles.pgBtn} onClick={handleLoadMore}>
                  Load More
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ---- Detail Modal ---- */}
      <WorkDetail
        envelope={selectedEnvelope}
        allEnvelopes={[...allEnvelopes, ...archivedEnvelopes]}
        onClose={handleCloseDetail}
        primeId={primeId}
      />
    </div>
  );
}
