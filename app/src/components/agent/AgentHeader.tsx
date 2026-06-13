"use client";

import Link from "next/link";
import styles from "./AgentHeader.module.css";

interface Tab {
  key: string;
  label: string;
  icon: string;
}

interface AgentHeaderProps {
  primeId: string;
  agentName: string;
  status?: string;
  specialty?: string;
  email?: string;
  tabs?: Tab[];
  activeTab?: string;
  onTabClick?: (key: string) => void;
}

export function AgentHeader({
  primeId,
  agentName,
  status,
  specialty,
  email,
  tabs,
  activeTab,
  onTabClick,
}: AgentHeaderProps) {
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

      {/* ---- Mini Card Tabs ---- */}
      {tabs && tabs.length > 0 && (
        <div className={styles.miniTabs}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.miniTab} ${activeTab === tab.key ? styles.miniTabActive : ""}`}
              onClick={() => onTabClick?.(tab.key)}
            >
              <span className={styles.miniTabIcon}>{tab.icon}</span>
              <span className={styles.miniTabLabel}>{tab.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        <Link href={`/p/${primeId}`} className="btn btn-ghost btn-sm">
          ← Hub
        </Link>
      </div>
    </div>
  );
}
