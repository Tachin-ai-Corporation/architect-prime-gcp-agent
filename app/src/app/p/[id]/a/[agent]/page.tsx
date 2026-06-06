"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import styles from "./page.module.css";

const TABS = [
  { key: "overview", label: "Overview", icon: "📊" },
  { key: "brain", label: "Brain", icon: "🧠" },
  { key: "skills", label: "Skills", icon: "⚡" },
  { key: "responsibilities", label: "Responsibilities", icon: "📌" },
  { key: "memory", label: "Memory", icon: "💾" },
  { key: "work", label: "Work", icon: "📋" },
  { key: "chat", label: "Chat", icon: "💬" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function AgentDeepDivePage({
  params,
}: {
  params: Promise<{ id: string; agent: string }>;
}) {
  const { id, agent } = use(params);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  /* Hash-based tab switching */
  useEffect(() => {
    const readHash = () => {
      const hash = window.location.hash.replace("#", "");
      if (TABS.some((t) => t.key === hash)) {
        setActiveTab(hash as TabKey);
      }
    };

    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const handleTabClick = (key: TabKey) => {
    setActiveTab(key);
    window.location.hash = key;
  };

  const currentTab = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  return (
    <div className={styles.agentPage}>
      {/* ---- Header ---- */}
      <div className={styles.header}>
        <Link href={`/p/${id}`} className={styles.backLink}>
          ← Back to Hub
        </Link>
        <h1 className={styles.agentName}>{agent}</h1>
        <p className={styles.subtitle}>Agent Deep Dive</p>
      </div>

      {/* ---- Tab Bar ---- */}
      <div className={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ""}`}
            onClick={() => handleTabClick(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Tab Content ---- */}
      <div className={styles.tabContent}>
        <span className={styles.tabIcon}>{currentTab.icon}</span>
        <div className={styles.tabTitle}>{currentTab.label}</div>
        <div className={styles.tabDesc}>
          {currentTab.label} — Coming in Phase 2
        </div>
      </div>
    </div>
  );
}
