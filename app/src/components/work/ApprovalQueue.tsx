"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./ApprovalQueue.module.css";

/* ---- Component ---- */

interface ApprovalQueueProps {
  primeId: string;
}

/** Matches the shape returned by GET /api/approvals (approvals collection). */
interface Approval {
  id: string;
  envelopeId: string | null;
  title: string | null;
  description: string | null;
  processName: string | null;
  status: string;
  requestedAt: string | null;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function elapsedSince(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`;
}

export function ApprovalQueue({ primeId }: ApprovalQueueProps) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch(`/api/approvals?primeId=${primeId}`);
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = await res.json();
      setApprovals(data.approvals || []);
    } catch (err) {
      console.error("Failed to fetch approvals:", err);
    } finally {
      setLoading(false);
    }
  }, [primeId]);

  useEffect(() => {
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 15000);
    return () => clearInterval(interval);
  }, [fetchApprovals]);

  const handleAction = async (approvalId: string, action: "approve" | "reject") => {
    setActionInFlight(approvalId);
    try {
      // Route requires { primeId, approvalId, action } — previously sent envelopeId → 400.
      const res = await fetch(`/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primeId, approvalId, action }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    } catch (err) {
      console.error("Approval action failed:", err);
    } finally {
      setActionInFlight(null);
    }
  };

  if (loading) {
    return <div className={styles.empty}>Loading approvals…</div>;
  }

  if (approvals.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon}>✓</span>
        <span>No pending approvals</span>
      </div>
    );
  }

  return (
    <div className={styles.queue}>
      <div className={styles.header}>
        <span className={styles.count}>{approvals.length}</span>
        <span className={styles.headerLabel}>pending approval{approvals.length !== 1 ? "s" : ""}</span>
      </div>

      {approvals.map((appr) => (
        <div key={appr.id} className={styles.card}>
          <div className={styles.cardTop}>
            {appr.processName && <span className={styles.typeChip}>{appr.processName}</span>}
            <span className={styles.title}>{appr.title || "Approval requested"}</span>
          </div>

          {appr.description && (
            <div className={styles.criteria}>{appr.description}</div>
          )}

          <div className={styles.cardBottom}>
            <span className={styles.time}>
              {formatTimestamp(appr.requestedAt)}
              {elapsedSince(appr.requestedAt) && ` · ${elapsedSince(appr.requestedAt)} ago`}
            </span>

            <div className={styles.actions}>
              <button
                className={styles.rejectBtn}
                onClick={() => handleAction(appr.id, "reject")}
                disabled={actionInFlight === appr.id}
              >
                Reject
              </button>
              <button
                className={styles.approveBtn}
                onClick={() => handleAction(appr.id, "approve")}
                disabled={actionInFlight === appr.id}
              >
                {actionInFlight === appr.id ? "…" : "Approve"}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
