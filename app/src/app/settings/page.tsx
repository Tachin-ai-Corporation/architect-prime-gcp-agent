"use client";

import Link from "next/link";
import styles from "./page.module.css";
import { GeneralTab } from "@/components/settings/GeneralTab";
import { IntegrationTab } from "@/components/settings/IntegrationTab";
import { SecurityTab } from "@/components/settings/SecurityTab";
import { SecretsTab } from "@/components/settings/SecretsTab";
import { SystemTab } from "@/components/settings/SystemTab";
import { useHashTab } from "@/hooks/useHashTab";

const TABS = [
  { id: "general", label: "General", icon: "⚙️" },
  { id: "integration", label: "Integration", icon: "🔗" },
  { id: "security", label: "Security", icon: "🔐" },
  { id: "secrets", label: "Secrets", icon: "🔑" },
  { id: "system", label: "System", icon: "🖥️" },
] as const;

type SettingsTab = (typeof TABS)[number]["id"];
const TAB_KEYS = TABS.map((t) => t.id) as SettingsTab[];

export default function DashboardSettingsPage() {
  // Hash-synced, matching the deep-dive tabs (one tab mechanism across the app).
  const [activeTab, setActiveTab] = useHashTab<SettingsTab>(TAB_KEYS, "general");

  return (
    <div className={styles.settingsShell} id="dashboard-settings-page">
      <div className={styles.settingsContainer}>
        {/* ---- Header ---- */}
        <header className={styles.settingsHeader}>
          <span className={styles.settingsHeaderIcon}>⚙️</span>
          <div>
            <h1 className={styles.settingsTitle}>Settings</h1>
            <div className={styles.settingsSubtitle}>Dashboard configuration</div>
          </div>
          <Link href="/" className={styles.settingsBack} id="settings-back-btn">
            ← Home
          </Link>
        </header>

        {/* ---- Tab Bar ---- */}
        <nav className={styles.tabBar} id="settings-tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={styles.tabIcon}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>

        {/* ---- Tab Content ---- */}
        <div className={styles.tabContent}>
          {activeTab === "general" && <GeneralTab />}
          {activeTab === "integration" && <IntegrationTab />}
          {activeTab === "security" && <SecurityTab />}
          {activeTab === "secrets" && <SecretsTab />}
          {activeTab === "system" && <SystemTab />}
        </div>
      </div>
    </div>
  );
}
