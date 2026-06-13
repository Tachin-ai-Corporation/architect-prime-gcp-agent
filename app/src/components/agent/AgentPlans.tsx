"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import styles from "./AgentItems.module.css";

/* ================================================================
   Types
   ================================================================ */

export interface PlanSummary {
  id: string;
  name: string;
  project_id: string;
  process_id: string | null;
  status: "draft" | "approved" | "executing" | "complete" | "abandoned";
  mission_id: string | null;
  created_at: string;
  updated_at: string;
  layout?: {
    mission?: { owner?: string };
    checkpoints?: { tasks?: { agent?: string }[] }[];
  };
}

interface PlansResponse {
  plans: PlanSummary[];
}

interface AgentPlansProps {
  primeId: string;
  agentEmail: string;
}

/* ================================================================
   Helpers
   ================================================================ */

/** Check if agent is assigned to a plan — either as mission owner or as a checkpoint task agent */
function isAgentOnPlan(plan: PlanSummary, email: string): boolean {
  if (plan.layout?.mission?.owner === email) return true;
  if (plan.layout?.checkpoints) {
    for (const cp of plan.layout.checkpoints) {
      if (cp.tasks) {
        for (const task of cp.tasks) {
          if (task.agent === email) return true;
        }
      }
    }
  }
  return false;
}

function getCheckpointCount(plan: PlanSummary): number {
  return plan.layout?.checkpoints?.length ?? 0;
}

const STATUS_CLASS: Record<string, string> = {
  draft: styles.statusDraft,
  approved: styles.statusApproved,
  executing: styles.statusExecuting,
  complete: styles.statusComplete,
  abandoned: styles.statusAbandoned,
};

/* ================================================================
   Component
   ================================================================ */

export function AgentPlans({ primeId, agentEmail }: AgentPlansProps) {
  const router = useRouter();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "mine">("all");

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api<PlansResponse>(`/api/primes/${primeId}/plans`);
    if (!res) {
      setError("Failed to load plans");
      setLoading(false);
      return;
    }
    setPlans(res.plans ?? []);
    setLoading(false);
  }, [primeId]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  /* ---- Sorted + filtered list ---- */
  const displayed = useMemo(() => {
    const sorted = [...plans].sort((a, b) => {
      const aAssigned = isAgentOnPlan(a, agentEmail) ? 0 : 1;
      const bAssigned = isAgentOnPlan(b, agentEmail) ? 0 : 1;
      if (aAssigned !== bAssigned) return aAssigned - bAssigned;
      // Secondary sort: most recently updated first
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    if (filter === "mine") {
      return sorted.filter((p) => isAgentOnPlan(p, agentEmail));
    }
    return sorted;
  }, [plans, agentEmail, filter]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.loadingState}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>Loading plans…</span>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.errorState}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        <button className={styles.retryBtn} onClick={fetchPlans}>
          Retry
        </button>
      </div>
    );
  }

  /* ---- Empty ---- */
  if (plans.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>📋</div>
        No plans found
      </div>
    );
  }

  /* ---- List ---- */
  return (
    <>
      <div className={styles.filterBar}>
        <button
          className={`${styles.filterBtn} ${filter === "all" ? styles.filterBtnActive : ""}`}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        <button
          className={`${styles.filterBtn} ${filter === "mine" ? styles.filterBtnActive : ""}`}
          onClick={() => setFilter("mine")}
        >
          My Plans
        </button>
      </div>

      {displayed.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>📋</div>
          No assigned plans
        </div>
      ) : (
        <div className={styles.itemList}>
          {displayed.map((plan) => {
            const assigned = isAgentOnPlan(plan, agentEmail);
            const cpCount = getCheckpointCount(plan);
            return (
              <div
                key={plan.id}
                className={`${styles.itemCard} ${
                  assigned ? styles.itemCardHighlighted : styles.itemCardDimmed
                }`}
                onClick={() =>
                  router.push(`/p/${primeId}/plans?plan=${plan.id}`)
                }
              >
                {/* Header */}
                <div className={styles.cardHeader}>
                  <span className={styles.cardTitle}>{plan.name}</span>
                  <div className={styles.badges}>
                    {assigned && (
                      <span className={styles.assignedBadge}>Assigned</span>
                    )}
                    <span
                      className={`${styles.statusBadge} ${STATUS_CLASS[plan.status] ?? ""}`}
                    >
                      {plan.status}
                    </span>
                  </div>
                </div>

                {/* Meta */}
                <div className={styles.cardMeta}>
                  {cpCount > 0 && (
                    <span className={styles.metaItem}>
                      🏁 {cpCount} checkpoint{cpCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {plan.project_id && (
                    <span className={styles.metaItem}>
                      📁 {plan.project_id}
                    </span>
                  )}
                  {plan.mission_id && (
                    <span className={styles.metaItem}>
                      🎯 Mission linked
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
