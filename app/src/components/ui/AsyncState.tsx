"use client";

import type { ReactNode } from "react";
import styles from "./AsyncState.module.css";

interface AsyncStateProps {
  loading: boolean;
  error?: string | null;
  /** When provided, an error renders a Retry button that calls this. */
  onRetry?: () => void;
  /** When true (and not loading/error), renders the empty state instead of children. */
  isEmpty?: boolean;
  loadingLabel?: string;
  /** Custom empty-state content (e.g. an icon + bespoke copy). Falls back to a generic line. */
  empty?: ReactNode;
  children: ReactNode;
}

/**
 * Shared loading / error / empty triad. Replaces the near-identical
 * spinner+pulse / error+retry / empty markup that was re-authored across the
 * agent-tab and list-view components. Order: loading → error → empty → children.
 */
export function AsyncState({
  loading,
  error,
  onRetry,
  isEmpty,
  loadingLabel = "Loading…",
  empty,
  children,
}: AsyncStateProps) {
  if (loading) {
    return (
      <div className={styles.loadingState}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>{loadingLabel}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.errorState}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        {onRetry && (
          <button className={styles.retryBtn} onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  if (isEmpty) {
    return (
      <>
        {empty ?? (
          <div className={styles.emptyState}>Nothing here yet.</div>
        )}
      </>
    );
  }
  return <>{children}</>;
}

/** Convenience: the shared empty-state wrapper (icon + copy) for use in `empty` props. */
export function EmptyState({ icon, children }: { icon?: string; children: ReactNode }) {
  return (
    <div className={styles.emptyState}>
      {icon && <div className={styles.emptyIcon}>{icon}</div>}
      {children}
    </div>
  );
}
