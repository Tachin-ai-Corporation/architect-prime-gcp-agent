"use client";

import { useState, useEffect } from "react";
import { useIntrospect } from "@/hooks/useIntrospect";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import styles from "./MemoryViewer.module.css";
import { AsyncState } from "@/components/ui/AsyncState";

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
  // `lastRefreshed` doubles as "have we ever loaded".
  //
  // A `didInitRef` used to carry that second meaning, set in the same effect on
  // the same condition — so it was never anything other than
  // `lastRefreshed !== null`, and reading it during render made the render
  // depend on a value React does not track. Two names for one fact, one of them
  // invisible to the renderer.
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const { data, loading, error, refresh } = useIntrospect<WorkspaceData>({
    primeId,
    agent: agentName,
    type: "workspace",
  });

  // Track when data arrives
  useEffect(() => {
    if (data && !loading) {
      setLastRefreshed(new Date());
    }
  }, [data, loading]);



  /* ---- Find MEMORY.md ---- */
  const files = data?.files ?? {};
  const memoryKey = Object.keys(files).find(
    (k) => k === "MEMORY.md" || k.endsWith("/MEMORY.md")
  );
  const memoryContent = memoryKey ? files[memoryKey] : null;

  /* ---- Render ---- */
  return (
    <AsyncState
      loading={loading && !lastRefreshed}
      error={error}
      onRetry={refresh}
      loadingLabel="Loading workspace…"
    >
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
            onClick={refresh}
            disabled={loading}
          >
            <span className={styles.refreshIcon}>↻</span>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {memoryContent ? (
          /* Memory card */
          <div className={styles.card}>
            <div className={styles.prose}>
              <MarkdownMessage text={memoryContent} />
            </div>
          </div>
        ) : (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>🧠</div>
            No working memory found
          </div>
        )}
      </div>
    </AsyncState>
  );
}
