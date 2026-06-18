"use client";

import styles from "@/app/p/[id]/projects/page.module.css";

interface ProjectStatusBadgeProps {
  status: "active" | "complete" | "completed" | "paused" | "archived";
}

export function ProjectStatusBadge({ status }: ProjectStatusBadgeProps) {
  const cls =
    status === "active" ? styles.badgeActive
    : status === "complete" || status === "completed" ? styles.badgeComplete
    : status === "paused" ? styles.badgePaused
    : styles.badgeArchived;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}
