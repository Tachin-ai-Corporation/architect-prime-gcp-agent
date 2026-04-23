"use client";

import styles from "../../app/page.module.css";
import type { VersionInfo } from "./SettingsView";

async function api<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface SystemTabProps {
  versionInfo: VersionInfo | null;
  upgrading: boolean;
  setUpgrading: (v: boolean) => void;
}

export function SystemTab({ versionInfo, upgrading, setUpgrading }: SystemTabProps) {
  return (
    <>
      {/* Version & Upgrade */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Version &amp; Upgrade</div>
        {versionInfo ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div className={styles["settings-row"]}>
              <div className={styles["settings-label"]}>Current Version</div>
              <div className={styles["settings-value"]}><code className="mono">{versionInfo.currentVersion}</code></div>
            </div>
            <div className={styles["settings-row"]}>
              <div className={styles["settings-label"]}>Latest Tag</div>
              <div className={styles["settings-value"]}><code className="mono">{versionInfo.latestTag}</code></div>
            </div>
            <div className={styles["settings-row"]}>
              <div className={styles["settings-label"]}>Main Branch</div>
              <div className={styles["settings-value"]}>
                <code className="mono">{versionInfo.mainHeadSha || "unknown"}</code>
                {versionInfo.deployedCommit && versionInfo.mainHeadSha &&
                 versionInfo.deployedCommit !== versionInfo.mainHeadSha && (
                  <span className="badge badge-deploying" style={{ marginLeft: 8, fontSize: 10 }}>new commits</span>
                )}
              </div>
            </div>
            {versionInfo.deployedCommit && (
              <div className={styles["settings-row"]}>
                <div className={styles["settings-label"]}>Deployed Commit</div>
                <div className={styles["settings-value"]}><code className="mono">{versionInfo.deployedCommit}</code></div>
              </div>
            )}
            <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn btn-primary" onClick={async () => {
                setUpgrading(true);
                const result = await api<{success: boolean; message?: string; error?: string; version?: string}>("/api/upgrade", { method: "POST" });
                setUpgrading(false);
                if (result?.success) alert(result.message || "Dashboard upgrade initiated!");
                else alert(result?.error || "Upgrade failed");
              }} disabled={upgrading}>
                {upgrading ? "Upgrading..." : versionInfo.updateAvailable ? "⬆ Upgrade Dashboard" : "↻ Redeploy Dashboard"}
              </button>
              {versionInfo.updateAvailable && (
                <span style={{ fontSize: 12, color: "var(--accent-warning)" }}>
                  Update available: {versionInfo.latestVersion}
                </span>
              )}
              {!versionInfo.updateAvailable && (
                <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                  Up to date — redeploy will rebuild from main
                </span>
              )}
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Loading version info...</div>
        )}
      </div>
    </>
  );
}
