"use client";

import styles from "./AgentChip.module.css";

interface AgentChipProps {
  name: string;
  working?: boolean;
  /** If provided, overrides the `working` prop based on active statuses */
  status?: string;
  /** Current task label — shown as tooltip */
  task?: string;
  onClick?: () => void;
}

const WORKING_STATUSES = new Set(["deploying", "needs_action", "online"]);

export function AgentChip({ name, working: workingProp = false, status, task, onClick }: AgentChipProps) {
  const working = status ? WORKING_STATUSES.has(status) : workingProp;
  const classes = [
    styles.chip,
    working ? styles.working : "",
    onClick ? styles.clickable : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
      title={task}
      id={`agent-chip-${name}`}
    >
      {working && <span className={styles.dot} />}
      {name}
    </span>
  );
}
