"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { ContextEditor } from "./ContextEditor";
import type { ContextEntry } from "./ContextEditor";
import { ProjectStatusBadge } from "./ProjectStatusBadge";
import type { ProjectDetail, ProcessSummary, PromotionEntry } from "./types";
import styles from "@/app/p/[id]/projects/page.module.css";

const KIND_ICONS: Record<string, string> = {
  document: "📄",
  code: "💻",
  config: "⚙️",
  reference: "📌",
  learning: "🧠",
  decision: "⚖️",
};

interface ProjectDetailViewProps {
  primeId?: string;
  projectId: string;
}

export function ProjectDetailView({ primeId, projectId }: ProjectDetailViewProps) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editDesc, setEditDesc] = useState(false);
  const [desc, setDesc] = useState("");
  const [contextDirty, setContextDirty] = useState(false);
  const [localContext, setLocalContext] = useState<Record<string, ContextEntry>>({});
  const [saving, setSaving] = useState(false);
  const [resolvedPrimeId, setResolvedPrimeId] = useState<string | null>(null);

  /* ---- Standard Processes state ---- */
  const [allProcesses, setAllProcesses] = useState<ProcessSummary[]>([]);
  const [linkedProcessIds, setLinkedProcessIds] = useState<string[]>([]);
  const [showProcessDropdown, setShowProcessDropdown] = useState(false);
  const [processesDirty, setProcessesDirty] = useState(false);

  /* ---- Suggested Context (promotions) state ---- */
  const [promotions, setPromotions] = useState<PromotionEntry[]>([]);
  const [promotionsLoading, setPromotionsLoading] = useState(false);

  /* ---- Fetch project ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await api<{ project: ProjectDetail }>(`/api/projects/${projectId}`);
      if (!cancelled && data?.project) {
        setProject(data.project);
        setDesc(data.project.description);
        setLocalContext(data.project.context ?? {});
        setLinkedProcessIds(data.project.standardProcesses ?? []);
        setResolvedPrimeId(primeId || data.project.created_by || "chuck");
        setLoading(false);
      } else if (!cancelled) {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId, projectId]);

  /* ---- Fetch all processes for linking ---- */
  useEffect(() => {
    if (!resolvedPrimeId) return;
    let cancelled = false;
    (async () => {
      const data = await api<{ processes: ProcessSummary[] }>(`/api/primes/${resolvedPrimeId}/processes`);
      if (!cancelled && data?.processes) {
        setAllProcesses(data.processes);
      }
    })();
    return () => { cancelled = true; };
  }, [resolvedPrimeId]);

  /* ---- Fetch pending promotions ---- */
  useEffect(() => {
    let cancelled = false;
    setPromotionsLoading(true);
    (async () => {
      const data = await api<{ promotions: PromotionEntry[] }>(
        `/api/projects/${projectId}/promotions?status=pending`
      );
      if (!cancelled) {
        setPromotions(data?.promotions ?? []);
        setPromotionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  /* ---- Back nav ---- */
  const handleBack = useCallback(() => {
    if (primeId) {
      router.push(`/p/${primeId}/projects`);
    } else {
      router.push(`/projects`);
    }
  }, [primeId, router]);

  /* ---- Context change ---- */
  const handleContextChange = useCallback((ctx: Record<string, ContextEntry>) => {
    setLocalContext(ctx);
    setContextDirty(true);
  }, []);

  /* ---- Process linking ---- */
  const handleLinkProcess = useCallback((processId: string) => {
    setLinkedProcessIds((prev) => [...prev, processId]);
    setProcessesDirty(true);
    setShowProcessDropdown(false);
  }, []);

  const handleUnlinkProcess = useCallback((processId: string) => {
    setLinkedProcessIds((prev) => prev.filter((id) => id !== processId));
    setProcessesDirty(true);
  }, []);

  /* ---- Promotion actions ---- */
  const handlePromotionAction = useCallback(async (promotionId: string, action: "accept" | "dismiss") => {
    await api(`/api/projects/${projectId}/promotions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promotionId, action }),
    });
    setPromotions((prev) => prev.filter((p) => p.id !== promotionId));
  }, [projectId]);

  /* ---- Save ---- */
  const isDirty = contextDirty || processesDirty || editDesc;
  const handleSave = useCallback(async () => {
    setSaving(true);
    await api(`/api/projects/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: desc,
        context: localContext,
        standardProcesses: linkedProcessIds,
      }),
    });
    setContextDirty(false);
    setProcessesDirty(false);
    setEditDesc(false);
    setSaving(false);
  }, [projectId, desc, localContext, linkedProcessIds]);

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading project…</span>
      </div>
    );
  }

  if (!project) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>⚠</div>
        <div className={styles.emptyTitle}>Project not found</div>
        <button className={styles.backBtn} onClick={handleBack}>← Back to projects</button>
      </div>
    );
  }

  const progress = (project.missionCount || 0) > 0
    ? ((project.completedMissions || 0) / project.missionCount) * 100
    : 0;

  // Derived data for processes
  const linkedProcesses = allProcesses.filter((p) => linkedProcessIds.includes(p.id));
  const availableProcesses = allProcesses.filter(
    (p) => !linkedProcessIds.includes(p.id) && p.status !== "deprecated"
  );

  return (
    <>
      {/* ---- Header ---- */}
      <button className={styles.backBtn} onClick={handleBack}>← Back to projects</button>

      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <h1 className={styles.pgTitle}>{project.name}</h1>
          <ProjectStatusBadge status={project.status} />
          {project.owner && (
            <span className={styles.detailOwner}>{project.owner}</span>
          )}
        </div>

        {/* Goal */}
        {project.goal && (
          <div className={styles.detailGoal}>{project.goal}</div>
        )}

        {/* Parent link */}
        {project.parent_id && (
          <div style={{ marginBottom: 8 }}>
            <Link
              href={primeId ? `/p/${primeId}/projects?project=${project.parent_id}` : `/projects?project=${project.parent_id}`}
              className={styles.detailParentLink}
            >
              ↑ Parent: {project.parent_id}
            </Link>
          </div>
        )}

        {/* Depends on */}
        {project.depends_on?.length > 0 && (
          <div className={styles.depSection}>
            <div className={styles.depSectionLabel}>Depends On</div>
            <div className={styles.depChips}>
              {project.depends_on.map((dep: string) => (
                <Link
                  key={dep}
                  href={primeId ? `/p/${primeId}/projects?project=${dep}` : `/projects?project=${dep}`}
                  className={styles.depChip}
                >
                  ⛓ {dep}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Description — editable inline */}
        <div className={styles.detailDesc}>
          {editDesc ? (
            <textarea
              className={styles.descTextarea}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={3}
              autoFocus
              onBlur={() => setEditDesc(false)}
            />
          ) : (
            <p className={styles.descText} onClick={() => setEditDesc(true)} title="Click to edit">
              {desc || "No description — click to add"}
            </p>
          )}
        </div>

        {/* Progress */}
        <div className={styles.detailProgress}>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <span className={styles.progressLabel}>
            {project.completedMissions || 0}/{project.missionCount || 0} missions completed
          </span>
        </div>
      </div>

      {/* ---- Context section ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Context</h2>
          {isDirty && (
            <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          )}
        </div>
        <ContextEditor
          context={localContext}
          onChange={handleContextChange}
        />
      </div>

      {/* ---- Standard Processes section ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Standard Processes</h2>
          <div className={styles.processLinkWrap}>
            <button
              className={styles.linkProcessBtn}
              onClick={() => setShowProcessDropdown((v) => !v)}
              disabled={availableProcesses.length === 0}
            >
              + Link Process
            </button>
            {showProcessDropdown && availableProcesses.length > 0 && (
              <div className={styles.processDropdown}>
                {availableProcesses.map((proc) => (
                  <button
                    key={proc.id}
                    className={styles.processDropdownItem}
                    onClick={() => handleLinkProcess(proc.id)}
                  >
                    <span className={styles.processDropdownName}>{proc.name}</span>
                    <span className={styles.processDropdownMeta}>v{proc.version} · {proc.steps?.length ?? 0} steps</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {linkedProcesses.length > 0 ? (
          <div className={styles.processCards}>
            {linkedProcesses.map((proc) => (
              <div key={proc.id} className={styles.processCard}>
                <div className={styles.processCardHeader}>
                  <span className={styles.processCardName}>{proc.name}</span>
                  <button
                    className={styles.processCardRemove}
                    onClick={() => handleUnlinkProcess(proc.id)}
                    title="Remove process"
                  >
                    ✕
                  </button>
                </div>
                <div className={styles.processCardMeta}>
                  <span className={styles.processVersionBadge}>v{proc.version}</span>
                  <span className={styles.processCardSteps}>{proc.steps?.length ?? 0} steps</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptySection}>No processes linked. Click &quot;Link Process&quot; to add one.</div>
        )}
      </div>

      {/* ---- Suggested Context (Promotions) section ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Suggested Context</h2>
          {promotions.length > 0 && (
            <span className={styles.countPill}>{promotions.length} pending</span>
          )}
        </div>

        {promotionsLoading ? (
          <div className={styles.emptySection}>Loading suggestions…</div>
        ) : promotions.length > 0 ? (
          <div className={styles.promotionCards}>
            {promotions.map((promo) => (
              <div key={promo.id} className={styles.promotionCard}>
                <div className={styles.promotionCardBody}>
                  <div className={styles.promotionCardHeader}>
                    <span className={styles.promotionKindIcon}>{KIND_ICONS[promo.kind] || "📎"}</span>
                    <span className={styles.promotionKey}>{promo.contextKey}</span>
                    <span className={styles.promotionName}>{promo.name}</span>
                  </div>
                  <div className={styles.promotionSummary}>{promo.summary}</div>
                  <div className={styles.promotionMeta}>
                    <span>Mission: {promo.sourceMissionId}</span>
                    <span>{new Date(promo.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className={styles.promotionActions}>
                  <button
                    className={styles.promotionAccept}
                    onClick={() => handlePromotionAction(promo.id, "accept")}
                    title="Accept"
                  >
                    ✓
                  </button>
                  <button
                    className={styles.promotionDismiss}
                    onClick={() => handlePromotionAction(promo.id, "dismiss")}
                    title="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptySection}>No pending context suggestions</div>
        )}
      </div>
    </>
  );
}
