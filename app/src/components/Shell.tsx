"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Breadcrumb } from "./Breadcrumb";
import { usePrime } from "@/contexts/PrimeContext";
import { OperationsFeed, useOperations } from "./OperationsFeed";
import styles from "./Shell.module.css";

export function Shell({ children }: { children: React.ReactNode }) {
  const { primes, versionInfo } = usePrime();

  /* Use the first prime for operations polling (most common case) */
  const firstPrimeId = primes.length > 0 ? primes[0].id : null;
  const { operations, activeCount } = useOperations(firstPrimeId);

  /* Drawer state */
  const [opsOpen, setOpsOpen] = useState(false);

  /* Auto-open drawer when new active operations appear */
  const [prevActiveCount, setPrevActiveCount] = useState(0);
  useEffect(() => {
    if (activeCount > prevActiveCount && activeCount > 0) {
      setOpsOpen(true);
    }
    setPrevActiveCount(activeCount);
  }, [activeCount, prevActiveCount]);

  return (
    <div className={styles.shell} id="shell">
      {/* ---- Top bar ---- */}
      <header className={styles.topBar} id="shell-topbar">
        <div className={styles.topBarLeft}>
          <Breadcrumb />
        </div>

        <div className={styles.topBarRight}>
          {/* Operations button */}
          <button
            className={`${styles.iconBtn} ${activeCount > 0 ? styles.opsActive : ""}`}
            onClick={() => setOpsOpen(!opsOpen)}
            title={activeCount > 0 ? `${activeCount} active operations` : "Operations"}
            id="shell-ops-btn"
          >
            🚀
            {activeCount > 0 && (
              <span className={styles.opsBadge}>{activeCount}</span>
            )}
          </button>

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

      {/* ---- Operations Drawer ---- */}
      {opsOpen && firstPrimeId && (
        <div className={styles.opsDrawer} id="ops-drawer">
          <OperationsFeed
            primeId={firstPrimeId}
            operations={operations}
            onClose={() => setOpsOpen(false)}
          />
        </div>
      )}

      {/* ---- Full-page content ---- */}
      <main className={styles.content} id="shell-content">
        {children}
      </main>
    </div>
  );
}
