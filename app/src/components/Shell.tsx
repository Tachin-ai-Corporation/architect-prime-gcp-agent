"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrime } from "@/contexts/PrimeContext";
import { OperationsFeed, useOperations } from "./OperationsFeed";
import styles from "./Shell.module.css";

const navItems = [
  { label: "Home", path: "/" },
  { label: "Projects", path: "/projects" },
  { label: "Processes", path: "/processes" },
  { label: "Work", path: "/work" },
  { label: "Brain", path: "/brain" },
  { label: "Skills", path: "/skills" },
  { label: "Agent Types", path: "/agent-types" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const { primes, versionInfo, setup } = usePrime();
  const pathname = usePathname();

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

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/";
    return pathname.startsWith(path);
  };

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

          {/* ---- Nav links (centered) ---- */}
          <nav className={styles.navLinks} id="shell-nav">
            {navItems.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                className={`${styles.navLink} ${isActive(item.path) ? styles.navLinkActive : ""}`}
                id={`nav-${item.path.replace("/", "") || "home"}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>

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
          {firstPrimeId && (
            <button
              className={`${styles.iconBtn} ${activeCount > 0 ? styles.opsActive : ""}`}
              onClick={() => setOpsOpen((v) => !v)}
              title={activeCount > 0 ? `${activeCount} active operation${activeCount > 1 ? "s" : ""}` : "Operations"}
              id="shell-ops-toggle"
            >
              🔔
              {activeCount > 0 && (
                <span className={styles.opsBadge}>{activeCount}</span>
              )}
            </button>
          )}

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
