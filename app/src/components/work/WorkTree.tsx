"use client";

import { useState } from "react";
import styles from "@/app/page.module.css";
import { useWorkEnvelopes } from "./useWorkEnvelopes";
import type { WorkTreeNode } from "./useWorkEnvelopes";

interface WorkTreeProps {
  primeId: string;
  onSelectEnvelope: (id: string) => void;
  selectedId: string | null;
}

const STATUS_ICONS: Record<string, string> = {
  complete: "🟢",
  active: "🔵",
  waiting: "🟡",
  needs_input: "🟡",
  failed: "🔴",
  pending: "⚪",
  archived: "⚪",
};

const TYPE_LABELS: Record<string, string> = {
  M: "Mission",
  C: "Checkpoint",
  T: "Task",
};

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function formatDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return null;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function WorkNode({
  node,
  depth,
  onSelect,
  selectedId,
}: {
  node: WorkTreeNode;
  depth: number;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const { envelope } = node;
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === envelope.id;
  const statusIcon = STATUS_ICONS[envelope.status] || "⚪";
  const duration = formatDuration(envelope.started_at, envelope.completed_at);
  const agentName =
    envelope.type === "T" && envelope.source_meta?.agent
      ? String(envelope.source_meta.agent)
      : null;

  return (
    <div className={styles["work-node"]}>
      <div
        className={`${styles["work-node-header"]} ${isSelected ? styles["work-node-selected"] : ""}`}
        onClick={() => onSelect(envelope.id)}
        style={{ paddingLeft: depth * 20 + 8 }}
      >
        {hasChildren ? (
          <button
            className={styles["work-node-expand"]}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className={styles["work-node-expand"]} style={{ visibility: "hidden" }}>
            ▸
          </span>
        )}
        <span className={styles["work-node-status"]}>{statusIcon}</span>
        <span
          className={styles["work-node-badge"]}
          data-type={envelope.type}
        >
          {envelope.type}
        </span>
        <span className={styles["work-node-text"]}>
          {truncate(envelope.instruction || envelope.intent, 80)}
        </span>
        {agentName && (
          <span className={styles["work-node-agent"]}>{agentName}</span>
        )}
        {duration && (
          <span className={styles["work-node-duration"]}>{duration}</span>
        )}
        <span className={styles["work-node-owner"]}>{envelope.owner}</span>
      </div>
      {expanded && hasChildren && (
        <div className={styles["work-node-children"]}>
          {node.children.map((child) => (
            <WorkNode
              key={child.envelope.id}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkTree({ primeId, onSelectEnvelope, selectedId }: WorkTreeProps) {
  const { tree, loading, error } = useWorkEnvelopes(primeId);

  if (loading) {
    return (
      <div className={styles["work-tree"]}>
        <div style={{ padding: 24, color: "var(--text-tertiary)", fontSize: 13 }}>
          Loading work tree…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles["work-tree"]}>
        <div style={{ padding: 24, color: "var(--accent-danger)", fontSize: 13 }}>
          Error loading work: {error}
        </div>
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className={styles["work-tree"]}>
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
            No work items yet
          </div>
          <div style={{ fontSize: 12 }}>
            Work envelopes from the last 7 days will appear here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles["work-tree"]}>
      <div style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>
        Work Tree ({tree.length} top-level)
      </div>
      {tree.map((node) => (
        <WorkNode
          key={node.envelope.id}
          node={node}
          depth={0}
          onSelect={onSelectEnvelope}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}
