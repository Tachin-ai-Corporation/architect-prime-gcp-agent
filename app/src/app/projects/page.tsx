"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import { ContextEditor } from "@/components/projects/ContextEditor";
import type { ContextEntry } from "@/components/projects/ContextEditor";

/* ---- Types ---- */
interface ProjectSummary {
  id: string;
  name: string;
  status: "active" | "completed" | "archived";
  description: string;
  missionCount: number;
  completedMissions: number;
  participants: string[];
  created_at: string;
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
export default function ProjectsPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <ProjectsPage />
    </Suspense>
  );
}

/* ---- Main page ---- */
function ProjectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { primes } = usePrime();

  /* ---- URL params ---- */
  const paramPrime = searchParams.get("prime");
  const paramProject = searchParams.get("project");

  const selectedPrimeId = paramPrime && primes.find((p) => p.id === paramPrime)
    ? paramPrime
    : primes[0]?.id || null;

  /* ---- Render either list or detail ---- */
  return (
    <div className={styles.shell}>
      {paramProject && selectedPrimeId ? (
        <ProjectDetailView
          primeId={selectedPrimeId}
          projectId={paramProject}
          router={router}
        />
      ) : selectedPrimeId ? (
        <ProjectListView primeId={selectedPrimeId} router={router} />
      ) : (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◎</div>
          <div className={styles.emptyTitle}>No primes configured</div>
          <div className={styles.emptySub}>Set up a prime instance to get started</div>
        </div>
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
      params.set("prime", primeId);
      params.set("project", projectId);
      router.push(`/projects?${params.toString()}`);
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

  return (
    <>
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Projects</h1>
        <span className={styles.countPill}>{projects.length} total</span>
      </div>
      <div className={styles.pgSub}>
        Manage project context, track missions, and coordinate agents
      </div>

      {/* ---- Grid ---- */}
      <div className={styles.grid}>
        {projects.map((proj) => (
          <button
            key={proj.id}
            className={styles.card}
            onClick={() => handleSelectProject(proj.id)}
          >
            <div className={styles.cardHeader}>
              <span className={styles.cardName}>{proj.name}</span>
              <StatusBadge status={proj.status} />
            </div>
            <div className={styles.cardDesc}>{truncate(proj.description, 100)}</div>

            {/* Progress */}
            <div className={styles.progressWrap}>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${proj.missionCount > 0 ? (proj.completedMissions / proj.missionCount) * 100 : 0}%` }}
                />
              </div>
              <span className={styles.progressLabel}>
                {proj.completedMissions}/{proj.missionCount} missions
              </span>
            </div>

            {/* Participants */}
            {proj.participants.length > 0 && (
              <div className={styles.participants}>
                {proj.participants.slice(0, 4).map((name) => (
                  <span key={name} className={styles.agentChip}>{name}</span>
                ))}
                {proj.participants.length > 4 && (
                  <span className={styles.agentChipMore}>+{proj.participants.length - 4}</span>
                )}
              </div>
            )}

            <div className={styles.cardDate}>
              Created {new Date(proj.created_at).toLocaleDateString()}
            </div>
          </button>
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
    const params = new URLSearchParams();
    params.set("prime", primeId);
    router.push(`/projects?${params.toString()}`);
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

  const progress = project.missionCount > 0
    ? (project.completedMissions / project.missionCount) * 100
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
        </div>

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
            {project.completedMissions}/{project.missionCount} missions completed
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
    : status === "completed" ? styles.badgeCompleted
    : styles.badgeArchived;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}

/* ---- Helpers ---- */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
