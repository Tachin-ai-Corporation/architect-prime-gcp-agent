"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Breadcrumb } from "./Breadcrumb";
import { usePrime } from "@/contexts/PrimeContext";
import { OperationsFeed, useOperations } from "./OperationsFeed";
import styles from "./Shell.module.css";

export function Shell({ children }: { children: React.ReactNode }) {
  const { primes, versionInfo, setup } = usePrime();
  const pathname = usePathname();
  const isHome = pathname === "/";

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
          <Link href="/" className={styles.logoLink} id="shell-home-link">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/architect-prime-logo.png" alt="Architect Prime" width={28} height={28} className={styles.logoImg} />
            <div className={styles.logoStack}>
              <span className={styles.logoTitle}>Architect Prime</span>
              {versionInfo && (
                <Link href="/settings?tab=system" className={styles.versionTag} id="shell-version">
                  {versionInfo.deployedVersion}
                  <span className={versionInfo.deployedStable ? styles.versionStable : styles.versionUnstable}>
                    {versionInfo.deployedStable ? "STABLE" : "DEV"}
                  </span>
                  {versionInfo.updateAvailable && (
                    <span className={styles.versionUpdate} title="Update available">●</span>
                  )}
                </Link>
              )}
            </div>
          </Link>
        </div>

        {!isHome && (
          <div className={styles.topBarCenter}>
            <Link href="/" className={styles.homeCrumb}>Home</Link>
            <span className={styles.breadcrumbSep}>›</span>
            <Breadcrumb />
          </div>
        )}

        <div className={styles.topBarRight}>
          {/* DWD not configured warning */}
          {!setup.dwdConfigured && setup.hasPrimes && (
            <Link
              href="/settings?tab=integration"
              className={styles.iconBtn}
              title="DWD not configured — click to set up"
              id="shell-dwd-warning"
            >
              <span className={styles.warningIcon}>🔗</span>
              <span className={styles.warningDot} />
            </Link>
          )}

          {/* Auth not configured warning */}
          {!setup.authConfigured && (
            <Link
              href="/settings?tab=security"
              className={styles.iconBtn}
              title="Authentication not configured — click to set up"
              id="shell-auth-warning"
            >
              <span className={styles.warningIcon}>🔐</span>
              <span className={styles.warningDot} />
            </Link>
          )}

          {/* Settings gear */}
          <Link
            href="/settings"
            className={styles.iconBtn}
            title="Settings"
            id="shell-settings"
          >
            ⚙️
          </Link>
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
