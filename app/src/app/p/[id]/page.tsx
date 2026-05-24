"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useMemo } from "react";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { NavCard } from "@/components/NavCard";
import { StatusStrip } from "@/components/StatusStrip";
import { useWorkEnvelopes } from "@/components/work/useWorkEnvelopes";

export default function PrimeHub() {
  const { id } = useParams<{ id: string }>();
  const { primes, sidebarFleet, loading } = usePrime();
  const prime = primes.find((p) => p.id === id);
  const fleet = sidebarFleet[id] || [];

  const { envelopes } = useWorkEnvelopes(id);

  const metrics = useMemo(() => {
    const activeAgents = fleet.filter((a) => a.status === "online").length;
    const totalAgents = fleet.filter((a) => a.status !== "removed").length;
    const needsInput = envelopes.filter((e) => e.status === "needs_input").length;
    const activeMissions = envelopes.filter((e) => e.type === "M" && e.status === "active").length;
    return { activeAgents, totalAgents, needsInput, activeMissions };
  }, [fleet, envelopes]);

  /* Status badge variant */
  const statusClass = prime
    ? prime.status === "online"
      ? styles.statusOnline
      : prime.status === "deploying"
        ? styles.statusDeploying
        : prime.status === "error"
          ? styles.statusError
          : styles.statusOffline
    : "";

  if (loading) {
    return (
      <div className={styles.hubShell}>
        <div className={styles.hubContainer}>
          <div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>
        </div>
      </div>
    );
  }

  if (!prime) {
    return (
      <div className={styles.hubShell}>
        <div className={styles.hubContainer}>
          <div className={styles.notFound}>
            <div className={styles.notFoundIcon}>🔍</div>
            <div className={styles.notFoundTitle}>Prime Not Found</div>
            <div className={styles.notFoundDesc}>
              No Prime instance with ID &ldquo;{id}&rdquo; was found.
            </div>
            <Link href="/" className="btn btn-primary">← Back to Home</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.hubShell} id="prime-hub">
      <div className={styles.hubContainer}>
        {/* ---- Header ---- */}
        <header className={styles.hubHeader}>
          <div className={styles.hubLogo}>P</div>
          <div className={styles.hubMeta}>
            <h1 className={styles.hubTitle}>{prime.name}</h1>
            <div className={styles.hubZone}>{prime.zone}</div>
          </div>
          <span className={`${styles.hubStatus} ${statusClass}`} id="prime-status-badge">
            {prime.status}
          </span>
        </header>

        {/* ---- Status Strip ---- */}
        <div className={styles.statusStrip}>
          <StatusStrip
            items={[
              { label: "Agents", value: `${metrics.activeAgents}/${metrics.totalAgents}`, variant: metrics.activeAgents > 0 ? "success" : "neutral" },
              { label: "Missions", value: String(metrics.activeMissions), variant: metrics.activeMissions > 0 ? "info" : "neutral" },
              { label: "Needs Input", value: String(metrics.needsInput), variant: metrics.needsInput > 0 ? "warning" : "neutral" },
              { label: "Fleet Version", value: prime.coreRef || "—", variant: "neutral" },
            ]}
          />
        </div>

        {/* ---- NavCard Grid ---- */}
        <div className={styles.hubGrid} id="prime-hub-grid">
          <NavCard
            id="hub-chat"
            icon="💬"
            title="Chat"
            description="Talk to your Prime"
            variant="accent"
            href={`/p/${id}/chat`}
          />
          <NavCard
            id="hub-brain"
            icon="🧠"
            title="Brain"
            description="LLM model assignments"
            variant="accent"
            href={`/p/${id}/brain`}
          />
          <NavCard
            id="hub-fleet"
            icon="👥"
            title="Fleet"
            description={`${metrics.totalAgents} agent${metrics.totalAgents !== 1 ? "s" : ""}`}
            variant="accent"
            href={`/p/${id}/fleet`}
            badge={metrics.totalAgents > 0 ? String(metrics.totalAgents) : undefined}
          />
          <NavCard
            id="hub-work"
            icon="🌳"
            title="Work"
            description="Missions, tasks, and envelopes"
            variant="accent"
            href={`/p/${id}/work`}
            badge={metrics.needsInput > 0 ? String(metrics.needsInput) : undefined}
            badgeVariant={metrics.needsInput > 0 ? "warning" : undefined}
          />
          <NavCard
            id="hub-skills"
            icon="🔧"
            title="Skills"
            description="Installed tools and skills"
            variant="default"
            href={`/p/${id}/skills`}
          />
          <NavCard
            id="hub-settings"
            icon="⚙"
            title="Settings"
            description="Prime instance configuration"
            variant="default"
            href={`/p/${id}/settings`}
          />
        </div>
      </div>
    </div>
  );
}
