"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useIntrospect } from "@/hooks/useIntrospect";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import styles from "./MemoryViewer.module.css";

/* ================================================================
   Types
   ================================================================ */

export interface WorkspaceData {
  files: Record<string, string>; // filename → content
}

interface MemoryViewerProps {
  primeId: string;
  agentName: string;
}

/* ================================================================
   Component
   ================================================================ */

export function MemoryViewer({ primeId, agentName }: MemoryViewerProps) {
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const didInitRef = useRef(false);

  const { data, loading, error, refresh } = useIntrospect<WorkspaceData>({
    primeId,
    agent: agentName,
    type: "workspace",
  });

  // Track when data arrives
  useEffect(() => {
    if (data && !loading) {
      setLastRefreshed(new Date());
      didInitRef.current = true;
    }
  }, [data, loading]);

  const handleRefresh = useCallback(() => {
    refresh();
  }, [refresh]);

  /* ---- Loading ---- */
  if (loading && !didInitRef.current) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>Loading workspace…</span>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.error}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        <button className={styles.retryBtn} onClick={handleRefresh}>
          Retry
        </button>
      </div>
    );
  }

  /* ---- Find MEMORY.md ---- */
  const files = data?.files ?? {};
  const memoryKey = Object.keys(files).find(
    (k) => k === "MEMORY.md" || k.endsWith("/MEMORY.md")
  );
  const memoryContent = memoryKey ? files[memoryKey] : null;

  /* ---- Empty ---- */
  if (!memoryContent) {
    return (
      <div className={styles.container}>
        <div className={styles.toolbar}>
          <span className={styles.timestamp} />
          <button
            className={styles.refreshBtn}
            onClick={handleRefresh}
            disabled={loading}
          >
            <span className={styles.refreshIcon}>↻</span>
            Refresh
          </button>
        </div>
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🧠</div>
          No working memory found
        </div>
      </div>
    );
  }

  /* ---- Render ---- */
  return (
    <div className={styles.container}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <span className={styles.timestamp}>
          {lastRefreshed
            ? `Last refreshed ${lastRefreshed.toLocaleTimeString()}`
            : ""}
        </span>
        <button
          className={styles.refreshBtn}
          onClick={handleRefresh}
          disabled={loading}
        >
          <span className={styles.refreshIcon}>↻</span>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Memory card */}
      <div className={styles.card}>
        <div className={styles.prose}>
          <MarkdownMessage text={memoryContent} />
        </div>
      </div>
    </div>
  );
}
