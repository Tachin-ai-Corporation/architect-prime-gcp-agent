"use client";

import { useParams, useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { useDialog } from "@/components/DialogProvider";
import type { AgentDetail } from "@/lib/types";

export default function AgentSettings() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const router = useRouter();
  const dialog = useDialog();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDetail = useCallback(async () => {
    const data = await api<AgentDetail>(`/api/primes/${id}/fleet/${agent}/logs`);
    if (data) setDetail(data);
    setLoading(false);
  }, [id, agent]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const handleFire = async () => {
    const confirmed = await dialog.confirm({
      title: `Fire ${agent}?`,
      message: `This will permanently remove ${agent} from your fleet.\nThis action cannot be undone.`,
      confirmText: "Fire Agent",
      variant: "danger",
    });
    if (!confirmed) return;
    const res = await api<{ success: boolean }>(`/api/primes/${id}/fleet/fire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agent }),
    });
    if (res?.success) {
      dialog.toast({ message: `${agent} has been fired.`, variant: "success" });
      router.push(`/p/${id}/fleet`);
    } else {
      dialog.toast({ message: "Failed to fire agent.", variant: "error" });
    }
  };

  const handleUpgrade = async () => {
    const res = await api<{ id: string }>(`/api/primes/${id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fleet_upgrade", args: { name: agent, ref: "main" } }),
    });
    if (res?.id) {
      dialog.trackCommand(id, res.id, `Upgrade ${agent}`);
    } else {
      dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
    }
  };

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="agent-settings">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>⚙ Settings — {agent}</h1>
        </header>

        {/* Identity Section */}
        <section className={styles.section} id="agent-settings-identity">
          <h2 className={styles.sectionTitle}>Identity</h2>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Agent Name</label>
              <div className={styles.fieldValue}>{agent}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Specialty</label>
              <div className={styles.fieldValue}>{detail?.specialty || "—"}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Email</label>
              <div className={styles.fieldValue}>{detail?.email || "—"}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>SOUL File</label>
              <div className={styles.fieldValueMono}>
                /home/{agent}/.agent/workspace/SOUL.md
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>VM</label>
              <div className={styles.fieldValueMono}>{detail?.vm || "—"}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Zone</label>
              <div className={styles.fieldValue}>{detail?.zone || "—"}</div>
            </div>
          </div>
        </section>

        {/* Responsibilities Section */}
        <section className={styles.section} id="agent-settings-responsibilities">
          <h2 className={styles.sectionTitle}>Responsibilities</h2>
          <div className={styles.placeholder}>
            <span className={styles.placeholderIcon}>📋</span>
            <span>
              Responsibilities are managed via the{" "}
              <a href={`/p/${id}/a/${agent}/work`} className={styles.link}>Work screen</a>.
            </span>
          </div>
        </section>

        {/* Upgrade Section */}
        <section className={styles.section} id="agent-settings-upgrade">
          <h2 className={styles.sectionTitle}>Upgrade</h2>
          <p className={styles.sectionDesc}>
            Pull the latest CoreKit from the main branch and restart the agent daemon.
          </p>
          <button
            className={styles.upgradeBtn}
            onClick={handleUpgrade}
            id="agent-upgrade-btn"
          >
            ⬆ Upgrade CoreKit
          </button>
        </section>

        {/* Danger Zone */}
        <section className={`${styles.section} ${styles.danger}`} id="agent-settings-danger">
          <h2 className={`${styles.sectionTitle} ${styles.dangerTitle}`}>Danger Zone</h2>
          <p className={styles.sectionDesc}>
            Permanently remove this agent from your fleet. The VM will be deleted and all local
            data will be lost.
          </p>
          <button
            className={styles.fireBtn}
            onClick={handleFire}
            id="agent-fire-btn"
          >
            🔥 Fire {agent}
          </button>
        </section>
      </div>
    </div>
  );
}
