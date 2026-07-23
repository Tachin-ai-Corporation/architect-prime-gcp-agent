"use client";

import { useState, useCallback } from "react";
import { useIntrospect, useIntrospectMutation } from "@/hooks/useIntrospect";
import styles from "./ResponsibilityList.module.css";

/** Format a timestamp as relative time (e.g., "in 2h", "3h ago") */
function formatRelativeTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const absMs = Math.abs(ms);
  const mins = Math.floor(absMs / 60000);
  const suffix = ms > 0 ? '' : ' ago';
  const prefix = ms > 0 ? 'in ' : '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${prefix}${mins}m${suffix}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${prefix}${hrs}h${suffix}`;
  const days = Math.floor(hrs / 24);
  return `${prefix}${days}d${suffix}`;
}

/* ================================================================
   Types
   ================================================================ */

export interface Responsibility {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  min_spacing_minutes: number;
  instruction: string;
  has_process: boolean;
  process_steps: number;
  source: string;
  // Scheduler state — populated by the daemon's cron scheduler
  next_fire_at?: string | null;
  last_fire_at?: string | null;
  last_fire_result?: 'success' | 'failed' | 'skipped' | null;
  last_mission_id?: string | null;
}

interface BrainConfig {
  responsibilities: Responsibility[];
  [key: string]: unknown;
}

interface ResponsibilityListProps {
  primeId: string;
  agentName: string;
}

/* ================================================================
   Component
   ================================================================ */

export function ResponsibilityList({ primeId, agentName }: ResponsibilityListProps) {
  const { data, loading, error, refresh } = useIntrospect<BrainConfig>({
    primeId,
    agent: agentName,
    type: "brain_config",
  });

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>Loading responsibilities…</span>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.error}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        <button className={styles.retryBtn} onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  /* ---- Empty ---- */
  const responsibilities = data?.responsibilities ?? [];
  if (responsibilities.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>📋</div>
        No responsibilities configured
      </div>
    );
  }

  /* ---- List ---- */
  return (
    <div className={styles.list}>
      {responsibilities.map((resp) => (
        <ResponsibilityCard
          key={resp.id}
          resp={resp}
          primeId={primeId}
          agentName={agentName}
          onMutated={refresh}
        />
      ))}
    </div>
  );
}

/* ================================================================
   ResponsibilityCard — individual card with toggle switch
   ================================================================ */

interface CardProps {
  resp: Responsibility;
  primeId: string;
  agentName: string;
  onMutated: () => void;
}

interface RunResult {
  success: boolean;
  message?: string;
  error?: string;
}

function ResponsibilityCard({ resp, primeId, agentName, onMutated }: CardProps) {
  const [optimisticEnabled, setOptimisticEnabled] = useState(resp.enabled);
  const [instructionExpanded, setInstructionExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);

  const { mutate, loading: mutating } = useIntrospectMutation({
    primeId,
    agent: agentName,
  });

  const handleRun = useCallback(async () => {
    setRunning(true);
    setRunResult(null);
    const result = await mutate("run_responsibility", { id: resp.id });
    setRunResult(result);
    setRunning(false);
  }, [mutate, resp.id]);

  const handleToggle = useCallback(async () => {
    const newEnabled = !optimisticEnabled;
    // Optimistic update
    setOptimisticEnabled(newEnabled);

    const result = await mutate("set_responsibility_enabled", {
      id: resp.id,
      enabled: newEnabled,
    });

    if (!result.success) {
      // Revert on failure
      setOptimisticEnabled(!newEnabled);
    } else {
      // Refresh parent data to stay in sync
      onMutated();
    }
  }, [optimisticEnabled, mutate, resp.id, onMutated]);

  const spacingHours = (resp.min_spacing_minutes / 60).toFixed(1).replace(/\.0$/, "");

  return (
    <div
      className={`${styles.card} ${!optimisticEnabled ? styles.cardDisabled : ""}`}
    >
      {/* Header */}
      <div className={styles.cardHeader}>
        <span
          className={`${styles.dot} ${
            optimisticEnabled ? styles.dotOn : styles.dotOff
          }`}
        />
        <span className={styles.name}>{resp.name}</span>

        {!optimisticEnabled && (
          <span className={styles.pausedBadge}>Paused</span>
        )}

        <code className={styles.schedule}>{resp.schedule}</code>

        {optimisticEnabled && (
          <button
            className={styles.runBtn}
            onClick={handleRun}
            disabled={running}
            title="Run this responsibility now, out of turn"
          >
            {running ? "Running…" : "▶ Run now"}
          </button>
        )}

        <button
          className={`${styles.toggle} ${optimisticEnabled ? styles.toggleOn : ""}`}
          onClick={handleToggle}
          disabled={mutating}
          aria-label={optimisticEnabled ? "Disable responsibility" : "Enable responsibility"}
        />
      </div>

      {runResult && (
        <div
          className={`${styles.runMsg} ${runResult.success ? styles.runMsgOk : styles.runMsgErr}`}
        >
          {runResult.success ? "✓ " : "⚠ "}
          {runResult.message || runResult.error || (runResult.success ? "Triggered." : "Failed.")}
        </div>
      )}

      {/* Instruction */}
      {resp.instruction && (
        <>
          <div
            className={`${styles.instruction} ${
              instructionExpanded ? styles.instructionExpanded : ""
            }`}
          >
            {resp.instruction}
          </div>
          <button
            className={styles.expandBtn}
            onClick={() => setInstructionExpanded((v) => !v)}
          >
            {instructionExpanded ? "Show less" : "Show more"}
          </button>
        </>
      )}

      {/* Meta */}
      <div className={styles.meta}>
        {resp.has_process && (
          <span className={styles.process}>
            {resp.process_steps} step{resp.process_steps !== 1 ? "s" : ""}
          </span>
        )}
        <span className={styles.spacing}>
          ⏱ {spacingHours}h min spacing
        </span>
        <span className={styles.source}>{resp.source}</span>
      </div>

      {/* Schedule info — next fire time, last result */}
      <div className={styles.meta}>
        {resp.next_fire_at && optimisticEnabled && (
          <span className={styles.spacing} title={resp.next_fire_at}>
            ⏰ Next: {formatRelativeTime(resp.next_fire_at)}
          </span>
        )}
        {resp.last_fire_at && (
          <span className={styles.spacing} title={resp.last_fire_at}>
            {resp.last_fire_result === 'success' ? '✅' : resp.last_fire_result === 'failed' ? '❌' : '⏭️'}
            {' '}Last: {formatRelativeTime(resp.last_fire_at)}
            {resp.last_fire_result && ` (${resp.last_fire_result})`}
          </span>
        )}
      </div>
    </div>
  );
}
