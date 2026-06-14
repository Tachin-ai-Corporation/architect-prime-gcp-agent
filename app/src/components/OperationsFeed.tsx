"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./OperationsFeed.module.css";


/* ---- Types ---- */
interface DeployStep {
  id: string;
  label: string;
  status: string;
  timestamp: string;
  detail?: string;
}

interface Operation {
  id: string;
  type: string;
  status: string;
  label: string;
  target: string;
  prime: string;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  detail: string | null;
  steps: DeployStep[] | null;
  progress: number | null;
  buildId: string | null;
}

/* ---- Icons per type ---- */
const TYPE_ICONS: Record<string, string> = {
  dashboard_deploy: "🏗️",
  corekit_upgrade: "⬆",
  fleet_hire: "👤",
  fleet_upgrade: "⬆",
  fleet_teardown: "🗑",
  gateway_restart: "🔄",
  prime_deploy: "🚀",
};

/* ---- Status config ---- */
const STATUS_CONFIG: Record<string, { icon: string; label: string; className: string }> = {
  pending: { icon: "⏳", label: "Queued", className: "statusPending" },
  running: { icon: "⚙️", label: "Running", className: "statusRunning" },
  complete: { icon: "✅", label: "Complete", className: "statusComplete" },
  failed: { icon: "❌", label: "Failed", className: "statusFailed" },
};

/* ---- Time helpers ---- */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatDuration(secs: number | null): string {
  if (secs == null) return "";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/* ---- Step icon ---- */
function stepIcon(status: string): string {
  switch (status) {
    case "done": return "✅";
    case "active": return "⚙️";
    case "pending": return "⏳";
    case "failed": return "❌";
    case "skipped": return "⏭";
    default: return "·";
  }
}

/* ==== useOperations hook ==== */
export function useOperations(primeIds: string[]) {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(false);

  const primeIdsKey = JSON.stringify(primeIds);
  const poll = useCallback(async () => {
    if (primeIds.length === 0) return;
    try {
      const results = await Promise.all(
        primeIds.map(async (pid) => {
          try {
            const res = await fetch(`/api/primes/${pid}/ops`);
            if (res.ok) {
              const data = await res.json();
              return (data.operations || []) as Operation[];
            }
          } catch {}
          return [] as Operation[];
        })
      );
      const merged = results.flat();
      // Dedupe by id, sort newest first
      const seen = new Set<string>();
      const deduped = merged.filter((op) => {
        if (seen.has(op.id)) return false;
        seen.add(op.id);
        return true;
      });
      deduped.sort((a, b) => {
        const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return tb - ta;
      });
      setOperations(deduped);
    } catch {}
    setLoading(false);
  }, [primeIdsKey]);

  useEffect(() => {
    if (primeIds.length === 0) {
      setOperations([]);
      return;
    }
    setLoading(true);
    poll();
    const iv = setInterval(poll, 5000);
    return () => clearInterval(iv);
  }, [primeIds, poll]);

  const activeCount = operations.filter(
    (op) => op.status === "pending" || op.status === "running"
  ).length;

  return { operations, activeCount, loading, refresh: poll };
}

/* ==== OperationCard ==== */
function OperationCard({ op, primeId }: { op: Operation; primeId: string }) {
  const [expanded, setExpanded] = useState(
    op.status === "running" && op.steps != null
  );

  const typeIcon = TYPE_ICONS[op.type] || "📋";
  const statusCfg = STATUS_CONFIG[op.status] || STATUS_CONFIG.pending;
  const isActive = op.status === "pending" || op.status === "running";
  const hasSteps = op.steps && op.steps.length > 0;
  const hasDetail = op.detail && op.detail.length > 0;
  const canExpand = hasSteps || hasDetail;

  /* Retry handler */
  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Map operation type back to command type
    const cmdTypeMap: Record<string, string> = {
      corekit_upgrade: "upgrade_corekit",
      fleet_hire: "fleet_deploy",
      fleet_upgrade: "fleet_upgrade",
      fleet_teardown: "fleet_teardown",
      gateway_restart: "gateway_restart",
    };
    const cmdType = cmdTypeMap[op.type];
    if (!cmdType) return;

    // Re-queue the same command by extracting args from the label
    const args: Record<string, string> = {};
    if (op.type === "fleet_hire" || op.type === "fleet_upgrade" || op.type === "fleet_teardown") {
      args.name = op.target;
    }
    if (op.type === "fleet_upgrade" || op.type === "corekit_upgrade") {
      args.ref = "main";
    }

    try {
      await fetch(`/api/primes/${primeId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: cmdType, args }),
      });
    } catch {
      // best-effort
    }
  };

  return (
    <div
      className={`${styles.opCard} ${styles[statusCfg.className]} ${isActive ? styles.opCardActive : ""}`}
      id={`op-${op.id}`}
    >
      <div
        className={styles.opHeader}
        onClick={() => canExpand && setExpanded(!expanded)}
        style={{ cursor: canExpand ? "pointer" : "default" }}
      >
        <span className={styles.opTypeIcon}>{typeIcon}</span>
        <div className={styles.opInfo}>
          <span className={styles.opLabel}>{op.label}</span>
          <span className={styles.opMeta}>
            <span className={styles.opStatusIcon}>{statusCfg.icon}</span>
            <span>{statusCfg.label}</span>
            {op.duration != null && (
              <span className={styles.opDuration}>{formatDuration(op.duration)}</span>
            )}
            {!isActive && op.completedAt && (
              <span className={styles.opTime}>{timeAgo(op.completedAt)}</span>
            )}
            {isActive && op.startedAt && (
              <span className={styles.opTime}>{timeAgo(op.startedAt)}</span>
            )}
          </span>
        </div>

        {/* Progress bar for active ops */}
        {isActive && op.progress != null && (
          <div className={styles.opProgress}>
            <div
              className={styles.opProgressBar}
              style={{ width: `${op.progress}%` }}
            />
          </div>
        )}

        {/* Active spinner */}
        {isActive && <span className={styles.opSpinner} />}

        {/* Expand chevron */}
        {canExpand && (
          <span className={styles.opExpand}>{expanded ? "▾" : "▸"}</span>
        )}

        {/* Retry button for failed */}
        {op.status === "failed" && (
          <button
            className={styles.opRetry}
            onClick={handleRetry}
            title="Retry"
          >
            ↻ Retry
          </button>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className={styles.opDetail}>
          {/* Deploy steps */}
          {hasSteps && (
            <div className={styles.opSteps}>
              {op.steps!.map((step, i) => (
                <div
                  key={step.id || i}
                  className={`${styles.opStep} ${step.status === "active" ? styles.opStepActive : ""}`}
                >
                  <span className={styles.opStepIcon}>{stepIcon(step.status)}</span>
                  <span className={styles.opStepLabel}>{step.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error/result text */}
          {hasDetail && (
            <pre className={styles.opDetailText}>{op.detail}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ==== OperationsFeed ==== */
interface OperationsFeedProps {
  primeId: string;
  operations: Operation[];
  onClose?: () => void;
  onClear?: () => void;
}

export function OperationsFeed({ primeId, operations, onClose, onClear }: OperationsFeedProps) {
  const activeOps = operations.filter(
    (op) => op.status === "pending" || op.status === "running"
  );
  const recentOps = operations.filter(
    (op) => op.status === "complete" || op.status === "failed"
  );

  if (operations.length === 0) {
    return (
      <div className={styles.feed}>
        <div className={styles.feedHeader}>
          <span className={styles.feedTitle}>Operations</span>
          {onClose && (
            <button className={styles.feedClose} onClick={onClose}>✕</button>
          )}
        </div>
        <div className={styles.feedEmpty}>
          <span className={styles.feedEmptyIcon}>🔇</span>
          <span>No recent operations</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.feed}>
      <div className={styles.feedHeader}>
        <span className={styles.feedTitle}>
          Operations
          {activeOps.length > 0 && (
            <span className={styles.feedBadge}>{activeOps.length} active</span>
          )}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {recentOps.length > 0 && onClear && (
            <button className={styles.feedClear} onClick={onClear}>Clear</button>
          )}
          {onClose && (
            <button className={styles.feedClose} onClick={onClose}>✕</button>
          )}
        </span>
      </div>

      <div className={styles.feedList}>
        {/* Active operations first */}
        {activeOps.map((op) => (
          <OperationCard key={op.id} op={op} primeId={primeId} />
        ))}

        {/* Divider if both active and recent */}
        {activeOps.length > 0 && recentOps.length > 0 && (
          <div className={styles.feedDivider} />
        )}

        {/* Recent completed/failed */}
        {recentOps.map((op) => (
          <OperationCard key={op.id} op={op} primeId={primeId} />
        ))}
      </div>
    </div>
  );
}
