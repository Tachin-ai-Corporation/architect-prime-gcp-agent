"use client";

import { Suspense, use, useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { ContextEditor } from "@/components/projects/ContextEditor";
import type { ContextEntry } from "@/components/projects/ContextEditor";

/* ---- Types ---- */
interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  owner: string;
  status: "active" | "complete" | "completed" | "paused" | "archived";
  description: string;
  parent_id: string | null;
  depends_on: string[];
  missionCount: number;
  completedMissions: number;
  participants: string[];
  created_at: string;
  context?: {
    documentation?: string[];
    processes?: string[];
    team?: Record<string, string>;
  } | null;
}

interface ProjectDetail extends ProjectSummary {
  context: Record<string, ContextEntry>;
  standardProcesses?: string[];
}

interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  status: "active" | "deprecated";
  version: number;
  execution_count: number;
  created_by: string;
  created_at: string;
  steps: { title: string }[];
}

interface PromotionEntry {
  id: string;
  contextKey: string;
  kind: string;
  name: string;
  summary: string;
  sourceMissionId: string;
  created_at: string;
  status: "pending" | "accepted" | "dismissed";
}

const KIND_ICONS: Record<string, string> = {
  document: "📄",
  code: "💻",
  config: "⚙️",
  reference: "📌",
  learning: "🧠",
  decision: "⚖️",
};

/* ---- Wrapper with Suspense ---- */
export default function ProjectsPageWrapper({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <ProjectsPage primeId={id} />
    </Suspense>
  );
}

/* ---- Main page ---- */
function ProjectsPage({ primeId }: { primeId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  /* ---- URL params ---- */
  const paramProject = searchParams.get("project");

  /* ---- Render either list or detail ---- */
  return (
    <div className={styles.shell}>
      {paramProject ? (
        <ProjectDetailView
          primeId={primeId}
          projectId={paramProject}
          router={router}
        />
      ) : (
        <ProjectListView primeId={primeId} router={router} />
      )}
    </div>
  );
}

/* ================================================================
   List View
   ================================================================ */
function ProjectListView({ primeId, router }: { primeId: string; router: ReturnType<typeof useRouter> }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  /* ---- Fetch projects ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await api<{ projects: ProjectSummary[] }>(`/api/primes/${primeId}/projects`);
      if (!cancelled) {
        setProjects(data?.projects ?? []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId]);

  const handleSelectProject = useCallback(
    (projectId: string) => {
      const params = new URLSearchParams();
      params.set("project", projectId);
      router.push(`/p/${primeId}/projects?${params.toString()}`);
    },
    [primeId, router]
  );

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading projects…</span>
      </div>
    );
  }

  /* Build hierarchy: top-level + children map */
  const { topLevel, childrenMap } = useMemo(() => {
    const childMap: Record<string, ProjectSummary[]> = {};
    const top: ProjectSummary[] = [];
    for (const proj of projects) {
      if (proj.parent_id) {
        if (!childMap[proj.parent_id]) childMap[proj.parent_id] = [];
        childMap[proj.parent_id].push(proj);
      } else {
        top.push(proj);
      }
    }
    return { topLevel: top, childrenMap: childMap };
  }, [projects]);

  /* Context summary helper */
  const contextSummary = (proj: ProjectSummary) => {
    const parts: string[] = [];
    if (proj.context?.documentation?.length) parts.push(`${proj.context.documentation.length} docs`);
    if (proj.context?.processes?.length) parts.push(`${proj.context.processes.length} processes`);
    if (proj.context?.team) parts.push(`${Object.keys(proj.context.team).length} team`);
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  /* Render a project card */
  const renderProjectCard = (proj: ProjectSummary, isChild = false) => (
    <button
      key={proj.id}
      id={`project-card-${proj.id}`}
      className={`${styles.card} ${isChild ? styles.childIndent : ""}`}
      onClick={() => handleSelectProject(proj.id)}
    >
      <div className={styles.cardHeader}>
        <span className={styles.cardName}>{proj.name}</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {proj.owner && <span className={styles.ownerBadge}>{proj.owner}</span>}
          <StatusBadge status={proj.status} />
        </div>
      </div>
      <div className={styles.cardDesc}>{truncate(proj.description, 100)}</div>
      {proj.goal && <div className={styles.goalText}>{truncate(proj.goal, 80)}</div>}

      {/* Parent link */}
      {proj.parent_id && (
        <Link
          href={`/p/${primeId}/projects?project=${proj.parent_id}`}
          className={styles.parentLink}
          onClick={(e) => e.stopPropagation()}
        >
          ↑ {proj.parent_id}
        </Link>
      )}

      {/* Progress */}
      <div className={styles.progressWrap}>
        <div className={styles.progressBar}>
          <div
            className={styles.progressFill}
            style={{ width: `${(proj.missionCount || 0) > 0 ? ((proj.completedMissions || 0) / proj.missionCount) * 100 : 0}%` }}
          />
        </div>
        <span className={styles.progressLabel}>
          {proj.completedMissions || 0}/{proj.missionCount || 0} missions
        </span>
      </div>

      {/* Dependencies */}
      {proj.depends_on?.length > 0 && (
        <div className={styles.depChips}>
          {proj.depends_on.map((dep) => (
            <Link
              key={dep}
              href={`/p/${primeId}/projects?project=${dep}`}
              className={styles.depChip}
              onClick={(e) => e.stopPropagation()}
            >
              ⛓ {dep}
            </Link>
          ))}
        </div>
      )}

      {/* Participants */}
      {(proj.participants?.length ?? 0) > 0 && (
        <div className={styles.participants}>
          {proj.participants.slice(0, 4).map((name) => (
            <span key={name} className={styles.agentChip}>{name}</span>
          ))}
          {proj.participants.length > 4 && (
            <span className={styles.agentChipMore}>+{proj.participants.length - 4}</span>
          )}
        </div>
      )}

      {/* Context summary */}
      {contextSummary(proj) && (
        <div className={styles.contextSummary}>{contextSummary(proj)}</div>
      )}

      <div className={styles.cardDate}>
        Created {new Date(proj.created_at).toLocaleDateString()}
      </div>
    </button>
  );

  return (
    <>
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Projects</h1>
        <span className={styles.countPill}>{projects.length} total</span>
      </div>
      <div className={styles.pgSub}>
        Manage project context, track missions, and coordinate agents
      </div>

      {/* ---- Grid with hierarchy ---- */}
      <div className={styles.grid}>
        {topLevel.map((proj) => (
          <div key={proj.id} className={styles.childGroup}>
            {renderProjectCard(proj, false)}
            {childrenMap[proj.id]?.map((child) => renderProjectCard(child, true))}
          </div>
        ))}

        {/* ---- Create card ---- */}
        <button className={styles.createCard} onClick={() => setShowCreate(true)}>
          <span className={styles.createIcon}>+</span>
          <span className={styles.createLabel}>Create Project</span>
        </button>
      </div>

      {/* ---- Create modal ---- */}
      {showCreate && (
        <CreateProjectModal
          primeId={primeId}
          onClose={() => setShowCreate(false)}
          onCreated={(proj) => {
            setProjects((prev) => [proj, ...prev]);
            setShowCreate(false);
          }}
        />
      )}
    </>
  );
}

/* ================================================================
   Detail View
   ================================================================ */
function ProjectDetailView({
  primeId,
  projectId,
  router,
}: {
  primeId: string;
  projectId: string;
  router: ReturnType<typeof useRouter>;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editDesc, setEditDesc] = useState(false);
  const [desc, setDesc] = useState("");
  const [contextDirty, setContextDirty] = useState(false);
  const [localContext, setLocalContext] = useState<Record<string, ContextEntry>>({});
  const [saving, setSaving] = useState(false);

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
      const data = await api<{ project: ProjectDetail }>(`/api/primes/${primeId}/projects/${projectId}`);
      if (!cancelled && data?.project) {
        setProject(data.project);
        setDesc(data.project.description);
        setLocalContext(data.project.context ?? {});
        setLinkedProcessIds(data.project.standardProcesses ?? []);
        setLoading(false);
      } else if (!cancelled) {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId, projectId]);

  /* ---- Fetch all processes for linking ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await api<{ processes: ProcessSummary[] }>(`/api/primes/${primeId}/processes`);
      if (!cancelled && data?.processes) {
        setAllProcesses(data.processes);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId]);

  /* ---- Fetch pending promotions ---- */
  useEffect(() => {
    let cancelled = false;
    setPromotionsLoading(true);
    (async () => {
      const data = await api<{ promotions: PromotionEntry[] }>(
        `/api/primes/${primeId}/projects/${projectId}/promotions?status=pending`
      );
      if (!cancelled) {
        setPromotions(data?.promotions ?? []);
        setPromotionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId, projectId]);

  /* ---- Back nav ---- */
  const handleBack = useCallback(() => {
    router.push(`/p/${primeId}/projects`);
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
    await api(`/api/primes/${primeId}/projects/${projectId}/promotions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promotionId, action }),
    });
    setPromotions((prev) => prev.filter((p) => p.id !== promotionId));
  }, [primeId, projectId]);

  /* ---- Save ---- */
  const isDirty = contextDirty || processesDirty || editDesc;
  const handleSave = useCallback(async () => {
    setSaving(true);
    await api(`/api/primes/${primeId}/projects/${projectId}`, {
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
  }, [primeId, projectId, desc, localContext, linkedProcessIds]);

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
          <StatusBadge status={project.status} />
          {(project as any).owner && (
            <span className={styles.detailOwner}>{(project as any).owner}</span>
          )}
        </div>

        {/* Goal */}
        {(project as any).goal && (
          <div className={styles.detailGoal}>{(project as any).goal}</div>
        )}

        {/* Parent link */}
        {(project as any).parent_id && (
          <div style={{ marginBottom: 8 }}>
            <Link
              href={`/p/${primeId}/projects?project=${(project as any).parent_id}`}
              className={styles.detailParentLink}
            >
              ↑ Parent: {(project as any).parent_id}
            </Link>
          </div>
        )}

        {/* Depends on */}
        {(project as any).depends_on?.length > 0 && (
          <div className={styles.depSection}>
            <div className={styles.depSectionLabel}>Depends On</div>
            <div className={styles.depChips}>
              {(project as any).depends_on.map((dep: string) => (
                <Link
                  key={dep}
                  href={`/p/${primeId}/projects?project=${dep}`}
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

/* ================================================================
   Create Project Modal
   ================================================================ */
function CreateProjectModal({
  primeId,
  onClose,
  onCreated,
}: {
  primeId: string;
  onClose: () => void;
  onCreated: (proj: ProjectSummary) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState<Record<string, ContextEntry>>({});
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!id.trim() || !name.trim()) return;
    setCreating(true);
    const result = await api<{ project: ProjectSummary }>(`/api/primes/${primeId}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id.trim(), name: name.trim(), description, context }),
    });
    if (result?.project) {
      onCreated(result.project);
    }
    setCreating(false);
  }, [id, name, description, context, primeId, onCreated]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Create Project</h2>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>

        <div className={styles.modalBody}>
          <label className={styles.fieldLabel}>Project ID</label>
          <input
            className={styles.fieldInput}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. onboarding-v2"
          />

          <label className={styles.fieldLabel}>Name</label>
          <input
            className={styles.fieldInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
          />

          <label className={styles.fieldLabel}>Description</label>
          <textarea
            className={styles.fieldTextarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What is this project about?"
          />

          <label className={styles.fieldLabel}>Initial Context</label>
          <ContextEditor context={context} onChange={setContext} />
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.createBtn}
            onClick={handleCreate}
            disabled={!id.trim() || !name.trim() || creating}
          >
            {creating ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   Shared sub-components
   ================================================================ */
function StatusBadge({ status }: { status: ProjectSummary["status"] }) {
  const cls =
    status === "active" ? styles.badgeActive
    : status === "complete" || status === "completed" ? styles.badgeComplete
    : status === "paused" ? styles.badgePaused
    : styles.badgeArchived;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}

/* ---- Helpers ---- */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
