"use client";

import { useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { AgentChip } from "@/components/AgentChip";
import { WorkTree } from "@/components/work/WorkTree";
import { WorkDetail } from "@/components/work/WorkDetail";
import { WorkRespondForm } from "@/components/work/WorkRespondForm";
import { useWorkEnvelopes } from "@/components/work/useWorkEnvelopes";
import type { WorkEnvelope } from "@/lib/types";

type FilterMode = "all" | "active" | "needs_input" | "completed" | "responsibilities";

export default function WorkPage() {
  const { id } = useParams<{ id: string }>();
  const { primes, sidebarFleet } = usePrime();
  const prime = primes.find((p) => p.id === id);
  const fleet = sidebarFleet[id] || [];

  const { envelopes, loading } = useWorkEnvelopes(id);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");

  /* ---- Computed values ---- */
  const needsInputCount = useMemo(
    () => envelopes.filter((e) => e.status === "needs_input").length,
    [envelopes]
  );

  const activeCount = useMemo(
    () => envelopes.filter((e) => e.status === "active" || e.status === "waiting").length,
    [envelopes]
  );

  const selectedEnvelope = useMemo(
    () => envelopes.find((e) => e.id === selectedWorkId) || null,
    [envelopes, selectedWorkId]
  );

  /* ---- Agent focus data ---- */
  const agentTasks = useMemo(() => {
    const map = new Map<string, WorkEnvelope | null>();
    for (const agent of fleet) {
      if (agent.status === "removed") continue;
      const activeTask = envelopes.find(
        (e) => e.owner === agent.name && (e.status === "active" || e.status === "waiting")
      );
      map.set(agent.name, activeTask || null);
    }
    return map;
  }, [fleet, envelopes]);

  /* ---- Filter descriptions for the filter bar ---- */
  const filters: { mode: FilterMode; label: string; count?: number; badgeClass?: string }[] = [
    { mode: "all", label: "All" },
    { mode: "active", label: "Active", count: activeCount, badgeClass: styles.filterBadgeMint },
    { mode: "needs_input", label: "Needs Input", count: needsInputCount, badgeClass: styles.filterBadgeAmber },
    { mode: "completed", label: "Completed" },
    { mode: "responsibilities", label: "Responsibilities" },
  ];

  return (
    <div className={styles.workShell} id="work-page">
      {/* ---- Header ---- */}
      <header className={styles.workHeader}>
        <span className={styles.workHeaderIcon}>🌳</span>
        <h1 className={styles.workTitle}>
          Work — {prime?.name || "Prime"}
        </h1>
        <Link href={`/p/${id}`} className={styles.workBack} id="work-back-btn">
          ← Hub
        </Link>
      </header>

      {/* ---- Filter Bar ---- */}
      <div className={styles.filterBar} id="work-filter-bar">
        {filters.map((f) => (
          <button
            key={f.mode}
            id={`work-filter-${f.mode}`}
            className={`${styles.filterBtn} ${filter === f.mode ? styles.filterBtnActive : ""}`}
            onClick={() => setFilter(f.mode)}
          >
            {f.label}
            {f.count !== undefined && f.count > 0 && (
              <span className={`${styles.filterBadge} ${f.badgeClass || ""}`}>{f.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ---- Agent Focus Strip ---- */}
      {fleet.length > 0 && (
        <div className={styles.agentStrip} id="work-agent-strip">
          {Array.from(agentTasks.entries()).map(([name, task]) => (
            <AgentChip
              key={name}
              name={name}
              status={fleet.find((a) => a.name === name)?.status || "offline"}
              task={task ? truncate(task.instruction || task.intent, 40) : undefined}
            />
          ))}
        </div>
      )}

      {/* ---- Main Layout ---- */}
      <div className={styles.workLayout}>
        {/* Tree Panel */}
        <div className={styles.workTreePanel}>
          <WorkTree
            primeId={id}
            onSelectEnvelope={setSelectedWorkId}
            selectedId={selectedWorkId}
          />
        </div>

        {/* Detail Panel */}
        <div className={styles.workDetailPanel}>
          <WorkDetail
            envelope={selectedEnvelope}
            onNavigate={setSelectedWorkId}
          />
          {selectedEnvelope?.status === "needs_input" && (
            <WorkRespondForm
              envelope={selectedEnvelope}
              primeId={id}
              onResponded={() => setSelectedWorkId(null)}
            />
          )}
          {selectedEnvelope?.status === "blocked" && (
            <div style={{ padding: 16 }}>
              <div
                style={{
                  padding: "10px 12px",
                  background: "rgba(216, 79, 69, 0.08)",
                  border: "1px solid rgba(216, 79, 69, 0.2)",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <strong style={{ color: "#D84F45" }}>🚫 Blocked:</strong>{" "}
                <span style={{ color: "#AEB8C4" }}>
                  {selectedEnvelope.blocker || "Unknown blocker"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Helper ---- */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
