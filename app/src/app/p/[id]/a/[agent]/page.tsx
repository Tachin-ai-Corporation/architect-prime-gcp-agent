"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import styles from "./page.module.css";
import { NavCard } from "@/components/NavCard";
import { StatusStrip } from "@/components/StatusStrip";
import { api } from "@/lib/api";
import type { AgentDetail } from "@/lib/types";

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatUptime(mins: number | null): string {
  if (mins == null) return "—";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function AgentHub() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDetail = useCallback(async () => {
    const data = await api<AgentDetail>(`/api/primes/${id}/fleet/${agent}/logs`);
    if (data) setDetail(data);
    setLoading(false);
  }, [id, agent]);

  useEffect(() => {
    fetchDetail();
    const iv = setInterval(fetchDetail, 8000);
    return () => clearInterval(iv);
  }, [fetchDetail]);

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading…</div>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.empty}>Agent &ldquo;{agent}&rdquo; not found.</div>
        </div>
      </div>
    );
  }

  const healthLabel = detail.healthy ? "Healthy" : "Unhealthy";
  const healthColor = detail.healthy ? "mint" as const : "amber" as const;
  const currentTask = detail.activity?.[0]?.summary || "Idle";

  return (
    <div className={styles.shell} id="agent-hub">
      <div className={styles.container}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.avatar}>
            {agent.charAt(0).toUpperCase()}
          </div>
          <div className={styles.meta}>
            <h1 className={styles.title}>{agent}</h1>
            <div className={styles.subtitle}>
              {detail.specialty && <span className={styles.specialty}>{detail.specialty}</span>}
              {detail.email && <span className={styles.email}>{detail.email}</span>}
            </div>
          </div>
          <span className={`${styles.statusBadge} ${detail.healthy ? styles.online : styles.offline}`} id="agent-status-badge">
            {detail.status}
          </span>
        </header>

        {/* Status Strip */}
        <div className={styles.strip}>
          <StatusStrip
            items={[
              { label: "Health", value: healthLabel, color: healthColor },
              { label: "Current", value: currentTask.slice(0, 40), color: "aqua" },
              { label: "Heartbeat", value: timeAgo(detail.lastHeartbeat) },
              { label: "Uptime", value: formatUptime(detail.uptimeMinutes) },
            ]}
          />
        </div>

        {/* VM info */}
        {detail.vm && (
          <div className={styles.vmInfo} id="agent-vm-info">
            <span className={styles.vmLabel}>VM</span>
            <span className={styles.vmValue}>{detail.vm}</span>
            {detail.zone && (
              <>
                <span className={styles.vmLabel}>Zone</span>
                <span className={styles.vmValue}>{detail.zone}</span>
              </>
            )}
          </div>
        )}

        {/* NavCard Grid */}
        <div className={styles.grid} id="agent-hub-grid">
          <NavCard
            id="agent-chat"
            icon="💬"
            title="Chat"
            description="Direct message this agent"
            variant="accent"
            href={`/p/${id}/a/${agent}/chat`}
          />
          <NavCard
            id="agent-work"
            icon="📋"
            title="Work"
            description="Task timeline and progress"
            variant="accent"
            href={`/work?prime=${id}&agent=${agent}`}
          />
          <NavCard
            id="agent-brain"
            icon="🧠"
            title="Brain"
            description="LLM model assignments"
            variant="accent"
            href={`/brain?prime=${id}&agent=${agent}`}
          />
          <NavCard
            id="agent-skills"
            icon="🔧"
            title="Skills"
            description="Installed skill kits"
            variant="default"
            href={`/skills?prime=${id}&agent=${agent}`}
          />
          <NavCard
            id="agent-settings"
            icon="⚙"
            title="Settings"
            description="Configuration and actions"
            variant="default"
            href={`/p/${id}/a/${agent}/settings`}
          />
        </div>
      </div>
    </div>
  );
}
