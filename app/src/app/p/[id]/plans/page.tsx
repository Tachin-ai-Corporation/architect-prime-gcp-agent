"use client";

import { Suspense, use, useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import type { Plan } from "@/lib/types";

/* ---- Wrapper with Suspense ---- */
export default function PlansPageWrapper({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <PlansPage primeId={id} />
    </Suspense>
  );
}

/* ---- Status badge ---- */
function PlanStatusBadge({ status }: { status: Plan["status"] }) {
  const cls =
    status === "draft" ? styles.badgeDraft
    : status === "approved" ? styles.badgeApproved
    : status === "executing" ? styles.badgeExecuting
    : status === "complete" ? styles.badgeComplete
    : status === "abandoned" ? styles.badgeAbandoned
    : styles.badgeDraft;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}

/* ---- Main page ---- */
function PlansPage({ primeId }: { primeId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramPlan = searchParams.get("plan");

  return (
    <div className={styles.shell}>
      {paramPlan ? (
        <PlanDetailView primeId={primeId} planId={paramPlan} router={router} />
      ) : (
        <PlanListView primeId={primeId} router={router} />
      )}
    </div>
  );
}

/* ================================================================
   List View
   ================================================================ */
function PlanListView({ primeId, router }: { primeId: string; router: ReturnType<typeof useRouter> }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await api<{ plans: Plan[] }>(`/api/primes/${primeId}/plans`);
      if (!cancelled) {
        setPlans(data?.plans ?? []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId]);

  const handleSelectPlan = useCallback(
    (planId: string) => {
      const params = new URLSearchParams();
      params.set("plan", planId);
      router.push(`/p/${primeId}/plans?${params.toString()}`);
    },
    [primeId, router]
  );

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading plans…</span>
      </div>
    );
  }

  return (
    <>
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Plans</h1>
        <span className={styles.countPill}>{plans.length} total</span>
      </div>
      <div className={styles.pgSub}>
        Execution plans from processes — review, approve, and track progress
      </div>

      {plans.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📑</div>
          <div className={styles.emptyTitle}>No plans yet</div>
          <div className={styles.emptySub}>
            Plans are created when agents execute processes
          </div>
        </div>
      ) : (
        <div className={styles.grid}>
          {plans.map((plan) => (
            <button
              key={plan.id}
              id={`plan-card-${plan.id}`}
              className={styles.card}
              onClick={() => handleSelectPlan(plan.id)}
            >
              <div className={styles.cardHeader}>
                <span className={styles.cardName}>{plan.name}</span>
                <PlanStatusBadge status={plan.status} />
              </div>

              <div className={styles.cardMeta}>
                {plan.process_id && (
                  <span className={styles.processBadge}>⚙️ {plan.process_id}</span>
                )}
                {plan.project_id && (
                  <span>📁 {plan.project_id}</span>
                )}
                {plan.approved_by && (
                  <span>✓ {plan.approved_by}</span>
                )}
              </div>

              <div className={styles.cardDate}>
                Created {new Date(plan.created_at).toLocaleDateString()}
                {plan.layout?.checkpoints && (
                  <> · {plan.layout.checkpoints.length} checkpoint{plan.layout.checkpoints.length !== 1 ? "s" : ""}</>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/* ================================================================
   Detail View
   ================================================================ */
function PlanDetailView({
  primeId,
  planId,
  router,
}: {
  primeId: string;
  planId: string;
  router: ReturnType<typeof useRouter>;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await api<{ plan: Plan }>(`/api/primes/${primeId}/plans/${planId}`);
      if (!cancelled) {
        setPlan(data?.plan ?? null);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId, planId]);

  const handleBack = useCallback(() => {
    router.push(`/p/${primeId}/plans`);
  }, [primeId, router]);

  const handleApprove = useCallback(async () => {
    setSaving(true);
    const result = await api<{ plan: Plan }>(`/api/primes/${primeId}/plans/${planId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", approved_by: "operator" }),
    });
    if (result?.plan) setPlan(result.plan);
    setSaving(false);
  }, [primeId, planId]);

  const handleAbandon = useCallback(async () => {
    setSaving(true);
    const result = await api<{ plan: Plan }>(`/api/primes/${primeId}/plans/${planId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "abandoned" }),
    });
    if (result?.plan) setPlan(result.plan);
    setSaving(false);
  }, [primeId, planId]);

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading plan…</span>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>⚠</div>
        <div className={styles.emptyTitle}>Plan not found</div>
        <button className={styles.backBtn} onClick={handleBack}>← Back to plans</button>
      </div>
    );
  }

  const checkpoints = plan.layout?.checkpoints ?? [];
  const amendments = plan.amendments ?? [];

  return (
    <>
      <button className={styles.backBtn} onClick={handleBack} id="plan-back-btn">
        ← Back to plans
      </button>

      {/* ---- Header ---- */}
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <h1 className={styles.pgTitle}>{plan.name}</h1>
          <PlanStatusBadge status={plan.status} />
          {plan.process_id && (
            <span className={styles.processBadge}>⚙️ {plan.process_id}{plan.process_version ? ` v${plan.process_version}` : ""}</span>
          )}
        </div>

        <div className={styles.detailMetaRow}>
          {plan.project_id && (
            <Link
              href={`/projects?project=${plan.project_id}`}
              className={styles.linkPill}
              id="plan-project-link"
            >
              📁 {plan.project_id}
            </Link>
          )}
          <span className={styles.detailMetaItem}>
            📅 Created {new Date(plan.created_at).toLocaleDateString()}
          </span>
          {plan.approved_by && (
            <span className={styles.detailMetaItem}>
              ✓ Approved by {plan.approved_by}
              {plan.approved_at && ` on ${new Date(plan.approved_at).toLocaleDateString()}`}
            </span>
          )}
          {plan.mission_id && (
            <Link
              href={`/p/${primeId}/work`}
              className={styles.linkPill}
              id="plan-mission-link"
            >
              🔗 View Mission
            </Link>
          )}
        </div>
      </div>

      {/* ---- Mission Overview ---- */}
      {plan.layout?.mission && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Mission</h2>
          </div>
          <div className={styles.missionBlock}>
            <div className={styles.missionInstruction}>{plan.layout.mission.instruction}</div>
            <div className={styles.missionAcceptLabel}>Acceptance Criteria</div>
            <div className={styles.missionAcceptText}>{plan.layout.mission.accept_criteria}</div>
            {plan.layout.mission.owner && (
              <div className={styles.missionOwner}>Owner: {plan.layout.mission.owner}</div>
            )}
          </div>
        </div>
      )}

      {/* ---- Checkpoints ---- */}
      {checkpoints.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Checkpoints</h2>
            <span className={styles.countPill}>{checkpoints.length} total</span>
          </div>
          <div className={styles.checkpointList}>
            {checkpoints.map((cp, ci) => (
              <div key={ci} className={styles.checkpoint}>
                <div className={styles.checkpointDot} />
                <div className={styles.checkpointHeader}>
                  Checkpoint {ci + 1}
                </div>
                <div className={styles.checkpointCriteria}>
                  {cp.instruction}
                  {cp.accept_criteria && (
                    <> — <em>{cp.accept_criteria}</em></>
                  )}
                </div>

                {cp.tasks && cp.tasks.length > 0 && (
                  <div className={styles.taskList}>
                    {cp.tasks.map((task, ti) => (
                      <div key={ti} className={styles.taskItem}>
                        <span className={styles.taskDot} />
                        <div className={styles.taskBody}>
                          <div className={styles.taskInstruction}>{task.instruction}</div>
                          <div className={styles.taskMeta}>
                            {task.agent && <>Agent: {task.agent}</>}
                            {task.accept_criteria && <> · {task.accept_criteria}</>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Amendments ---- */}
      {amendments.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Amendments</h2>
            <span className={styles.countPill}>{amendments.length}</span>
          </div>
          <div className={styles.amendmentList}>
            {amendments.map((a, i) => (
              <div key={i} className={styles.amendment}>
                <div className={styles.amendmentHeader}>
                  <span>{a.amended_by}</span>
                  <span>{new Date(a.timestamp).toLocaleDateString()}</span>
                </div>
                <div className={styles.amendmentReason}>{a.reason}</div>
                <div className={styles.amendmentChanges}>{a.changes}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Actions ---- */}
      {(plan.status === "draft" || plan.status === "approved" || plan.status === "executing") && (
        <div className={styles.actions}>
          {plan.status === "draft" && (
            <button
              id="plan-approve-btn"
              className={styles.approveBtn}
              onClick={handleApprove}
              disabled={saving}
            >
              {saving ? "Approving…" : "✓ Approve Plan"}
            </button>
          )}
          <button
              id="plan-abandon-btn"
              className={styles.abandonBtn}
              onClick={handleAbandon}
              disabled={saving}
            >
              {saving ? "Abandoning…" : "Abandon"}
            </button>
        </div>
      )}
    </>
  );
}
