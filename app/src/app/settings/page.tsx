"use client";

import { useState, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import { GeneralTab } from "@/components/settings/GeneralTab";
import { IntegrationTab } from "@/components/settings/IntegrationTab";
import { SecurityTab } from "@/components/settings/SecurityTab";
import { SecretsTab } from "@/components/settings/SecretsTab";
import { SystemTab } from "@/components/settings/SystemTab";

type SettingsTab = "general" | "integration" | "security" | "secrets" | "system";

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "⚙️" },
  { id: "integration", label: "Integration", icon: "🔗" },
  { id: "security", label: "Security", icon: "🔐" },
  { id: "secrets", label: "Secrets", icon: "🔑" },
  { id: "system", label: "System", icon: "🖥️" },
];

function SettingsPageInner() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [activeTab, setActiveTabState] = useState<SettingsTab>(
    tabParam && TABS.find((t) => t.id === tabParam) ? (tabParam as SettingsTab) : "general"
  );

  const setActiveTab = useCallback((tab: SettingsTab) => {
    setActiveTabState(tab);
    window.history.replaceState(null, "", `/settings?tab=${tab}`);
  }, []);

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

export default function DashboardSettingsPage() {
  return (
    <Suspense>
      <SettingsPageInner />
    </Suspense>
  );
}
