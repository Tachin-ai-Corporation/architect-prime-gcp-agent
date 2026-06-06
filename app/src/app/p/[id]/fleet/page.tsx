"use client";

import { use, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePrime } from "@/contexts/PrimeContext";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";
import type { FleetAgent } from "@/lib/types";
import styles from "./page.module.css";

interface AgentType {
  id: string;
  title: string;
  specialty: string;
  emailPattern: string;
  skills: string[];
}

export default function FleetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const dialog = useDialog();
  const { primes, sidebarFleet, setup, refreshPrimes } = usePrime();

  const prime = primes.find((p) => p.id === id);
  const fleet = (sidebarFleet[id] || []).filter((a) => a.status !== "removed");

  /* ---- Hire state ---- */
  const [showHire, setShowHire] = useState(false);
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [hireName, setHireName] = useState("");
  const [hireType, setHireType] = useState("");
  const [hiring, setHiring] = useState(false);

  /* ---- Action state ---- */
  const [upgradingAgent, setUpgradingAgent] = useState<string | null>(null);
  const [firingAgent, setFiringAgent] = useState<string | null>(null);

  /* ---- Hire flow ---- */
  const openHireModal = async () => {
    setShowHire(true);
    if (agentTypes.length === 0) {
      const res = await api<{ types: AgentType[] }>("/api/agent-types");
      if (res?.types) {
        setAgentTypes(res.types);
        if (res.types.length > 0) setHireType(res.types[0].id);
      }
    }
  };

  const generatedEmail =
    hireName && hireType
      ? `${hireType}-agent-${hireName}@${setup.agentEmailDomain || "example.com"}`
      : "";

  const handleHire = async () => {
    if (!hireName.trim() || !hireType || !generatedEmail) return;
    setHiring(true);
    const res = await api<{ id: string }>(`/api/primes/${id}/fleet/hire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: hireName, specialty: hireType, email: generatedEmail }),
    });
    if (res?.id) {
      dialog.toast({ message: `Hired ${hireName}!`, variant: "success" });
      refreshPrimes();
    } else {
      dialog.toast({ message: "Failed to hire agent.", variant: "error" });
    }
    setShowHire(false);
    setHiring(false);
    setHireName("");
  };

  /* ---- Upgrade agent ---- */
  const handleUpgrade = useCallback(
    async (agentName: string) => {
      setUpgradingAgent(agentName);
      const res = await api<{ id: string }>(`/api/primes/${id}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fleet_upgrade", args: { name: agentName, ref: "main" } }),
      });
      if (res?.id) {
        dialog.toast({ message: `Upgrading ${agentName}…`, variant: "success" });
      } else {
        dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
      }
      setUpgradingAgent(null);
    },
    [id, dialog]
  );

  /* ---- Fire agent ---- */
  const handleFire = useCallback(
    async (agentName: string) => {
      setFiringAgent(agentName);
      const res = await api<{ success: boolean }>(`/api/primes/${id}/fleet/fire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agentName }),
      });
      if (res?.success) {
        dialog.toast({ message: `Fired ${agentName}`, variant: "success" });
        refreshPrimes();
      } else {
        dialog.toast({ message: "Failed to fire agent.", variant: "error" });
      }
      setFiringAgent(null);
    },
    [id, dialog, refreshPrimes]
  );

  /* ---- Status helpers ---- */
  const statusClass = (status: string) => {
    switch (status) {
      case "online": return styles.statusOnline;
      case "deploying": return styles.statusDeploying;
      case "error": return styles.statusError;
      default: return styles.statusOffline;
    }
  };

  return (
    <div className={styles.fleetPage}>
      <div className={styles.fleetHeader}>
        <div>
          <h1 className={styles.fleetTitle}>Fleet — {prime?.name || id}</h1>
          <div className={styles.fleetSubtitle}>
            {fleet.length} agent{fleet.length !== 1 ? "s" : ""}
          </div>
        </div>
        <button className={styles.hireBtn} onClick={openHireModal}>
          + Hire Agent
        </button>
      </div>

      {/* Agent Grid */}
      <div className={styles.agentGrid}>
        {fleet.map((agent) => (
          <div
            key={agent.name}
            className={`${styles.agentCard} ${agent.status === "online" ? styles.agentCardOnline : ""}`}
            onClick={() => router.push(`/p/${id}/a/${agent.name}`)}
          >
            <div className={styles.agentCardTop}>
              <div className={styles.agentAvatar}>
                {agent.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className={styles.agentName}>{agent.name}</div>
                <div className={styles.agentMeta}>
                  <span className={styles.specialtyBadge}>{agent.specialty}</span>
                  <span className={`${styles.statusDot} ${statusClass(agent.status)}`} />
                  <span>{agent.status}</span>
                </div>
              </div>
            </div>
            {agent.email && (
              <div className={styles.agentEmail}>{agent.email}</div>
            )}
            {agent.status === "online" && (
              <div className={styles.agentActions}>
                <button
                  className={styles.actionBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUpgrade(agent.name);
                  }}
                  disabled={upgradingAgent === agent.name}
                >
                  {upgradingAgent === agent.name ? "⏳" : "⬆ Upgrade"}
                </button>
                <button
                  className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleFire(agent.name);
                  }}
                  disabled={firingAgent === agent.name}
                >
                  {firingAgent === agent.name ? "⏳" : "🗑 Fire"}
                </button>
              </div>
            )}
          </div>
        ))}

        {fleet.length === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>👥</div>
            <div className={styles.emptyTitle}>No agents yet</div>
            <div className={styles.emptyDesc}>
              Hire your first fleet agent to get started.
            </div>
          </div>
        )}
      </div>

      {/* Hire Modal */}
      {showHire && (
        <div className={styles.overlay} onClick={() => setShowHire(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>Hire New Agent</div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel}>Specialty</label>
              {agentTypes.length === 0 ? (
                <div className={styles.modalHint}>Loading…</div>
              ) : (
                <select
                  className="input"
                  value={hireType}
                  onChange={(e) => setHireType(e.target.value)}
                >
                  {agentTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel}>Agent Name</label>
              <input
                className="input"
                placeholder="e.g. stan"
                autoFocus
                value={hireName}
                onChange={(e) => setHireName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleHire();
                }}
              />
            </div>
            {generatedEmail && (
              <div className={styles.modalHint}>
                Email: <code>{generatedEmail}</code>
              </div>
            )}
            <div className={styles.modalActions}>
              <button className="btn btn-ghost" onClick={() => setShowHire(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleHire}
                disabled={!hireName.trim() || !hireType || hiring}
              >
                {hiring ? "Hiring…" : "Hire"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
