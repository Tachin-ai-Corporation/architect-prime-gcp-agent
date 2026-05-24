"use client";

import { useState } from "react";
import styles from "../../app/page.module.css";
import { useDialog } from "@/components/DialogProvider";
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
  const dialog = useDialog();
  const [buildStatus, setBuildStatus] = useState<string | null>(null);

  const handleUpgradeDashboard = async () => {
    setUpgrading(true);
    setBuildStatus("Submitting build...");

    const result = await api<{
      success: boolean;
      message?: string;
      error?: string;
      buildId?: string;
      version?: string;
      ref?: string;
      commit?: string;
    }>("/api/upgrade", { method: "POST" });

    if (result?.success && result.buildId) {
      setBuildStatus(`Build ${result.buildId.substring(0, 8)} submitted. Polling for status...`);
      dialog.toast({
        message: result.message || "Dashboard upgrade initiated!",
        variant: "success",
        duration: 6000,
      });

      // Poll Cloud Build status every 5s
      const pollBuild = async () => {
        try {
          const status = await api<{
            buildId: string;
            status: string;
            progress: number;
            activeStep: string | null;
            failedStep: string | null;
            doneSteps: number;
            totalSteps: number;
          }>(`/api/upgrade/status?buildId=${result.buildId}`);

          if (!status) {
            setBuildStatus("Failed to check build status.");
            setUpgrading(false);
            return;
          }

          if (status.status === "SUCCESS") {
            setBuildStatus("✅ Deploy complete! Refreshing in 5s...");
            setUpgrading(false);
            setTimeout(() => window.location.reload(), 5000);
            return;
          }

          if (status.status === "FAILURE" || status.status === "TIMEOUT" || status.status === "CANCELLED") {
            setBuildStatus(`❌ Build ${status.status.toLowerCase()}${status.failedStep ? ` at: ${status.failedStep}` : ""}`);
            setUpgrading(false);
            return;
          }

          // Still running — show progress
          const stepLabel = status.activeStep || `${status.doneSteps}/${status.totalSteps} steps`;
          setBuildStatus(`Building... ${status.progress}% — ${stepLabel}`);

          // Continue polling
          setTimeout(pollBuild, 5000);
        } catch {
          setBuildStatus("Error polling build status. Build may still be running.");
          setUpgrading(false);
        }
      };

      // Start polling after a short delay
      setTimeout(pollBuild, 3000);
    } else if (result?.success) {
      setBuildStatus("Build submitted. Dashboard will update automatically.");
      setTimeout(() => {
        setBuildStatus(null);
        setUpgrading(false);
      }, 10000);
    } else {
      dialog.toast({ message: result?.error || "Upgrade failed", variant: "error" });
      setBuildStatus(null);
      setUpgrading(false);
    }
  };

  return (
    <>
      {/* Version & Upgrade */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Version &amp; Upgrade</div>
        {versionInfo ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div className={styles["settings-row"]}>
              <div className={styles["settings-label"]}>Deployed Version</div>
              <div className={styles["settings-value"]} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code className="mono">{versionInfo.deployedVersion}</code>
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: versionInfo.deployedStable ? "rgba(34, 197, 94, 0.15)" : "rgba(245, 158, 11, 0.15)",
                  color: versionInfo.deployedStable ? "#22c55e" : "#f59e0b",
                  letterSpacing: 0.5,
                }}>
                  {versionInfo.deployedStable ? "STABLE" : "UNSTABLE"}
                </span>
              </div>
            </div>
            <div className={styles["settings-row"]}>
              <div className={styles["settings-label"]}>Latest Version</div>
              <div className={styles["settings-value"]} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code className="mono">{versionInfo.latestVersion}</code>
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: versionInfo.latestStable ? "rgba(34, 197, 94, 0.15)" : "rgba(245, 158, 11, 0.15)",
                  color: versionInfo.latestStable ? "#22c55e" : "#f59e0b",
                  letterSpacing: 0.5,
                }}>
                  {versionInfo.latestStable ? "STABLE" : "UNSTABLE"}
                </span>
              </div>
            </div>

            {/* Build progress */}
            {buildStatus && (
              <div style={{
                padding: "10px 14px",
                background: "rgba(99, 102, 241, 0.06)",
                border: "1px solid rgba(99, 102, 241, 0.2)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}>
                {upgrading && <span className="cmd-progress-spinner" />}
                <span>{buildStatus}</span>
              </div>
            )}

            <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn btn-primary" onClick={handleUpgradeDashboard} disabled={upgrading}>
                {upgrading ? "Upgrading..." : versionInfo.updateAvailable ? "⬆ Upgrade Dashboard" : "↻ Redeploy Dashboard"}
              </button>
              {versionInfo.updateAvailable && !upgrading && (
                <span style={{ fontSize: 12, color: "var(--accent-warning)" }}>
                  Update available: {versionInfo.latestVersion}
                </span>
              )}
              {!versionInfo.updateAvailable && !upgrading && (
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
