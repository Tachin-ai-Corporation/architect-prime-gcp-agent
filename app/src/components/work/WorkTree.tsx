"use client";

import { useState, useCallback } from "react";
import styles from "./WorkTree.module.css";
import type { TreeNode } from "./useWorkEnvelopes";
import { formatAgentDisplayName } from "@/components/AgentChip";

/* ---- Props ---- */
interface WorkTreeProps {
  nodes: TreeNode[];
  onSelectNode: (id: string) => void;
  selectedId: string | null;
}

/* ---- Helpers ---- */

/** Check if a node or any descendant is active/waiting. */
function hasActiveDescendant(node: TreeNode): boolean {
  if (node.status === "active" || node.status === "waiting" || node.status === "needs_input") {
    return true;
  }
  for (const child of node.children) {
    if (hasActiveDescendant(child)) return true;
  }
  return false;
}

/** Format elapsed time from a date string to now. */
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

/** Format duration between two timestamps. */
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

/** Format a timestamp for display. */
function formatDate(ts: string | null): string | null {
  if (!ts) return null;
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

/** Truncate text. */
function truncate(text: string | null, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/* ---- Node Component ---- */

function TreeNodeRow({
  node,
  depth,
  onSelectNode,
  selectedId,
}: {
  node: TreeNode;
  depth: number;
  onSelectNode: (id: string) => void;
  selectedId: string | null;
}) {
  const hasKids = node.children.length > 0;
  const shouldAutoExpand =
    node.status === "active" ||
    node.status === "waiting" ||
    node.status === "needs_input" ||
    hasActiveDescendant(node);
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  const depthClass =
    depth === 0 ? styles.d0 : depth === 1 ? styles.d1 : styles.d2;

  // Status dot class
  const dotStatus =
    node.status === "complete"
      ? "done"
      : node.status === "active"
        ? "active"
        : node.status === "waiting" || node.status === "needs_input"
          ? "waiting"
          : node.status === "failed"
            ? "failed"
            : "pending";

  // Label class
  const labelClass =
    node.status === "active"
      ? styles.activeL
      : node.status === "waiting" || node.status === "needs_input"
        ? styles.waitingL
        : node.status === "complete"
          ? styles.doneL
          : "";

  // Type tag
  const tagClass = node.type === "M" ? `${styles.tag} ${styles.mTag}` : styles.tag;

  // Meta pieces
  const metaParts: string[] = [];
  const metaJsx: React.ReactNode[] = [];

  if (node.owner) metaJsx.push(<span key="owner" title={node.owner}>{formatAgentDisplayName(node.owner)}</span>);
  if (node.project_id) metaJsx.push(<span key="proj">{node.project_id}</span>);

  if (node.status === "active" && node.started_at) {
    const el = elapsedSince(node.started_at);
    if (el) metaJsx.push(<span key="elapsed" className={styles.live}>{el} elapsed</span>);
  }

  if ((node.status === "waiting" || node.status === "needs_input") && node.blocked_at) {
    const wt = elapsedSince(node.blocked_at);
    if (wt) metaJsx.push(<span key="wait" className={styles.warn}>⚡ {wt}</span>);
  }

  if (node.status === "complete") {
    const dur = formatDuration(node.started_at, node.completed_at);
    if (dur) metaJsx.push(<span key="dur">{dur}</span>);
    const comp = formatDate(node.completed_at);
    if (comp) metaJsx.push(<span key="comp">{comp}</span>);
  }

  const handleChevClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setExpanded((prev) => !prev);
    },
    []
  );

  const handleRowClick = useCallback(() => {
    onSelectNode(node.id);
  }, [node.id, onSelectNode]);

  // Determine waiting callout text
  const waitingText =
    (node.status === "waiting" || node.status === "needs_input") && node.blocker
      ? node.blocker
      : (node.status === "waiting" || node.status === "needs_input") && node.output
        ? node.output
        : null;

  return (
    <>
      <div
        className={`${styles.row} ${depthClass}`}
        onClick={handleRowClick}
      >
        <span className={`${styles.rDot} ${styles[dotStatus] || ""}`} />
        <div className={styles.rBody}>
          <div className={`${styles.rLabel} ${labelClass}`}>
            <span className={tagClass}>{node.type}</span>
            {truncate(node.title || node.instruction || node.intent, 100)}
          </div>

          {metaJsx.length > 0 && (
            <div className={styles.rMeta}>
              {metaJsx.map((part, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {part}
                </span>
              ))}
            </div>
          )}

          {node.status === "active" && node.iteration > 0 && (
            <div className={styles.rProg}>
              <div
                className={styles.rProgFill}
                style={{ width: `${Math.min(node.iteration * 10, 100)}%` }}
              />
            </div>
          )}

          {waitingText && (
            <div className={styles.rAsk}>
              <strong>{node.owner ? formatAgentDisplayName(node.owner) : "Agent"} asks:</strong> {truncate(waitingText, 200)}
              {node.blocked_at && (
                <div className={styles.timer}>
                  Waiting {elapsedSince(node.blocked_at) || ""}
                </div>
              )}
            </div>
          )}
        </div>

        {hasKids && (
          <button
            className={`${styles.rChev} ${expanded ? styles.rChevOpen : ""}`}
            onClick={handleChevClick}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            ›
          </button>
        )}
      </div>

      {hasKids && (
        <div className={expanded ? styles.rKidsOpen : styles.rKids}>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              depth={Math.min(depth + 1, 2)}
              onSelectNode={onSelectNode}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ---- Exported WorkTree ---- */

export function WorkTree({ nodes, onSelectNode, selectedId }: WorkTreeProps) {
  if (nodes.length === 0) {
    return (
      <div className={styles.tree}>
        <div className={styles.emptyTree}>Nothing here</div>
      </div>
    );
  }

  return (
    <div className={styles.tree}>
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.id}
          node={node}
          depth={0}
          onSelectNode={onSelectNode}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}
