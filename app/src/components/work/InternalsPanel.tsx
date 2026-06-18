"use client";

import { useState } from "react";
import styles from "./InternalsPanel.module.css";
import type { WorkEnvelope, StepLedgerEntry, CheckpointProgress } from "@/lib/types";

/* ---- Component ---- */

interface InternalsPanelProps {
  envelope: WorkEnvelope;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

export function InternalsPanel({ envelope }: InternalsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const hasLedger = envelope.step_ledger && Object.keys(envelope.step_ledger).length > 0;
  const hasClaim = !!envelope.claimed_by;
  const hasProgress = !!envelope._cp_progress;

  // Don't render if no internals data
  if (!hasLedger && !hasClaim && !hasProgress) return null;

  return (
    <div className={styles.panel}>
      <button
        className={styles.trigger}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className={styles.icon}>{expanded ? "▾" : "▸"}</span>
        <span className={styles.label}>Internals</span>
        <span className={styles.badges}>
          {hasLedger && (
            <span className={styles.badge}>
              {Object.keys(envelope.step_ledger!).length} steps
            </span>
          )}
          {hasClaim && <span className={styles.badge}>claimed</span>}
          {hasProgress && <span className={styles.badge}>resumable</span>}
        </span>
      </button>

      {expanded && (
        <div className={styles.body}>
          {/* Claim info */}
          {hasClaim && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Claim</div>
              <div className={styles.grid}>
                <span className={styles.gk}>Claimed by</span>
                <span className={styles.gv}>{envelope.claimed_by}</span>
                {envelope.claimed_at_ms && (
                  <>
                    <span className={styles.gk}>Claimed at</span>
                    <span className={styles.gv}>
                      {formatTimestamp(new Date(envelope.claimed_at_ms).toISOString())}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Checkpoint progress */}
          {hasProgress && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Checkpoint Resume State</div>
              <div className={styles.grid}>
                <span className={styles.gk}>Checkpoint</span>
                <span className={styles.gv}>{(envelope._cp_progress!.checkpointIndex ?? 0) + 1}</span>
                <span className={styles.gk}>Task</span>
                <span className={styles.gv}>{(envelope._cp_progress!.taskIndex ?? 0) + 1}</span>
                {envelope._cp_progress!.allResults && (
                  <>
                    <span className={styles.gk}>Results collected</span>
                    <span className={styles.gv}>{envelope._cp_progress!.allResults.length}</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Step ledger */}
          {hasLedger && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Step Ledger</div>
              <table className={styles.ledgerTable}>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Status</th>
                    <th>Agent</th>
                    <th>Duration</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(envelope.step_ledger!).map(
                    ([key, entry]: [string, StepLedgerEntry]) => (
                      <tr key={key} className={entry.status === "failed" ? styles.rowFail : ""}>
                        <td className={styles.stepKey} title={key}>
                          {key.length > 30 ? key.slice(0, 30) + "…" : key}
                        </td>
                        <td>
                          <span className={entry.status === "complete" ? styles.statusDone : styles.statusFail}>
                            {entry.status}
                          </span>
                        </td>
                        <td>{entry.agent}</td>
                        <td>{formatMs(entry.durationMs)}</td>
                        <td className={styles.cellTime}>{formatTimestamp(entry.ts)}</td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
