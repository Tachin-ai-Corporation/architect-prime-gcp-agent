"use client";

import { use } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { NavCard } from "@/components/NavCard";
import { usePrime } from "@/contexts/PrimeContext";

export default function PrimeHubPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { primes, sidebarFleet, loading } = usePrime();

  const prime = primes.find((p) => p.id === id);
  const fleet = (sidebarFleet[id] || []).filter((a) => a.status !== "removed");

  if (loading) {
    return <div className={styles.loading}>Loading…</div>;
  }

  if (!prime) {
    return (
      <div className={styles.loading}>
        Prime not found — <Link href="/">back to dashboard</Link>
      </div>
    );
  }

  /* Status → badge class */
  const badgeClass =
    prime.status === "online"
      ? "badge badge-online"
      : prime.status === "deploying"
        ? "badge badge-deploying"
        : "badge badge-offline";

  /* Status dot helper for fleet chips */
  const dotClass = (status: string) => {
    switch (status) {
      case "online":
        return styles.chipDotOnline;
      case "deploying":
        return styles.chipDotDeploying;
      case "error":
        return styles.chipDotError;
      default:
        return styles.chipDotOffline;
    }
  };

  return (
    <div className={styles.hubPage}>
      {/* ---- Header ---- */}
      <div className={styles.header}>
        <h1 className={styles.primeName}>{prime.name}</h1>
        <span className={badgeClass}>{prime.status}</span>
        <span className={styles.zoneTag}>{prime.zone}</span>
      </div>

      {/* ---- NavCard Grid ---- */}
      <div className={styles.navGrid}>
        <NavCard
          icon="👥"
          title="Fleet"
          description="Manage your agent fleet"
          href={`/p/${id}/fleet`}
          badge={fleet.length}
        />
        <NavCard
          icon="📋"
          title="Work"
          description="Missions, tasks & envelopes"
          href={`/p/${id}/work`}
        />
        <NavCard
          icon="📑"
          title="Plans"
          description="Execution plans & approvals"
          href={`/p/${id}/plans`}
        />
        <NavCard
          icon="📁"
          title="Projects"
          description="Organize work by project"
          href="/projects"
        />
        <NavCard
          icon="⚙️"
          title="Processes"
          description="Responsibilities & cron"
          href={`/p/${id}/processes`}
        />
        <NavCard
          icon="🔧"
          title="Config"
          description="Prime instance settings"
          href={`/p/${id}/config`}
        />
        <NavCard
          icon="💬"
          title="Chat"
          description="Talk to your Prime"
          href={`/p/${id}/chat`}
          variant="accent"
        />
      </div>

      {/* ---- Fleet Chip Strip ---- */}
      <div className={styles.fleetSection}>
        <div className={styles.fleetTitle}>Fleet Agents</div>
        {fleet.length === 0 ? (
          <div className={styles.emptyFleet}>
            No agents deployed yet. Visit Fleet to hire your first agent.
          </div>
        ) : (
          <div className={styles.fleetStrip}>
            {fleet.map((agent) => (
              <Link
                key={agent.name}
                href={`/p/${id}/a/${agent.name}`}
                className={styles.agentChip}
              >
                <span
                  className={`${styles.chipDot} ${dotClass(agent.status)}`}
                />
                {agent.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
