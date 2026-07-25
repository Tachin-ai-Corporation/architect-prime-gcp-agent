"use client";

import { useEffect, useCallback } from "react";
import styles from "./WorkDetail.module.css";
import { WorkRespondForm } from "./WorkRespondForm";
import { VerdictCard } from "./VerdictCard";
import { InternalsPanel } from "./InternalsPanel";
import type { WorkEnvelope } from "@/lib/types";
import { formatAgentDisplayName } from "@/components/AgentChip";

/* ---- Props ---- */
interface WorkDetailProps {
  envelope: WorkEnvelope | null;
  allEnvelopes: WorkEnvelope[];
  onClose: () => void;
  primeId: string;
}

/* ---- Helpers ---- */

const TYPE_LABELS: Record<string, string> = {
  R: "RESPONSIBILITY",
  M: "MISSION",
  C: "CHECKPOINT",
  T: "TASK",
};

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

function formatDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return null;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function elapsedSince(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "active": return "In progress";
    case "complete": return "Complete";
    case "waiting":
    case "needs_input": return "Needs input";
    case "needs_review": return "Needs Review";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "blocked": return "Blocked";
    case "planned": return "Planned";
    case "awaiting_approval": return "Awaiting Approval";
    case "rejected": return "Rejected";
    case "timed_out": return "Timed Out";
    case "aborted": return "Aborted";
    case "queued": return "Queued";
    default: return "Pending";
  }
}

function statusChipClass(status: string): string {
  switch (status) {
    case "active": return styles.chipAct;
    case "complete": return styles.chipDone;
    case "waiting":
    case "needs_input":
    case "needs_review":
    case "awaiting_approval": return styles.chipWait;
    case "failed":
    case "rejected":
    case "aborted": return styles.chipFail;
    case "planned": return styles.chipPlanned;
    case "timed_out": return styles.chipTimeout;
    case "queued": return styles.chipQueued;
    default: return "";
  }
}

function dotColor(status: string): string {
  switch (status) {
    case "complete": return "#3BAA78";
    case "active": return "#1F9A9B";
    case "waiting":
    case "needs_input":
    case "needs_review":
    case "awaiting_approval": return "#D6A83A";
    case "failed":
    case "rejected":
    case "aborted": return "#D84F45";
    case "planned": return "#9B59B6";
    case "timed_out": return "#E67E22";
    case "queued": return "#5B8DEF";
    default: return "#566373";
  }
}

/* ---- Component ---- */

export function WorkDetail({ envelope, allEnvelopes, onClose, primeId }: WorkDetailProps) {
  // Close on Escape
  useEffect(() => {
    if (!envelope) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [envelope, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (envelope) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [envelope]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  if (!envelope) return null;

  const typeLabel = TYPE_LABELS[envelope.type] || envelope.type;
  const duration = formatDuration(envelope.started_at, envelope.completed_at);
  const elapsed = envelope.status === "active" ? elapsedSince(envelope.started_at) : null;

  // Find children envelopes
  const childEnvelopes = allEnvelopes.filter((e) => e.parent_id === envelope.id);
  childEnvelopes.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));

  // Title class
  const titleClass = `${styles.mTitle} ${
    envelope.status === "active"
      ? styles.mTitleAct
      : envelope.status === "waiting" || envelope.status === "needs_input"
        ? styles.mTitleWait
        : ""
  }`;

  // No real progress metric exists in the envelope schema — the fabricated
  // iteration×10 "percent" bar was removed. Active state is shown by status + iteration.
  const progress: number | null = null;

  // Waiting/needs_input text
  const waitingText =
    (envelope.status === "waiting" || envelope.status === "needs_input")
      ? (envelope.blocker || envelope.output || null)
      : null;

  const childLabel = envelope.type === "M" ? "Checkpoints" : "Tasks";

  return (
    <div
      className={`${styles.overlay} ${styles.overlayOpen}`}
      onClick={handleBackdropClick}
    >
      <div className={styles.modal}>
        {/* Top bar */}
        <div className={styles.modalTop}>
          <span className={styles.mType}>{typeLabel}</span>
          <button className={styles.mClose} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className={styles.mBody}>
          {/* Title */}
          <div className={titleClass}>
            {envelope.title || envelope.instruction || envelope.intent || "Untitled"}
          </div>

          {/* Chips */}
          <div className={styles.mChips}>
            <span className={`${styles.mChip} ${statusChipClass(envelope.status)}`}>
              {statusLabel(envelope.status)}
            </span>
            {envelope.owner && (
              <span className={styles.mChip} title={envelope.owner}>{formatAgentDisplayName(envelope.owner)}</span>
            )}
            {envelope.project_id && (
              <span className={styles.mChip}>{envelope.project_id}</span>
            )}
          </div>

          {/* Progress bar */}
          {progress !== null && progress > 0 && progress < 100 && (
            <div className={styles.mProg}>
              <div className={styles.mProgBar}>
                <div
                  className={styles.mProgFill}
                  style={{
                    width: `${progress}%`,
                    background:
                      envelope.status === "waiting" || envelope.status === "needs_input"
                        ? "#D6A83A"
                        : "#1F9A9B",
                  }}
                />
              </div>
              <div className={styles.mProgLbl}>
                <span>{progress}%</span>
                {elapsed && <span>{elapsed} elapsed</span>}
              </div>
            </div>
          )}

          {/* Definition of Done */}
          {envelope.accept_criteria && (
            <div className={styles.mSec}>
              <div className={styles.mSecTitle}>Definition of done</div>
              <div className={styles.mBlock}>{envelope.accept_criteria}</div>
            </div>
          )}

          {/* Instruction (shown separately when title differs) */}
          {envelope.instruction && envelope.title && envelope.instruction !== envelope.title && (
            <div className={styles.mSec}>
              <div className={styles.mSecTitle}>Instruction</div>
              <div className={styles.mBlock}>{envelope.instruction}</div>
            </div>
          )}

          {/* Waiting / Needs Input callout */}
          {waitingText && (
            <div className={styles.mSec}>
              <div className={styles.mSecTitle}>Waiting for input</div>
              <div className={`${styles.mBlock} ${styles.mBlockWarn}`}>
                <strong>{envelope.owner ? formatAgentDisplayName(envelope.owner) : "Agent"} asks:</strong> {waitingText}
                {envelope.blocked_at && (
                  <div className={styles.timer}>
                    Waiting {elapsedSince(envelope.blocked_at) || ""}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Respond Form for needs_input */}
          {(envelope.status === "needs_input" || envelope.status === "waiting") && (
            <div className={styles.respondWrap}>
              <WorkRespondForm
                envelope={envelope}
                primeId={primeId}
                onResponded={onClose}
              />
            </div>
          )}

          {/* Verdict card — parse cerebellum report_pass/report_fail from output */}
          {envelope.output && <VerdictCard output={envelope.output} />}

          {/* Output */}
          {envelope.output && envelope.status !== "waiting" && envelope.status !== "needs_input" && (
            <div className={styles.mSec}>
              <div className={styles.mSecTitle}>Output</div>
              <div className={styles.mBlock}>{envelope.output}</div>
            </div>
          )}

          {/* Internals — step ledger, claim state, checkpoint progress */}
          <InternalsPanel envelope={envelope} />

          {/* Error */}
          {envelope.error && (
            <div className={styles.mSec}>
              <div className={styles.mSecTitle}>Error</div>
              <div className={`${styles.mBlock} ${styles.mBlockError}`}>
                {envelope.error}
              </div>
            </div>
          )}

          {/* Details grid */}
          <div className={styles.mSec}>
            <div className={styles.mSecTitle}>Details</div>
            <div className={styles.mGrid}>
              <span className={styles.mk}>Created</span>
              <span className={styles.mv}>{formatTimestamp(envelope.created_at)}</span>
              {envelope.started_at && (
                <>
                  <span className={styles.mk}>Started</span>
                  <span className={styles.mv}>{formatTimestamp(envelope.started_at)}</span>
                </>
              )}
              {envelope.completed_at && (
                <>
                  <span className={styles.mk}>Completed</span>
                  <span className={styles.mv}>{formatTimestamp(envelope.completed_at)}</span>
                </>
              )}
              {duration && (
                <>
                  <span className={styles.mk}>Duration</span>
                  <span className={styles.mv}>{duration}</span>
                </>
              )}

              <span className={styles.mk}>ID</span>
              <span className={`${styles.mv} ${styles.mvId}`}>{envelope.id}</span>
              {envelope.depends_on && envelope.depends_on.length > 0 && (
                <>
                  <span className={styles.mk}>Depends On</span>
                  <span className={styles.mv}>{envelope.depends_on.join(", ")}</span>
                </>
              )}
              {envelope.plan_id && (
                <>
                  <span className={styles.mk}>Plan</span>
                  <span className={styles.mv}>{envelope.plan_id}</span>
                </>
              )}
            </div>
          </div>

          {/* Children list */}
          {childEnvelopes.length > 0 && (
            <div className={styles.mSec}>
              <div className={styles.mSecTitle}>{childLabel}</div>
              <div className={styles.mKids}>
                {childEnvelopes.map((child) => (
                  <div key={child.id} className={styles.mKid}>
                    <span
                      className={styles.mkDot}
                      style={{ background: dotColor(child.status) }}
                    />
                    <span className={styles.mkText}>
                      <strong>{child.title || child.instruction || child.intent || child.id}</strong>
                      {child.owner && ` — ${formatAgentDisplayName(child.owner)}`}
                      {child.status === "complete" &&
                        formatDuration(child.started_at, child.completed_at) &&
                        ` · ${formatDuration(child.started_at, child.completed_at)}`}
                      {child.status === "active" && child.iteration > 0 &&
                        ` · iter ${child.iteration}`}
                      {(child.status === "waiting" || child.status === "needs_input") && (
                        <span className={styles.mkNeedsInput}> · needs input</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
