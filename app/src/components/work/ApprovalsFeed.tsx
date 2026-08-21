"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import styles from "./ApprovalsFeed.module.css";

/* ---- Shape returned by GET /api/approvals, plus the primeId we fetched it under ---- */
export interface Approval {
  id: string;
  primeId: string;
  envelopeId: string | null;
  checkpointId: string | null;
  taskId: string | null;
  title: string | null;
  description: string | null;
  processName: string | null;
  status: string;
  requestedAt: string | null;
}

function elapsedSince(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m waiting`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h waiting` : `${Math.floor(hrs / 24)}d waiting`;
}

/* ==== useApprovals — cross-prime pending poll (mirrors useOperations) ==== */
export function useApprovals(primeIds: string[]) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(false);

  // The key is both the dependency and the source, so the array fetched and the
  // value that decides whether to re-poll can never disagree (see useOperations).
  const primeIdsKey = JSON.stringify(primeIds);
  const poll = useCallback(async () => {
    const ids: string[] = JSON.parse(primeIdsKey);
    if (ids.length === 0) return;
    try {
      const results = await Promise.all(
        ids.map(async (pid) => {
          try {
            const res = await fetch(
              `/api/approvals?primeId=${encodeURIComponent(pid)}&status=pending`
            );
            if (res.ok) {
              const data = await res.json();
              return ((data.approvals || []) as Omit<Approval, "primeId">[]).map(
                (a) => ({ ...a, primeId: pid })
              );
            }
          } catch {}
          return [] as Approval[];
        })
      );
      // Oldest-waiting first — the most urgent decision is at the top.
      const merged = results.flat().sort((a, b) => {
        const ta = a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
        const tb = b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
        return ta - tb;
      });
      setApprovals(merged);
    } catch {}
    setLoading(false);
  }, [primeIdsKey]);

  useEffect(() => {
    if (JSON.parse(primeIdsKey).length === 0) {
      void (async () => { setApprovals([]); })();
      return;
    }
    void (async () => {
      setLoading(true);
      await poll();
    })();
    const iv = setInterval(poll, 15000);
    return () => clearInterval(iv);
  }, [primeIdsKey, poll]);

  return { approvals, pendingCount: approvals.length, loading, refresh: poll };
}

/* ==== ApprovalsFeed drawer ==== */
interface ApprovalsFeedProps {
  approvals: Approval[];
  onClose?: () => void;
  onResolved?: () => void;
}

export function ApprovalsFeed({ approvals, onClose, onResolved }: ApprovalsFeedProps) {
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const act = async (appr: Approval, action: "approve" | "reject", why?: string) => {
    setActionInFlight(appr.id);
    setError(null);
    try {
      const res = await fetch(`/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primeId: appr.primeId,
          approvalId: appr.id,
          action,
          ...(why ? { reason: why } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setRejectingId(null);
      setReason("");
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActionInFlight(null);
    }
  };

  return (
    <div className={styles.feed}>
      <div className={styles.feedHeader}>
        <span className={styles.feedTitle}>
          Approvals
          {approvals.length > 0 && (
            <span className={styles.feedBadge}>{approvals.length} pending</span>
          )}
        </span>
        {onClose && (
          <button className={styles.feedClose} onClick={onClose}>✕</button>
        )}
      </div>

      {approvals.length === 0 ? (
        <div className={styles.feedEmpty}>
          <span className={styles.feedEmptyIcon}>✓</span>
          <span>No pending approvals</span>
        </div>
      ) : (
        <div className={styles.feedList}>
          {error && <div className={styles.error}>{error}</div>}
          {approvals.map((appr) => (
            <div key={appr.id} className={styles.card}>
              <div className={styles.cardTop}>
                {appr.processName && (
                  <span className={styles.typeChip}>{appr.processName}</span>
                )}
                <span className={styles.prime}>{appr.primeId}</span>
              </div>

              <span className={styles.title}>{appr.title || "Approval requested"}</span>
              {appr.description && <div className={styles.desc}>{appr.description}</div>}

              <div className={styles.meta}>
                <span className={styles.time}>{elapsedSince(appr.requestedAt)}</span>
                {appr.envelopeId && (
                  <Link
                    className={styles.workLink}
                    href={`/p/${appr.primeId}#work`}
                    onClick={onClose}
                  >
                    View work ↗
                  </Link>
                )}
              </div>

              {rejectingId === appr.id ? (
                <div className={styles.rejectBox}>
                  <input
                    className={styles.reasonInput}
                    placeholder="Reason (optional)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    autoFocus
                  />
                  <div className={styles.actions}>
                    <button
                      className={styles.ghostBtn}
                      onClick={() => { setRejectingId(null); setReason(""); }}
                    >
                      Cancel
                    </button>
                    <button
                      className={styles.rejectBtn}
                      disabled={actionInFlight === appr.id}
                      onClick={() => act(appr, "reject", reason)}
                    >
                      {actionInFlight === appr.id ? "…" : "Confirm reject"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.actions}>
                  <button
                    className={styles.rejectBtn}
                    disabled={actionInFlight === appr.id}
                    onClick={() => setRejectingId(appr.id)}
                  >
                    Reject
                  </button>
                  <button
                    className={styles.approveBtn}
                    disabled={actionInFlight === appr.id}
                    onClick={() => act(appr, "approve")}
                  >
                    {actionInFlight === appr.id ? "…" : "Approve"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
