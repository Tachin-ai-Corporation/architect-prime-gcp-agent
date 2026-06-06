"use client";

import Link from "next/link";
import styles from "./AgentHeader.module.css";

interface AgentHeaderProps {
  primeId: string;
  agentName: string;
  status?: string;
  specialty?: string;
  email?: string;
}

export function AgentHeader({ primeId, agentName, status, specialty, email }: AgentHeaderProps) {
  const badgeClass = status
    ? `badge badge-${status}`
    : "badge badge-offline";

  return (
    <div className={styles.header}>
      <div className={styles.headerLeft}>
        <div className={styles.avatar}>
          {agentName.charAt(0).toUpperCase()}
        </div>
        <div className={styles.info}>
          <div className={styles.nameRow}>
            <h1 className={styles.name}>{agentName}</h1>
            <span className={badgeClass}>{status || "unknown"}</span>
          </div>
          <div className={styles.meta}>
            {specialty && <span className={styles.specialty}>{specialty}</span>}
            {email && <span className={styles.email}>{email}</span>}
          </div>
        </div>
      </div>
      <div className={styles.actions}>
        <Link href={`/p/${primeId}`} className="btn btn-ghost btn-sm">
          ← Hub
        </Link>
      </div>
    </div>
  );
}
