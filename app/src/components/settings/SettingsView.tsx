"use client";

import { useState } from "react";
import styles from "../../app/page.module.css";
import { GeneralTab } from "./GeneralTab";
import { ModelsTab } from "./ModelsTab";
import { IntegrationTab } from "./IntegrationTab";
import { SystemTab } from "./SystemTab";

/* ---- Shared types (re-exported for child tabs) ---- */
export interface SetupState {
  hasPrimes: boolean;
  dwdConfigured: boolean;
  projectId: string;
  dwdSignerSA: string;
  dwdClientId: string;
  agentEmailDomain: string;
}

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export interface SettingsViewProps {
  activePrime: string;
  setup: SetupState;
  setSetup: React.Dispatch<React.SetStateAction<SetupState>>;
  primeCount: number;
  fleetCount: number;
  versionInfo: VersionInfo | null;
  upgrading: boolean;
  setUpgrading: (v: boolean) => void;
  copied: string;
  setCopied: (v: string) => void;
  copyToClipboard: (text: string, label: string) => void;
  dwdTestEmail: string;
  setDwdTestEmail: (v: string) => void;
  dwdTesting: boolean;
  dwdTestResult: { success: boolean; message?: string; error?: string; hint?: string } | null;
  handleDwdTest: () => void;
}

type SettingsTab = "general" | "models" | "integration" | "system";

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "⚙️" },
  { id: "models", label: "AI Models", icon: "🧠" },
  { id: "integration", label: "Integration", icon: "🔗" },
  { id: "system", label: "System", icon: "🖥️" },
];

export function SettingsView(props: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  return (
    <div className={styles["settings-panel"]}>
      {/* Sub-tab navigation */}
      <div className={styles["settings-tabs"]}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles["settings-tab"]} ${activeTab === tab.id ? styles["settings-tab-active"] : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className={styles["settings-tab-icon"]}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={styles["settings-tab-content"]}>
        {activeTab === "general" && (
          <GeneralTab
            setup={props.setup}
            setSetup={props.setSetup}
            primeCount={props.primeCount}
            fleetCount={props.fleetCount}
            copied={props.copied}
            setCopied={props.setCopied}
          />
        )}
        {activeTab === "models" && (
          <ModelsTab
            activePrime={props.activePrime}
            projectId={props.setup.projectId}
          />
        )}
        {activeTab === "integration" && (
          <IntegrationTab
            setup={props.setup}
            copied={props.copied}
            copyToClipboard={props.copyToClipboard}
            dwdTestEmail={props.dwdTestEmail}
            setDwdTestEmail={props.setDwdTestEmail}
            dwdTesting={props.dwdTesting}
            dwdTestResult={props.dwdTestResult}
            handleDwdTest={props.handleDwdTest}
          />
        )}
        {activeTab === "system" && (
          <SystemTab
            activePrime={props.activePrime}
            versionInfo={props.versionInfo}
            upgrading={props.upgrading}
            setUpgrading={props.setUpgrading}
          />
        )}
      </div>
    </div>
  );
}
