"use client";

/**
 * Fleet Studio route — now a thin wrapper over <FleetStudioPanel>, which also
 * powers the Home fleet-observability view. Kept as a deep-linkable per-prime
 * page; the shared component is the source of truth for the layout.
 */

import { use } from "react";
import { FleetStudioPanel } from "@/components/fleet/FleetStudioPanel";
import styles from "@/components/fleet/FleetStudioPanel.module.css";

export default function FleetStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>Fleet Studio</h1>
        <p className={styles.subtitle}>
          What this fleet is running, where each release came from, and how to undo it.
        </p>
      </header>
      <FleetStudioPanel primeId={id} />
    </div>
  );
}
