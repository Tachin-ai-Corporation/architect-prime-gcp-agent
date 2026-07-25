"use client";

import type { ReactNode } from "react";
import styles from "./DeepDiveShell.module.css";

export interface DeepDiveTab {
  key: string;
  label: string;
  icon: string;
}

export interface DeepDiveIdentity {
  /** Single-character avatar glyph (already upper-cased by the caller). */
  avatarText: string;
  name: string;
  email?: string | null;
  /** Renders a global `badge badge-{status}` pill when present. */
  status?: string | null;
  /** Small pill under the identity (e.g. "prime" or a specialty). */
  specialty?: string | null;
}

interface DeepDiveShellProps {
  identity: DeepDiveIdentity;
  tabs: readonly DeepDiveTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  /** The active tab's content — rendered inside the scrollable main area. */
  children: ReactNode;
}

/**
 * Shared scaffold for the prime and agent deep-dive pages: the left identity
 * sidebar + tab nav, the mobile tab dropdown, and the scrollable main content
 * area. Tab content is passed as `children`; hash-synced tab state lives in the
 * page via `useHashTab`. The two pages previously carried byte-identical copies
 * of this markup + CSS.
 */
export function DeepDiveShell({
  identity,
  tabs,
  activeTab,
  onTabChange,
  children,
}: DeepDiveShellProps) {
  return (
    <div className={styles.agentPage}>
      <div className={styles.pageLayout}>
        {/* ---- Left Sidebar ---- */}
        <div className={styles.sidebar}>
          <div className={styles.sidebarIdentity}>
            <div className={styles.sidebarAvatar}>{identity.avatarText}</div>
            <div className={styles.sidebarName}>{identity.name}</div>
            {identity.email && (
              <div className={styles.sidebarEmail}>{identity.email}</div>
            )}
            {identity.status && (
              <div className={styles.sidebarStatus}>
                <span className={`badge badge-${identity.status}`}>
                  {identity.status}
                </span>
              </div>
            )}
            {identity.specialty && (
              <div className={styles.sidebarSpecialty}>{identity.specialty}</div>
            )}
          </div>
          <div className={styles.sidebarDivider} />
          <nav className={styles.sidebarNav}>
            {tabs.map((tab, i) => (
              <button
                key={tab.key}
                className={`${styles.sidebarNavItem}${activeTab === tab.key ? ` ${styles.sidebarNavItemActive}` : ""}`}
                onClick={() => onTabChange(tab.key)}
                style={i === 2 ? { marginTop: 8 } : undefined}
              >
                <span className={styles.sidebarNavIcon}>{tab.icon}</span>
                <span className={styles.sidebarNavLabel}>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* ---- Mobile Tab Dropdown ---- */}
        <div className={styles.tabDropdownWrap}>
          <select
            className={styles.tabDropdown}
            value={activeTab}
            onChange={(e) => onTabChange(e.target.value)}
          >
            {tabs.map((tab) => (
              <option key={tab.key} value={tab.key}>
                {tab.icon} {tab.label}
              </option>
            ))}
          </select>
        </div>

        {/* ---- Main Content ---- */}
        <div className={styles.mainContent}>{children}</div>
      </div>
    </div>
  );
}
