"use client";

import { useState, useEffect } from "react";
import styles from "./LiveIndicator.module.css";

interface LiveIndicatorProps {
  /** Timestamp of last data fetch (ISO string or epoch ms) */
  lastUpdated: string | number | null;
  /** Whether a fetch is currently in progress */
  loading?: boolean;
  /** Whether the data source is considered offline/stale */
  stale?: boolean;
  /** Optional: refresh callback (renders a refresh button) */
  onRefresh?: () => void;
}

export function LiveIndicator({
  lastUpdated,
  loading = false,
  stale = false,
  onRefresh,
}: LiveIndicatorProps) {
  const [, setTick] = useState(0);

  // Re-render every 10s to update the "Xs ago" display
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(iv);
  }, []);

  const getAgo = () => {
    if (!lastUpdated) return null;
    const ts =
      typeof lastUpdated === "string"
        ? new Date(lastUpdated).getTime()
        : lastUpdated;
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  };

  const ago = getAgo();

  return (
    <span className={styles.indicator}>
      {loading ? (
        <>
          <span className={styles.dotLoading} />
          <span className={styles.label}>Updating…</span>
        </>
      ) : stale ? (
        <>
          <span className={styles.dotStale} />
          <span className={styles.label}>Stale</span>
        </>
      ) : (
        <>
          <span className={styles.dotLive} />
          <span className={styles.label}>
            {ago ? `Updated ${ago}` : "Live"}
          </span>
        </>
      )}
      {onRefresh && !loading && (
        <button
          className={styles.refreshBtn}
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          title="Refresh"
        >
          ↻
        </button>
      )}
    </span>
  );
}
