"use client";

/**
 * Fleet Studio route — a thin wrapper over <FleetStudioPanel>, which also powers
 * the Home fleet-observability view. The panel reads the whole fleet, so this
 * stays a deep-linkable page even though the data is no longer per-Prime.
 */

import { FleetStudioPanel } from "@/components/fleet/FleetStudioPanel";
import styles from "@/components/fleet/FleetStudioPanel.module.css";

export default function FleetStudioPage() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>Fleet Studio</h1>
        <p className={styles.subtitle}>
          What the fleet is running, where each release came from, and how to undo it.
        </p>
      </header>
      <FleetStudioPanel />
    </div>
  );
}
