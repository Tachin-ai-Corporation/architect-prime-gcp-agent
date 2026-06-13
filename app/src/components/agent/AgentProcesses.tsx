"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import styles from "./AgentItems.module.css";

/* ================================================================
   Types
   ================================================================ */

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  status: "active" | "deprecated";
  version: number;
  execution_count: number;
  steps: { title: string; agent?: string }[];
  subscribers?: string[];
  created_at: string;
}

interface ProcessesResponse {
  processes: ProcessSummary[];
}

interface AgentProcessesProps {
  primeId: string;
  agentEmail: string;
}

/* ================================================================
   Helpers
   ================================================================ */

function isSubscribed(process: ProcessSummary, email: string): boolean {
  return process.subscribers?.includes(email) ?? false;
}

const STATUS_CLASS: Record<string, string> = {
  active: styles.statusActive,
  deprecated: styles.statusDeprecated,
};

/* ================================================================
   Component
   ================================================================ */

export function AgentProcesses({ primeId, agentEmail }: AgentProcessesProps) {
  const router = useRouter();
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track optimistic subscription state per process id
  const [subscriptionOverrides, setSubscriptionOverrides] = useState<
    Record<string, boolean>
  >({});

  const fetchProcesses = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api<ProcessesResponse>(
      `/api/primes/${primeId}/processes`,
    );
    if (!res) {
      setError("Failed to load processes");
      setLoading(false);
      return;
    }
    setProcesses(res.processes ?? []);
    setSubscriptionOverrides({});
    setLoading(false);
  }, [primeId]);

  useEffect(() => {
    fetchProcesses();
  }, [fetchProcesses]);

  /** Resolve subscription — check override first, then server data */
  const resolveSubscribed = useCallback(
    (proc: ProcessSummary): boolean => {
      if (proc.id in subscriptionOverrides) return subscriptionOverrides[proc.id];
      return isSubscribed(proc, agentEmail);
    },
    [subscriptionOverrides, agentEmail],
  );

  const handleToggleSubscribe = useCallback(
    async (processId: string) => {
      const current = subscriptionOverrides[processId] ??
        isSubscribed(
          processes.find((p) => p.id === processId)!,
          agentEmail,
        );
      // Optimistic update
      setSubscriptionOverrides((prev) => ({
        ...prev,
        [processId]: !current,
      }));
      // Call subscribe/unsubscribe API
      const action = current ? "unsubscribe" : "subscribe";
      await api(`/api/primes/${primeId}/processes/${processId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, email: agentEmail }),
      });
    },
    [subscriptionOverrides, processes, agentEmail, primeId],
  );

  /* ---- Sorted list: subscribed first ---- */
  const displayed = useMemo(() => {
    return [...processes].sort((a, b) => {
      const aSub = resolveSubscribed(a) ? 0 : 1;
      const bSub = resolveSubscribed(b) ? 0 : 1;
      return aSub - bSub;
    });
  }, [processes, resolveSubscribed]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.loadingState}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>Loading processes…</span>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.errorState}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        <button className={styles.retryBtn} onClick={fetchProcesses}>
          Retry
        </button>
      </div>
    );
  }

  /* ---- Empty ---- */
  if (processes.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>⚙️</div>
        No processes found
      </div>
    );
  }

  /* ---- Grid ---- */
  return (
    <div className={styles.itemGrid}>
      {displayed.map((proc) => {
        const subscribed = resolveSubscribed(proc);
        const stepCount = proc.steps?.length ?? 0;

        return (
          <div
            key={proc.id}
            className={`${styles.itemCard} ${
              subscribed ? styles.itemCardHighlighted : ""
            }`}
            onClick={() =>
              router.push(`/p/${primeId}/processes?process=${proc.id}`)
            }
          >
            {/* Header */}
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>{proc.name}</span>
              <div className={styles.badges}>
                {subscribed && (
                  <span className={styles.assignedBadge}>Subscribed</span>
                )}
                <span className={styles.versionBadge}>v{proc.version}</span>
                <span
                  className={`${styles.statusBadge} ${STATUS_CLASS[proc.status] ?? ""}`}
                >
                  {proc.status}
                </span>
              </div>
            </div>

            {/* Description */}
            {proc.description && (
              <div className={styles.cardGoal}>{proc.description}</div>
            )}

            {/* Meta */}
            <div className={styles.cardMeta}>
              <span className={styles.metaItem}>
                📝 {stepCount} step{stepCount !== 1 ? "s" : ""}
              </span>
              <span className={styles.metaItem}>
                🔄 {proc.execution_count} run
                {proc.execution_count !== 1 ? "s" : ""}
              </span>

              {/* Subscribe / Unsubscribe button */}
              <button
                className={`${styles.subscribeBtn} ${
                  subscribed ? styles.subscribeBtnActive : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation(); // prevent card navigation
                  handleToggleSubscribe(proc.id);
                }}
                style={{ marginLeft: "auto" }}
              >
                {subscribed ? "Unsubscribe" : "Subscribe"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
