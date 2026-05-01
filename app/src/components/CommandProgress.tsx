"use client";

import { useState, useEffect, useCallback } from "react";

interface CommandProgressProps {
  primeId: string;
  commandId: string;
  label: string;
  onDismiss: () => void;
}

interface CommandStatus {
  id: string;
  type: string;
  status: "pending" | "running" | "complete" | "failed";
  result: string | null;
  error: string | null;
}

/**
 * Real-time command progress tracker.
 * Polls the command status API every 3s and shows live status.
 * Auto-dismisses 10s after completion.
 */
export function CommandProgress({ primeId, commandId, label, onDismiss }: CommandProgressProps) {
  const [status, setStatus] = useState<CommandStatus | null>(null);
  const [expanded, setExpanded] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/primes/${primeId}/commands/${commandId}`);
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        return data.status;
      }
    } catch {
      // network error, keep polling
    }
    return null;
  }, [primeId, commandId]);

  useEffect(() => {
    // Initial fetch
    poll();

    const startTime = Date.now();
    // Poll every 3s until terminal state
    const interval = setInterval(async () => {
      const s = await poll();
      if (s === "complete" || s === "failed") {
        clearInterval(interval);
        // Auto-dismiss after 10s
        setTimeout(onDismiss, 10000);
      } else if (Date.now() - startTime > 5 * 60 * 1000) {
        // Staleness guard: if stuck in pending/running for 5 minutes, auto-dismiss
        clearInterval(interval);
        setTimeout(onDismiss, 3000);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [poll, onDismiss]);

  const statusIcon = {
    pending: "⏳",
    running: "⚙️",
    complete: "✅",
    failed: "❌",
  }[status?.status || "pending"];

  const statusLabel = {
    pending: "Queued",
    running: "Running...",
    complete: "Complete",
    failed: "Failed",
  }[status?.status || "pending"];

  const isTerminal = status?.status === "complete" || status?.status === "failed";
  const hasDetail = status?.result || status?.error;

  return (
    <div className={`cmd-progress ${isTerminal ? (status?.status === "complete" ? "cmd-progress-success" : "cmd-progress-error") : "cmd-progress-active"}`}>
      <div className="cmd-progress-header" onClick={() => hasDetail && setExpanded(!expanded)}>
        <span className="cmd-progress-icon">{statusIcon}</span>
        <div className="cmd-progress-info">
          <span className="cmd-progress-label">{label}</span>
          <span className="cmd-progress-status">{statusLabel}</span>
        </div>
        {!isTerminal && <span className="cmd-progress-spinner" />}
        {hasDetail && (
          <button className="cmd-progress-expand" title={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▾" : "▸"}
          </button>
        )}
        <button className="cmd-progress-close" onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="Dismiss">✕</button>
      </div>
      {expanded && hasDetail && (
        <div className="cmd-progress-detail">
          <pre>{status?.error || status?.result}</pre>
        </div>
      )}
    </div>
  );
}
