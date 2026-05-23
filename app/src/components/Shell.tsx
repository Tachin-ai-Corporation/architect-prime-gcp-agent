"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Breadcrumb } from "./Breadcrumb";
import { usePrime } from "@/contexts/PrimeContext";
import styles from "./Shell.module.css";

export function Shell({ children }: { children: React.ReactNode }) {
  const { sidebarFleet, versionInfo } = usePrime();

  /* Count work items with needs_input status across all primes' fleet agents */
  const needsInputCount = useMemo(() => {
    let count = 0;
    for (const agents of Object.values(sidebarFleet)) {
      for (const agent of agents) {
        if (agent.status === "needs_action") count++;
      }
    }
    return count;
  }, [sidebarFleet]);

  return (
    <div className={styles.shell} id="shell">
      {/* ---- Top bar ---- */}
      <header className={styles.topBar} id="shell-topbar">
        <div className={styles.topBarLeft}>
          <Breadcrumb />
        </div>

        <div className={styles.topBarRight}>
          {/* Notification bell */}
          <Link
            href="/work"
            className={`${styles.iconBtn} ${needsInputCount > 0 ? styles.bellActive : ""}`}
            title={needsInputCount > 0 ? `${needsInputCount} item(s) need attention` : "Work queue"}
            id="shell-bell"
          >
            🔔
            {needsInputCount > 0 && (
              <span className={styles.bellBadge}>{needsInputCount}</span>
            )}
          </Link>

          {/* Settings gear */}
          <Link
            href="/settings"
            className={styles.iconBtn}
            title="Settings"
            id="shell-settings"
          >
            ⚙️
          </Link>

          {/* Version info */}
          {versionInfo && (
            <span className={styles.versionTag} id="shell-version">
              {versionInfo.deployedVersion}
              <span className={versionInfo.deployedStable ? styles.versionStable : styles.versionUnstable}>
                {versionInfo.deployedStable ? "STABLE" : "DEV"}
              </span>
              {versionInfo.updateAvailable && (
                <span className={styles.versionUpdate} title="Update available">●</span>
              )}
            </span>
          )}
        </div>
      </header>

      {/* ---- Full-page content ---- */}
      <main className={styles.content} id="shell-content">
        {children}
      </main>
    </div>
  );
}
