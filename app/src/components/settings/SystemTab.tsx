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
  activePrime: string;
  versionInfo: VersionInfo | null;
  upgrading: boolean;
  setUpgrading: (v: boolean) => void;
}

export function SystemTab({ activePrime, versionInfo, upgrading, setUpgrading }: SystemTabProps) {
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
              <div className={styles["settings-label"]}>Latest Version</div>
              <div className={styles["settings-value"]}>
                <code className="mono">{versionInfo.latestVersion}</code>
                {versionInfo.updateAvailable && (
                  <span className="badge badge-deploying" style={{ marginLeft: 8, fontSize: 10 }}>update available</span>
                )}
              </div>
            </div>
            <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={async () => {
                setUpgrading(true);
                const result = await api<{success: boolean; message?: string; error?: string}>("/api/upgrade", { method: "POST" });
                setUpgrading(false);
                if (result?.success) alert(result.message || "Dashboard upgrade initiated!");
                else alert(result?.error || "Upgrade failed");
              }} disabled={upgrading}>
                {upgrading ? "Upgrading..." : "Upgrade Dashboard"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Loading version info...</div>
        )}
      </div>

      {/* Prime VM Operations */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Prime VM Operations</div>
        <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
          These operations execute on the Prime VM host via the command queue. They are deterministic and not affected by gateway restarts.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={async () => {
            if (!activePrime) return;
            if (!confirm("Upgrade CoreKit on the Prime VM? This will also restart the gateway.")) return;
            const result = await api<{id: string}>(`/api/primes/${activePrime}/commands`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "upgrade_corekit", args: { ref: versionInfo?.latestVersion || "main" } }),
            });
            if (result?.id) alert(`CoreKit upgrade queued (command: ${result.id}). The command-runner will execute it.`);
            else alert("Failed to queue upgrade command.");
          }}>
            ⬆ Upgrade CoreKit
          </button>
          <button className="btn btn-ghost" style={{ borderColor: "var(--border)" }} onClick={async () => {
            if (!activePrime) return;
            if (!confirm("Restart the OpenClaw gateway on the Prime VM?")) return;
            const result = await api<{id: string}>(`/api/primes/${activePrime}/commands`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "gateway_restart", args: {} }),
            });
            if (result?.id) alert(`Gateway restart queued (command: ${result.id}).`);
            else alert("Failed to queue restart command.");
          }}>
            ↻ Restart Gateway
          </button>
        </div>
      </div>
    </>
  );
}
