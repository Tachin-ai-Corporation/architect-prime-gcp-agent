"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrime } from "@/contexts/PrimeContext";
import { Breadcrumb } from "./Breadcrumb";
import { OperationsFeed, useOperations } from "./OperationsFeed";
import { ApprovalsFeed, useApprovals } from "./work/ApprovalsFeed";
import styles from "./Shell.module.css";

export function Shell({ children }: { children: React.ReactNode }) {
  const { primes, versionInfo, setup } = usePrime();
  const pathname = usePathname();

  // Auth pages (sign-in / error) render BARE — no fleet chrome, no live polling.
  // Shell lives in the root layout, so it wraps every route including /auth; without
  // this gate the signed-out sign-in page showed the header badges and the live
  // Operations/Approvals feeds (real fleet activity) to a viewer with no session.
  const isAuthPage = pathname?.startsWith("/auth") ?? false;

  /* Poll operations across all primes — never on auth pages (empty list = no fetch). */
  const primeIds = useMemo(() => (isAuthPage ? [] : primes.map(p => p.id)), [primes, isAuthPage]);
  const { operations, activeCount, refresh } = useOperations(primeIds);
  const { approvals, pendingCount, refresh: refreshApprovals } = useApprovals(primeIds);

  /* Drawer state — Operations and Approvals share the right slot, so open one closes the other. */
  const [opsOpen, setOpsOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);

  /* Auto-open drawer when new active operations appear */
  //
  // Kept in an effect, wrapped like the rest. React does document adjusting
  // state during render for a previous-value comparison, and I tried it here —
  // it hung the entire app at the loading screen. Shell wraps every page from
  // layout.tsx, and `activeCount` comes from useOperations, which sets state of
  // its own; setting state during Shell's render fed that loop and React never
  // committed. The APIs all returned 200 the whole time.
  const [prevActiveCount, setPrevActiveCount] = useState(0);
  useEffect(() => {
    void (async () => {
      if (activeCount > prevActiveCount && activeCount > 0) {
        setOpsOpen(true);
      }
      setPrevActiveCount(activeCount);
    })();
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

  // Signed-out surface: render only the page (it carries its own full-screen layout).
  if (isAuthPage) return <>{children}</>;

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
              href="/settings#integration"
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
              href="/settings#security"
              className={styles.iconBtn}
              title="Authentication not configured — click to set up"
              id="shell-auth-warning"
            >
              <span className={styles.warningIcon}>🔐</span>
              <span className={styles.warningDot} />
            </Link>
          )}

          {/* Approvals toggle */}
          {primeIds.length > 0 && (
            <button
              className={`${styles.iconBtn} ${pendingCount > 0 ? styles.opsActive : ""}`}
              onClick={() => {
                setOpsOpen(false);
                setApprovalsOpen((v) => {
                  if (!v) refreshApprovals();
                  return !v;
                });
              }}
              title={pendingCount > 0 ? `${pendingCount} pending approval${pendingCount > 1 ? "s" : ""}` : "Approvals"}
              id="shell-approvals-toggle"
            >
              ✅
              {pendingCount > 0 && (
                <span className={styles.opsBadge}>{pendingCount}</span>
              )}
            </button>
          )}

          {/* Operations toggle */}
          {primeIds.length > 0 && (
            <button
              className={`${styles.iconBtn} ${activeCount > 0 ? styles.opsActive : ""}`}
              onClick={() => {
                setApprovalsOpen(false);
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
            <Link href="/settings#system" className={styles.versionTag} id="shell-version">
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

      {/* ---- Approvals Drawer (shares the right slot with Operations) ---- */}
      {approvalsOpen && primeIds.length > 0 && (
        <div className={styles.opsDrawer} id="approvals-drawer">
          <ApprovalsFeed
            approvals={approvals}
            onClose={() => setApprovalsOpen(false)}
            onResolved={refreshApprovals}
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
