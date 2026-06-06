"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrime } from "@/contexts/PrimeContext";
import { Breadcrumb } from "./Breadcrumb";
import { OperationsFeed, useOperations } from "./OperationsFeed";
import styles from "./Shell.module.css";



export function Shell({ children }: { children: React.ReactNode }) {
  const { primes, versionInfo, setup } = usePrime();
  const pathname = usePathname();

  /* Poll operations across all primes */
  const primeIds = useMemo(() => primes.map(p => p.id), [primes]);
  const { operations, activeCount, refresh } = useOperations(primeIds);

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

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/";
    return pathname.startsWith(path);
  };

  const handleClearOps = useCallback(async () => {
    await Promise.all(
      primeIds.map((pid) =>
        fetch(`/api/primes/${pid}/ops`, { method: "DELETE" }).catch(() => {})
      )
    );
    refresh();
  }, [primeIds, refresh]);

  return (
    <div className={styles.shell} id="shell">
      {/* ---- Top bar ---- */}
      <header className={styles.topBar} id="shell-topbar">
        <div className={styles.topBarLeft}>
          <Link href="/" className={styles.logoLink} id="shell-home-link">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/architect-prime-logo.png" alt="Architect Prime" width={28} height={28} className={styles.logoImg} />
            <span className={styles.logoTitle}>Architect Prime</span>
          </Link>
        </div>

          {/* ---- Breadcrumb navigation (replaces flat nav links) ---- */}
          <div className={styles.breadcrumbArea}>
            <Breadcrumb inline />
          </div>

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

          {/* Operations toggle */}
          {primeIds.length > 0 && (
            <button
              className={`${styles.iconBtn} ${activeCount > 0 ? styles.opsActive : ""}`}
              onClick={() => {
                setOpsOpen((v) => {
                  if (!v) refresh();
                  return !v;
                });
              }}
              title={activeCount > 0 ? `${activeCount} active operation${activeCount > 1 ? "s" : ""}` : "Operations"}
              id="shell-ops-toggle"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <rect x="2" y="2" width="12" height="12" rx="2" />
                <line x1="5" y1="5.5" x2="11" y2="5.5" />
                <line x1="5" y1="8" x2="9" y2="8" />
                <line x1="5" y1="10.5" x2="10" y2="10.5" />
              </svg>
              {activeCount > 0 && (
                <span className={styles.opsBadge}>{activeCount}</span>
              )}
            </button>
          )}

          {/* Library link */}
          <Link
            href="/library"
            className={`${styles.iconBtn} ${isActive("/library") ? styles.iconBtnActive : ""}`}
            title="Library"
            id="shell-library"
          >
            📚
          </Link>

          {/* Settings gear */}
          <Link
            href="/settings"
            className={`${styles.iconBtn} ${isActive("/settings") ? styles.iconBtnActive : ""}`}
            title="Settings"
            id="shell-settings"
          >
            ⚙️
          </Link>

          {/* Version tag */}
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
      </header>

      {/* ---- Operations Drawer ---- */}
      {opsOpen && primeIds.length > 0 && (
        <div className={styles.opsDrawer} id="ops-drawer">
          <OperationsFeed
            primeId={primeIds[0] || ""}
            operations={operations}
            onClose={() => setOpsOpen(false)}
            onClear={handleClearOps}
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
