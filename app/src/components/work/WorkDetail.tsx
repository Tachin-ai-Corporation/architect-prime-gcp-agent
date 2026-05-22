"use client";

import { useState } from "react";
import styles from "@/app/page.module.css";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import type { WorkEnvelope } from "@/lib/types";

interface WorkDetailProps {
  envelope: WorkEnvelope | null;
  onNavigate: (id: string) => void;
}

const STATUS_ICONS: Record<string, string> = {
  complete: "🟢",
  active: "🔵",
  waiting: "🟡",
  needs_input: "🟡",
  blocked: "🚫",
  cancelled: "⚪",
  failed: "🔴",
  pending: "⚪",
  archived: "⚪",
};

const TYPE_LABELS: Record<string, string> = {
  R: "Responsibility",
  M: "Mission",
  C: "Checkpoint",
  T: "Task",
};

function formatTimestamp(ts: string | null): string {
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

export function WorkDetail({ envelope, onNavigate }: WorkDetailProps) {
  const [contextExpanded, setContextExpanded] = useState(false);

  if (!envelope) {
    return (
      <div className={styles["work-detail"]}>
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
            Select a work item
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Click an item in the tree to view its details.
          </div>
        </div>
      </div>
    );
  }

  const statusIcon = STATUS_ICONS[envelope.status] || "⚪";
  const typeLabel = TYPE_LABELS[envelope.type] || envelope.type;
  const duration = formatDuration(envelope.started_at, envelope.completed_at);

  return (
    <div className={styles["work-detail"]}>
      {/* Header: Type + Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span
          className={styles["work-node-badge"]}
          data-type={envelope.type}
          style={{ fontSize: 12, padding: "3px 8px" }}
        >
          {typeLabel}
        </span>
        <span style={{ fontSize: 14 }}>{statusIcon}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{envelope.status}</span>
        {envelope.owner && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-tertiary)" }}>
            Owner: <strong style={{ color: "var(--text-secondary)" }}>{envelope.owner}</strong>
          </span>
        )}
      </div>

      {envelope.status === "blocked" && envelope.blocker && (
        <div style={{
          marginTop: 8, padding: "10px 12px", background: "rgba(239, 68, 68, 0.08)",
          border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: 8, fontSize: 13,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 14 }}>🚫</span>
            <span style={{ fontWeight: 600, color: "#ef4444" }}>Blocked</span>
            {envelope.blocker_type && (
              <span style={{
                fontSize: 10, padding: "2px 6px", borderRadius: 4,
                background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", fontWeight: 600,
                textTransform: "uppercase",
              }}>{envelope.blocker_type}</span>
            )}
          </div>
          <div style={{ color: "var(--text-secondary)" }}>{envelope.blocker}</div>
        </div>
      )}
      {envelope.status === "cancelled" && (
        <div style={{
          marginTop: 8, padding: "10px 12px", background: "rgba(107, 114, 128, 0.08)",
          border: "1px solid rgba(107, 114, 128, 0.2)", borderRadius: 8, fontSize: 13,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 14 }}>⚪</span>
            <span style={{ fontWeight: 600, color: "var(--text-tertiary)" }}>Cancelled</span>
          </div>
          {envelope.cancelled_reason && (
            <div style={{ color: "var(--text-secondary)" }}>{envelope.cancelled_reason}</div>
          )}
        </div>
      )}

      {/* Instruction */}
      <div className={styles["work-detail-section"]}>
        <div className={styles["work-detail-label"]}>Instruction</div>
        <div style={{ fontSize: 14, lineHeight: 1.6 }}>
          {envelope.instruction || <span style={{ color: "var(--text-tertiary)" }}>No instruction</span>}
        </div>
      </div>

      {/* Accept Criteria */}
      {envelope.accept_criteria && (
        <div className={styles["work-detail-section"]}>
          <div className={styles["work-detail-label"]}>Accept Criteria</div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-secondary)" }}>
            {envelope.accept_criteria}
          </div>
        </div>
      )}

      {/* Output */}
      {envelope.output && (
        <div className={styles["work-detail-section"]}>
          <div className={styles["work-detail-label"]}>Output</div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <MarkdownMessage text={envelope.output} />
          </div>
        </div>
      )}

      {/* Error */}
      {envelope.error && (
        <div className={styles["work-detail-section"]}>
          <div className={styles["work-detail-label"]} style={{ color: "#f85149" }}>Error</div>
          <div style={{
            fontSize: 13,
            lineHeight: 1.5,
            padding: "10px 12px",
            background: "rgba(248, 81, 73, 0.08)",
            border: "1px solid rgba(248, 81, 73, 0.25)",
            borderRadius: 6,
            color: "#f85149",
          }}>
            {envelope.error}
          </div>
        </div>
      )}

      {/* Context Summary (collapsible) */}
      {envelope.context_summary && (
        <div className={styles["work-detail-section"]}>
          <button
            onClick={() => setContextExpanded(!contextExpanded)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: 0,
              color: "var(--text-tertiary)",
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {contextExpanded ? "▾" : "▸"} Context Summary
          </button>
          {contextExpanded && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8, lineHeight: 1.5 }}>
              {envelope.context_summary}
            </div>
          )}
        </div>
      )}

      {/* Timestamps */}
      <div className={styles["work-detail-section"]}>
        <div className={styles["work-detail-label"]}>Timestamps</div>
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>Created</span>
            <span>{formatTimestamp(envelope.created_at)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>Started</span>
            <span>{formatTimestamp(envelope.started_at)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>Completed</span>
            <span>{formatTimestamp(envelope.completed_at)}</span>
          </div>
          {duration && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-tertiary)" }}>Duration</span>
              <span style={{ fontWeight: 600 }}>{duration}</span>
            </div>
          )}
        </div>
      </div>

      {/* Parent Link */}
      {envelope.parent_id && (
        <div className={styles["work-detail-section"]}>
          <div className={styles["work-detail-label"]}>Parent</div>
          <button
            onClick={() => onNavigate(envelope.parent_id!)}
            style={{
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              padding: "6px 10px",
              cursor: "pointer",
              fontSize: 12,
              color: "var(--accent-primary-hover)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            ↑ {envelope.parent_id}
          </button>
        </div>
      )}

      {/* Children Links */}
      {envelope.children && envelope.children.length > 0 && (
        <div className={styles["work-detail-section"]}>
          <div className={styles["work-detail-label"]}>
            Children ({envelope.children.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {envelope.children.map((childId) => (
              <button
                key={childId}
                onClick={() => onNavigate(childId)}
                style={{
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  cursor: "pointer",
                  fontSize: 12,
                  color: "var(--accent-primary-hover)",
                  fontFamily: "'JetBrains Mono', monospace",
                  textAlign: "left",
                }}
              >
                → {childId}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className={styles["work-detail-section"]}>
        <div className={styles["work-detail-label"]}>Metadata</div>
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>ID</span>
            <code className="mono" style={{ fontSize: 11 }}>{envelope.id}</code>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>Iteration</span>
            <span>{envelope.iteration}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>Source</span>
            <span>{envelope.source_channel || "—"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
