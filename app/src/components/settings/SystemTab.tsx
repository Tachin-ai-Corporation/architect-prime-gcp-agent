"use client";

import { useState, useEffect } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";
import styles from "@/app/settings/page.module.css";

export function SystemTab() {
  const { primes, versionInfo, setup } = usePrime();
  const dialog = useDialog();

  const [upgrading, setUpgrading] = useState(false);
  const [buildStatus, setBuildStatus] = useState<string | null>(null);

  // Uncontrolled until edited, then the edit wins.
  //
  // `setup` arrives asynchronously, so the fields used to be seeded by an
  // effect that wrote state after it loaded — a cascading render, and a latent
  // bug: any later context refresh overwrote whatever was being typed.
  const [ownerEdit, setOwnerEdit] = useState<string | null>(null);
  const [repoEdit, setRepoEdit] = useState<string | null>(null);
  const owner = ownerEdit ?? setup?.githubOwner ?? "";
  const repo = repoEdit ?? setup?.githubRepo ?? "";
  const setOwner = setOwnerEdit;
  const setRepo = setRepoEdit;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSaveGitHub = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubOwner: owner.trim(),
          githubRepo: repo.trim(),
        }),
      });
      if (res.ok) {
        setSaved(true);
        dialog.toast({ message: "GitHub settings saved successfully", variant: "success" });
        setTimeout(() => setSaved(false), 2500);
      } else {
        dialog.toast({ message: "Failed to save GitHub settings", variant: "error" });
      }
    } catch {
      dialog.toast({ message: "Error saving GitHub settings", variant: "error" });
    }
    setSaving(false);
  };

  const firstPrimeId = primes.length > 0 ? primes[0].id : null;

  /* ---- System Upgrade ---- */
  const handleUpgrade = async () => {
    setUpgrading(true);
    setBuildStatus("Submitting build...");
    const result = await api<{
      success: boolean;
      message?: string;
      error?: string;
      buildId?: string;
      version?: string;
      region?: string;
    }>("/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primeId: firstPrimeId }),
    });

    if (result?.success && result.buildId) {
      setBuildStatus(`Build ${result.buildId.substring(0, 8)} submitted. Polling for status...`);
      dialog.toast({ message: result.message || "Dashboard upgrade initiated!", variant: "success", duration: 6000 });

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
            steps?: Array<{ label: string; status: string; startTime?: string; endTime?: string }>;
            startTime?: string | null;
          }>(`/api/upgrade/status?buildId=${result.buildId}${result.region ? `&region=${result.region}` : ""}`);

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

          // QUEUED vs WORKING display
          if (status.status === "QUEUED") {
            setBuildStatus("⏳ Build queued — waiting for Cloud Build to start...");
          } else {
            // WORKING — show step progress
            const stepLabel = status.activeStep
              ? `⏳ ${status.activeStep}`
              : `${status.doneSteps}/${status.totalSteps} steps`;
            const elapsed = status.startTime
              ? ` (${Math.round((Date.now() - new Date(status.startTime).getTime()) / 1000)}s)`
              : "";
            setBuildStatus(`Building... ${status.progress}% — ${stepLabel}${elapsed}`);
          }

          // Continue polling
          setTimeout(pollBuild, 5000);
        } catch {
          setBuildStatus("Error polling build status. Build may still be running.");
          setUpgrading(false);
        }
      };

      // Start polling after a short delay (build needs time to initialize)
      setTimeout(pollBuild, 3000);
    } else if (result?.success) {
      // No buildId returned — fallback message
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
    <section className={styles.section} id="settings-system">
      <div className={styles.sectionTitle}>Version & Upgrade</div>

      {versionInfo ? (
        <>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Deployed Version</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={styles.fieldValue}>{versionInfo.deployedVersion}</span>
              <span
                className={`${styles.badge} ${versionInfo.deployedStable ? styles.badgeSuccess : styles.badgeWarning}`}
              >
                {versionInfo.deployedStable ? "Stable" : "Unstable"}
              </span>
            </span>
          </div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Latest Version</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={styles.fieldValue}>{versionInfo.latestVersion}</span>
              <span
                className={`${styles.badge} ${versionInfo.latestStable ? styles.badgeSuccess : styles.badgeWarning}`}
              >
                {versionInfo.latestStable ? "Stable" : "Unstable"}
              </span>
            </span>
          </div>

          <div className={styles.fieldRow} style={{ alignItems: "center" }}>
            <span className={styles.fieldLabel}>Repository Owner / Org</span>
            <input
              id="settings-github-owner-input"
              className="input"
              style={{ width: 220, fontSize: 13 }}
              placeholder="e.g. your-github-org"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </div>

          <div className={styles.fieldRow} style={{ alignItems: "center" }}>
            <span className={styles.fieldLabel}>Repository Name</span>
            <input
              id="settings-github-repo-input"
              className="input"
              style={{ width: 220, fontSize: 13 }}
              placeholder="e.g. architect-prime-gcp-agent"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          </div>

          <div className={styles.fieldRow} style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button
              id="settings-save-github-btn"
              className="btn btn-secondary btn-sm"
              disabled={saving}
              onClick={handleSaveGitHub}
            >
              {saving ? "Saving..." : saved ? "✓ Saved" : "Save GitHub Settings"}
            </button>
          </div>

          {buildStatus && (
            <div className={styles.buildStatus}>
              {upgrading && <span className="cmd-progress-spinner" />}
              <span>{buildStatus}</span>
            </div>
          )}

          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              id="settings-upgrade-btn"
              className="btn btn-primary"
              onClick={handleUpgrade}
              disabled={upgrading}
            >
              {upgrading
                ? "Upgrading..."
                : versionInfo.updateAvailable
                  ? "⬆ Upgrade Dashboard"
                  : "↻ Redeploy Dashboard"}
            </button>
            {versionInfo.updateAvailable && !upgrading && (
              <span style={{ fontSize: 12, color: "#D6A83A" }}>
                Update available: {versionInfo.latestVersion}
              </span>
            )}
            {!versionInfo.updateAvailable && !upgrading && (
              <span style={{ fontSize: 12, color: "#566373" }}>
                Up to date — redeploy will rebuild from main
              </span>
            )}
          </div>
        </>
      ) : (
        <div style={{ color: "#AEB8C4", fontSize: 13 }}>Loading version info...</div>
      )}
    </section>
  );
}
