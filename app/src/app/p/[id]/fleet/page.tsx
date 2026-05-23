"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { NavCard } from "@/components/NavCard";
import { api } from "@/lib/api";
import type { FleetAgent } from "@/lib/types";

export default function FleetPage() {
  const { id } = useParams<{ id: string }>();
  const { primes, setup } = usePrime();
  const prime = primes.find((p) => p.id === id);

  const [fleet, setFleet] = useState<FleetAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHire, setShowHire] = useState(false);
  const [hireName, setHireName] = useState("");
  const [hireSpecialty, setHireSpecialty] = useState("devops");
  const [hireEmail, setHireEmail] = useState("");
  const [hiring, setHiring] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ---- Load fleet ---- */
  const loadFleet = useCallback(async () => {
    if (!id) return;
    const data = await api<{ fleet: FleetAgent[] }>(`/api/primes/${id}/fleet`);
    if (data?.fleet) setFleet(data.fleet);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    loadFleet();
  }, [loadFleet]);

  /* ---- Poll every 8s ---- */
  useEffect(() => {
    if (!id) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadFleet, 8000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [id, loadFleet]);

  /* ---- Hire ---- */
  const handleHire = async () => {
    if (!hireName.trim() || !hireEmail.trim() || !id) return;
    setHiring(true);

    await api(`/api/primes/${id}/fleet/hire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: hireName.trim().toLowerCase().replace(/\s+/g, "-"),
        specialty: hireSpecialty,
        email: hireEmail.trim() || undefined,
      }),
    });

    // Optimistic: add to fleet as deploying
    setFleet((prev) => [
      ...prev,
      {
        name: hireName.trim().toLowerCase().replace(/\s+/g, "-"),
        status: "deploying" as const,
        specialty: hireSpecialty,
        email: hireEmail.trim() || "(pending)",
      },
    ]);

    setShowHire(false);
    setHiring(false);
    setHireName("");
    setHireEmail("");
  };

  /* Agent card helpers */
  const getAgentIcon = (agent: FleetAgent) => {
    if (agent.status === "online" || agent.status === "deploying") return "◉";
    return "●";
  };

  const getAgentDescription = (agent: FleetAgent) => {
    return `${agent.specialty} · ${agent.status}`;
  };

  const activeFleet = fleet.filter((a) => a.status !== "removed");

  return (
    <div className={styles.fleetShell} id="fleet-page">
      <div className={styles.fleetContainer}>
        {/* ---- Header ---- */}
        <header className={styles.fleetHeader}>
          <span className={styles.fleetHeaderIcon}>👥</span>
          <div>
            <h1 className={styles.fleetTitle}>Fleet</h1>
            <div className={styles.fleetCount}>
              {prime?.name} · {activeFleet.length} agent{activeFleet.length !== 1 ? "s" : ""}
            </div>
          </div>
          <Link href={`/p/${id}`} className={styles.fleetBack} id="fleet-back-btn">
            ← Hub
          </Link>
        </header>

        {/* ---- Grid ---- */}
        {loading ? (
          <div className={styles.fleetLoading}>Loading fleet…</div>
        ) : (
          <div className={styles.fleetGrid} id="fleet-grid">
            {activeFleet.map((agent) => (
              <NavCard
                key={agent.name}
                id={`agent-card-${agent.name}`}
                icon={getAgentIcon(agent)}
                iconColor={
                  agent.status === "online"
                    ? "#5FC7B2"
                    : agent.status === "deploying"
                      ? "#D6A83A"
                      : undefined
                }
                title={agent.name}
                description={getAgentDescription(agent)}
                variant="accent"
                href={`/p/${id}/a/${agent.name}`}
              />
            ))}

            <NavCard
              id="hire-agent-card"
              icon="+"
              title="Hire Agent"
              description="Deploy a new fleet agent"
              variant="action"
              onClick={() => setShowHire(true)}
            />
          </div>
        )}
      </div>

      {/* ---- Hire Modal ---- */}
      {showHire && (
        <div className={styles.modalOverlay} onClick={() => setShowHire(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>Hire Fleet Agent</div>
            <div className={styles.modalDesc}>
              Each agent gets its own VM, workspace, and specialist toolset. Prime manages the lifecycle.
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="hire-agent-name">Agent Name</label>
              <input
                id="hire-agent-name"
                className="input"
                placeholder="e.g. stan"
                autoFocus
                value={hireName}
                onChange={(e) => {
                  const name = e.target.value;
                  setHireName(name);
                  if (setup.agentEmailDomain && name.trim()) {
                    const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
                    setHireEmail(`${hireSpecialty}-agent-${slug}@${setup.agentEmailDomain}`);
                  }
                }}
                onKeyDown={(e) => { if (e.key === "Enter") handleHire(); }}
              />
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="hire-agent-specialty">Specialty</label>
              <select
                id="hire-agent-specialty"
                className="input"
                value={hireSpecialty}
                onChange={(e) => setHireSpecialty(e.target.value)}
              >
                <option value="devops">DevOps — GCP, infra, CI/CD, reliability</option>
                <option value="swe">SWE — Code, architecture, testing</option>
                <option value="qa">QA — Testing, automation, quality</option>
                <option value="pm">PM — Planning, tickets, coordination</option>
                <option value="finance">Finance — Budget, analysis, reporting</option>
                <option value="data">Data — Analytics, pipelines, BigQuery</option>
                <option value="security">Security — IAM, compliance, audit</option>
                <option value="assistant">Assistant — Scheduling, comms, admin</option>
              </select>
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="hire-agent-email">Workspace Email</label>
              <input
                id="hire-agent-email"
                className="input"
                placeholder="e.g. devops-stan@yourcompany.com"
                value={hireEmail}
                onChange={(e) => setHireEmail(e.target.value)}
              />
              <div className={styles.modalHint}>
                Create the Workspace account in Google Admin first. DWD handles authentication.
              </div>
            </div>
            <div className={styles.modalActions}>
              <button className="btn btn-ghost" onClick={() => setShowHire(false)}>Cancel</button>
              <button
                id="hire-agent-submit"
                className="btn btn-primary"
                onClick={handleHire}
                disabled={!hireName.trim() || !hireEmail.trim() || hiring}
              >
                {hiring ? "Hiring…" : "Hire Agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
