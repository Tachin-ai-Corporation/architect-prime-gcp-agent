"use client";

import Link from "next/link";
import { Breadcrumb } from "./Breadcrumb";
import { usePrime } from "@/contexts/PrimeContext";
import styles from "./Shell.module.css";

export function Shell({ children }: { children: React.ReactNode }) {
  const { versionInfo } = usePrime();

  return (
    <div className={styles.shell} id="shell">
      {/* ---- Top bar ---- */}
      <header className={styles.topBar} id="shell-topbar">
        <div className={styles.topBarLeft}>
          <Breadcrumb />
        </div>

        <div className={styles.topBarRight}>
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
