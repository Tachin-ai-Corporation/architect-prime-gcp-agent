"use client";

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import styles from "./page.module.css";
import { useWorkEnvelopes } from "@/components/work/useWorkEnvelopes";
import type { WorkEnvelope } from "@/lib/types";

const STATUS_ICONS: Record<string, { icon: string; cls: string }> = {
  complete: { icon: "✓", cls: "mint" },
  active: { icon: "●", cls: "aqua" },
  waiting: { icon: "●", cls: "aqua" },
  needs_input: { icon: "⚡", cls: "amber" },
  pending: { icon: "○", cls: "gray" },
  failed: { icon: "✕", cls: "red" },
  blocked: { icon: "◉", cls: "amber" },
  cancelled: { icon: "—", cls: "gray" },
};

function elapsed(env: WorkEnvelope): string {
  const start = env.started_at || env.created_at;
  const end = env.completed_at || new Date().toISOString();
  if (!start) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function AgentWork() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const { envelopes, loading } = useWorkEnvelopes(id);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const agentEnvelopes = useMemo(() => {
    return envelopes
      .filter((e) => e.owner === agent)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [envelopes, agent]);

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="agent-work">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>📋 Work — {agent}</h1>
          <span className={styles.count}>{agentEnvelopes.length} task{agentEnvelopes.length !== 1 ? "s" : ""}</span>
        </header>

        {agentEnvelopes.length === 0 && (
          <div className={styles.empty} id="agent-work-empty">
            <div className={styles.emptyIcon}>📋</div>
            <div className={styles.emptyTitle}>No work assigned</div>
            <div className={styles.emptyDesc}>Tasks owned by {agent} will appear here.</div>
          </div>
        )}

        <div className={styles.timeline} id="agent-work-timeline">
          {agentEnvelopes.map((env) => {
            const si = STATUS_ICONS[env.status] || STATUS_ICONS.pending;
            const isExpanded = expandedId === env.id;
            const isActive = env.status === "active" || env.status === "waiting";
            const isInput = env.status === "needs_input";
            const progress = isActive ? ((env.iteration || 1) / 10) * 100 : 0;

            return (
              <div
                key={env.id}
                className={`${styles.task} ${isInput ? styles.taskInput : ""}`}
                id={`task-${env.id}`}
              >
                <button
                  className={styles.taskHeader}
                  onClick={() => setExpandedId(isExpanded ? null : env.id)}
                  id={`task-toggle-${env.id}`}
                >
                  <span className={`${styles.statusIcon} ${styles[si.cls]}`}>{si.icon}</span>
                  <div className={styles.taskMeta}>
                    <span className={styles.taskTime}>
                      {fmtDate(env.created_at)} {fmtTime(env.created_at)}
                    </span>
                    <span className={styles.taskSummary}>
                      {env.instruction?.slice(0, 80) || env.intent}
                    </span>
                    {isActive && (
                      <div className={styles.progressWrap}>
                        <div className={styles.progressBar} style={{ width: `${Math.min(progress, 95)}%` }} />
                      </div>
                    )}
                    {isInput && env.blocker && (
                      <div className={styles.inputQuestion}>{env.blocker}</div>
                    )}
                  </div>
                  <div className={styles.taskRight}>
                    <span className={styles.elapsed}>{elapsed(env)}</span>
                    <div className={styles.tags}>
                      <span className={styles.typeTag}>{env.type}</span>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className={styles.detail} id={`task-detail-${env.id}`}>
                    <div className={styles.detailRow}>
                      <span className={styles.detailLabel}>Status</span>
                      <span className={styles.detailValue}>{env.status}</span>
                    </div>
                    <div className={styles.detailRow}>
                      <span className={styles.detailLabel}>Intent</span>
                      <span className={styles.detailValue}>{env.intent}</span>
                    </div>
                    {env.accept_criteria && (
                      <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>Accept Criteria</span>
                        <span className={styles.detailValue}>{env.accept_criteria}</span>
                      </div>
                    )}
                    {env.output && (
                      <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>Output</span>
                        <span className={styles.detailValue}>{env.output.slice(0, 500)}</span>
                      </div>
                    )}
                    {env.error && (
                      <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>Error</span>
                        <span className={`${styles.detailValue} ${styles.errorText}`}>{env.error}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
