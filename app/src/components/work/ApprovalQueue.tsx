"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./ApprovalQueue.module.css";
import type { WorkEnvelope } from "@/lib/types";
import { formatAgentDisplayName } from "@/components/AgentChip";

/* ---- Component ---- */

interface ApprovalQueueProps {
  primeId: string;
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
  const [approvals, setApprovals] = useState<WorkEnvelope[]>([]);
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

  const handleAction = async (envelopeId: string, action: "approve" | "reject") => {
    setActionInFlight(envelopeId);
    try {
      const res = await fetch(`/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primeId, envelopeId, action }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      // Remove from list optimistically
      setApprovals((prev) => prev.filter((a) => a.id !== envelopeId));
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

      {approvals.map((envelope) => (
        <div key={envelope.id} className={styles.card}>
          <div className={styles.cardTop}>
            <span className={styles.typeChip}>{envelope.type}</span>
            <span className={styles.title}>
              {envelope.title || envelope.instruction || envelope.intent || "Untitled"}
            </span>
            {envelope.owner && (
              <span className={styles.owner}>{formatAgentDisplayName(envelope.owner)}</span>
            )}
          </div>

          {envelope.accept_criteria && (
            <div className={styles.criteria}>
              <strong>Criteria:</strong> {envelope.accept_criteria}
            </div>
          )}

          {envelope.output && (
            <div className={styles.output}>
              {envelope.output.length > 300
                ? envelope.output.slice(0, 300) + "…"
                : envelope.output}
            </div>
          )}

          <div className={styles.cardBottom}>
            <span className={styles.time}>
              {formatTimestamp(envelope.created_at)}
              {envelope.blocked_at && ` · waiting ${elapsedSince(envelope.blocked_at)}`}
            </span>

            <div className={styles.actions}>
              <button
                className={styles.rejectBtn}
                onClick={() => handleAction(envelope.id, "reject")}
                disabled={actionInFlight === envelope.id}
              >
                Reject
              </button>
              <button
                className={styles.approveBtn}
                onClick={() => handleAction(envelope.id, "approve")}
                disabled={actionInFlight === envelope.id}
              >
                {actionInFlight === envelope.id ? "…" : "Approve"}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
