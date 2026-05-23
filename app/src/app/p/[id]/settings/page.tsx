"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";

export default function PrimeSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { primes, sidebarFleet, versionInfo, loading } = usePrime();
  const dialog = useDialog();
  const prime = primes.find((p) => p.id === id);
  const fleet = sidebarFleet[id] || [];
  const activeFleet = fleet.filter((a) => a.status !== "removed");

  // Upgrade state
  const [upgrading, setUpgrading] = useState(false);

  // Teardown state
  const [tearingDown, setTearingDown] = useState(false);

  /* ---- Queue & track helper ---- */
  const queueAndTrack = async (type: string, args: Record<string, string>, label: string) => {
    const result = await api<{ id: string }>(`/api/primes/${id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, args }),
    });
    if (result?.id) {
      dialog.trackCommand(id, result.id, label);
      return result.id;
    } else {
      dialog.toast({ message: `Failed to queue ${label}.`, variant: "error" });
      return null;
    }
  };

  /* ---- Upgrade Prime CoreKit ---- */
  const handleUpgrade = async () => {
    const ok = await dialog.confirm({
      title: `Upgrade ${prime?.name || id} CoreKit?`,
      message:
        "This will pull the latest CoreKit from GitHub and restart the gateway.\nThe agent will be briefly unavailable during the restart.",
      confirmText: "Upgrade",
    });
    if (!ok) return;
    setUpgrading(true);
    await queueAndTrack("upgrade_corekit", { ref: "main" }, `Upgrade ${prime?.name || id} CoreKit`);
    setUpgrading(false);
  };

  /* ---- Upgrade Dashboard (POST /api/upgrade with primeId) ---- */
  const handleUpgradeDashboard = async () => {
    setUpgrading(true);
    const result = await api<{ success: boolean; message?: string; error?: string }>("/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primeId: id }),
    });
    if (result?.success) {
      dialog.toast({ message: result.message || "Upgrade initiated!", variant: "success", duration: 6000 });
    } else {
      dialog.toast({ message: result?.error || "Upgrade failed", variant: "error" });
    }
    setUpgrading(false);
  };

  /* ---- Teardown ---- */
  const handleTeardown = async () => {
    // Check if fleet is empty
    if (activeFleet.length > 0) {
      dialog.toast({
        message: `Cannot tear down — ${activeFleet.length} active agent${activeFleet.length !== 1 ? "s" : ""} still deployed. Remove all fleet agents first.`,
        variant: "error",
        duration: 5000,
      });
      return;
    }

    const ok = await dialog.confirm({
      title: `Decommission ${prime?.name || id}?`,
      message:
        "This will permanently delete the Prime VM, all associated data, and configurations.\n\nThis action cannot be undone.",
      confirmText: "Decommission",
    });
    if (!ok) return;

    // Double confirm
    const reallyOk = await dialog.confirm({
      title: "Are you absolutely sure?",
      message: `Type the Prime name "${prime?.name || id}" to confirm.\n\nAll data will be lost permanently.`,
      confirmText: "Yes, Decommission",
    });
    if (!reallyOk) return;

    setTearingDown(true);
    const result = await api<{ success: boolean; error?: string }>(`/api/primes/${id}/teardown`, {
      method: "POST",
    });

    if (result?.success) {
      dialog.toast({ message: `${prime?.name || id} teardown initiated.`, variant: "success" });
      router.push("/");
    } else {
      dialog.toast({ message: result?.error || "Teardown failed", variant: "error" });
      setTearingDown(false);
    }
  };

  /* ---- Check if upgrade needed ---- */
  const needsUpgrade = (): boolean => {
    if (!versionInfo?.mainHeadSha || !prime?.coreRef) return false;
    if (prime.coreRef === "main" || prime.coreRef === "unknown") return false;
    return !prime.coreRef.includes(versionInfo.mainHeadSha);
  };

  if (loading) {
    return (
      <div className={styles.settingsShell}>
        <div className={styles.settingsContainer}>
          <div className={styles.settingsLoading}>Loading…</div>
        </div>
      </div>
    );
  }

  if (!prime) {
    return (
      <div className={styles.settingsShell}>
        <div className={styles.settingsContainer}>
          <div style={{ textAlign: "center", padding: 80 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: "#E6EBF0", marginBottom: 8 }}>
              Prime Not Found
            </div>
            <div style={{ fontSize: 14, color: "#AEB8C4", marginBottom: 24 }}>
              No Prime instance with ID &ldquo;{id}&rdquo; was found.
            </div>
            <Link href="/" className="btn btn-primary">
              ← Back to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.settingsShell} id="prime-settings-page">
      <div className={styles.settingsContainer}>
        {/* ---- Header ---- */}
        <header className={styles.settingsHeader}>
          <span className={styles.settingsHeaderIcon}>⚙️</span>
          <div>
            <h1 className={styles.settingsTitle}>{prime.name} Settings</h1>
            <div className={styles.settingsSubtitle}>Prime instance configuration</div>
          </div>
          <Link href={`/p/${id}`} className={styles.settingsBack} id="prime-settings-back-btn">
            ← Hub
          </Link>
        </header>

        {/* ---- VM Configuration ---- */}
        <section className={styles.section} id="prime-settings-vm">
          <div className={styles.sectionTitle}>VM Configuration</div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Instance ID</span>
            <span className={styles.fieldValue}>{prime.id}</span>
          </div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Zone</span>
            <span className={styles.fieldValue}>{prime.zone}</span>
          </div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Status</span>
            <span className={styles.fieldValue}>{prime.status}</span>
          </div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Fleet Agents</span>
            <span className={styles.fieldValue}>{activeFleet.length}</span>
          </div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>CoreKit Ref</span>
            <span className={styles.fieldValue}>{prime.coreRef || "—"}</span>
          </div>
        </section>

        {/* ---- Upgrade ---- */}
        <section className={styles.section} id="prime-settings-upgrade">
          <div className={styles.sectionTitle}>Upgrade</div>
          <div className={styles.sectionDesc}>
            Update the CoreKit to the latest version from GitHub. The gateway will restart briefly.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: "#E6EBF0", fontWeight: 500 }}>Current Version:</span>
            <span className={`${styles.versionBadge} ${styles.versionCurrent}`}>
              {prime.coreRef || "unknown"}
            </span>
            {needsUpgrade() && (
              <span style={{ fontSize: 11, color: "#D6A83A", fontWeight: 600 }}>● Upgrade available</span>
            )}
          </div>

          <div className={styles.actions}>
            <button
              id="prime-upgrade-corekit-btn"
              className="btn btn-primary"
              onClick={handleUpgrade}
              disabled={upgrading}
            >
              {upgrading ? "Upgrading..." : "⬆ Upgrade CoreKit"}
            </button>
            <button
              id="prime-upgrade-dashboard-btn"
              className="btn btn-ghost"
              style={{ borderColor: "rgba(86,99,115,0.35)" }}
              onClick={handleUpgradeDashboard}
              disabled={upgrading}
            >
              ↻ Redeploy Dashboard
            </button>
          </div>
        </section>

        {/* ---- Danger Zone: Teardown ---- */}
        <section className={styles.dangerSection} id="prime-settings-teardown">
          <div className={styles.dangerTitle}>⚠️ Danger Zone</div>
          <div className={styles.dangerDesc}>
            Decommission this Prime instance. This will permanently delete the VM and all associated data.
          </div>

          {activeFleet.length > 0 && (
            <div className={styles.dangerWarning}>
              ⚠ This Prime has {activeFleet.length} active fleet agent{activeFleet.length !== 1 ? "s" : ""}.
              Remove all fleet agents before tearing down.
            </div>
          )}

          <button
            id="prime-teardown-btn"
            className="btn btn-danger"
            onClick={handleTeardown}
            disabled={tearingDown || activeFleet.length > 0}
          >
            {tearingDown ? "Tearing down..." : "🗑 Decommission Prime"}
          </button>
        </section>
      </div>
    </div>
  );
}
