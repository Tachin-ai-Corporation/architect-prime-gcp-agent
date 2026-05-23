"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { AgentChip } from "@/components/AgentChip";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";
import type { Project, WorkEnvelope } from "@/lib/types";

interface ProjectDetailResponse {
  project: Project;
  missions: WorkEnvelope[];
}

export default function ProjectDetailPage() {
  const { id, proj } = useParams<{ id: string; proj: string }>();
  const router = useRouter();
  const { primes } = usePrime();
  const prime = primes.find((p) => p.id === id);
  const { confirm, toast } = useDialog();

  const [project, setProject] = useState<Project | null>(null);
  const [missions, setMissions] = useState<WorkEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [saving, setSaving] = useState(false);

  /* ---- Load project ---- */
  const loadProject = useCallback(async () => {
    if (!id || !proj) return;
    const data = await api<ProjectDetailResponse>(
      `/api/primes/${id}/projects/${proj}`
    );
    if (data) {
      setProject(data.project);
      setMissions(data.missions || []);
    }
    setLoading(false);
  }, [id, proj]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  /* ---- Refresh on interval ---- */
  useEffect(() => {
    const interval = setInterval(loadProject, 8000);
    return () => clearInterval(interval);
  }, [loadProject]);

  /* ---- Progress calculation ---- */
  const { progress, agents, missionStats } = useMemo(() => {
    const agentSet = new Set<string>();
    let done = 0;
    let total = 0;

    const mStats = new Map<
      string,
      { done: number; total: number }
    >();

    for (const m of missions) {
      agentSet.add(m.owner);
      mStats.set(m.id, { done: 0, total: 0 });
    }

    // We count missions themselves for progress (since we don't have child tasks in this response)
    for (const m of missions) {
      total++;
      if (m.status === "complete") done++;
    }

    return {
      progress: total > 0 ? Math.round((done / total) * 100) : 0,
      agents: Array.from(agentSet),
      missionStats: mStats,
    };
  }, [missions]);

  /* ---- Edit project ---- */
  const openEdit = useCallback(() => {
    if (!project) return;
    setEditName(project.name);
    setEditDesc(project.description || "");
    setShowEdit(true);
  }, [project]);

  const handleSave = useCallback(async () => {
    if (!id || !proj || !editName.trim()) return;
    setSaving(true);

    const data = await api<{ project: Project }>(
      `/api/primes/${id}/projects/${proj}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDesc.trim(),
        }),
      }
    );

    if (data?.project) {
      setProject(data.project);
      toast({ message: "Project updated", variant: "success" });
    }
    setSaving(false);
    setShowEdit(false);
  }, [id, proj, editName, editDesc, toast]);

  /* ---- Archive project ---- */
  const handleArchive = useCallback(async () => {
    const confirmed = await confirm({
      title: "Archive Project",
      message: "Archive this project? It won't be deleted but will be hidden from the active list.",
      variant: "danger",
      confirmText: "Archive",
    });
    if (!confirmed || !id || !proj) return;

    await api(`/api/primes/${id}/projects/${proj}`, {
      method: "DELETE",
    });

    toast({ message: "Project archived", variant: "info" });
    router.push(`/p/${id}/projects`);
  }, [id, proj, confirm, toast, router]);

  /* ---- Mission status icon ---- */
  const getMissionIcon = (status: string) => {
    switch (status) {
      case "complete":
        return <span className={styles.missionIcon} style={{ color: "#5FC7B2" }}>✓</span>;
      case "active":
        return <span className={styles.missionIcon} style={{ color: "#8FD8E6" }}>●</span>;
      case "pending":
      case "waiting":
        return <span className={styles.missionIcon} style={{ color: "#566373" }}>○</span>;
      case "needs_input":
      case "blocked":
        return <span className={styles.missionIcon} style={{ color: "#D6A83A" }}>⚡</span>;
      case "failed":
        return <span className={styles.missionIcon} style={{ color: "#D84F45" }}>✕</span>;
      default:
        return <span className={styles.missionIcon} style={{ color: "#566373" }}>○</span>;
    }
  };

  /* ---- Render ---- */
  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading project…</div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.notFound}>
            <div className={styles.notFoundIcon}>🔍</div>
            <div className={styles.notFoundTitle}>Project Not Found</div>
            <div className={styles.notFoundDesc}>
              No project with ID &ldquo;{proj}&rdquo; was found.
            </div>
            <Link href={`/p/${id}/projects`} className="btn btn-primary">
              ← Back to Projects
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="project-detail-page">
      <div className={styles.container}>
        {/* ---- Header ---- */}
        <header className={styles.header}>
          <span className={styles.headerIcon}>📋</span>
          <div className={styles.headerMeta}>
            <h1 className={styles.title}>{project.name}</h1>
            <div className={styles.subtitle}>
              {prime?.name} · {missions.length} mission
              {missions.length !== 1 ? "s" : ""}
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.editBtn}
              onClick={openEdit}
              id="project-edit-btn"
            >
              ✏ Edit
            </button>
            <button
              className={styles.archiveBtn}
              onClick={handleArchive}
              id="project-archive-btn"
            >
              🗃 Archive
            </button>
            <Link
              href={`/p/${id}/projects`}
              className={styles.backBtn}
              id="project-detail-back-btn"
            >
              ← Projects
            </Link>
          </div>
        </header>

        {/* ---- Progress Strip ---- */}
        <div className={styles.progressStrip} id="project-progress-strip">
          <span className={styles.progressLabel}>Progress</span>
          <div className={styles.progressWrap}>
            <div
              className={styles.progressBar}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className={styles.progressPct}>{progress}%</span>
          {agents.length > 0 && (
            <div className={styles.agentRow}>
              {agents.map((a) => (
                <AgentChip key={a} name={a} working />
              ))}
            </div>
          )}
        </div>

        {/* ---- Description ---- */}
        <section className={styles.descSection} id="project-description">
          <div className={styles.descTitle}>Description</div>
          {project.description ? (
            <div className={styles.descText}>{project.description}</div>
          ) : (
            <div className={styles.descEmpty}>No description provided</div>
          )}
        </section>

        {/* ---- Missions ---- */}
        <section className={styles.missionsSection} id="project-missions">
          <div className={styles.sectionTitle}>
            Missions ({missions.length})
          </div>

          {missions.length > 0 ? (
            <div className={styles.missionList}>
              {missions.map((m) => (
                <Link
                  key={m.id}
                  href={`/p/${id}/work`}
                  className={styles.missionRow}
                  id={`mission-row-${m.id}`}
                >
                  {getMissionIcon(m.status)}
                  <div className={styles.missionContent}>
                    <div className={styles.missionInstruction}>
                      {m.instruction || m.intent || m.id}
                    </div>
                    <div className={styles.missionStatus}>{m.status}</div>
                  </div>
                  <div className={styles.missionAgent}>
                    <AgentChip name={m.owner} status={m.status} />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className={styles.emptyMissions}>
              No missions linked to this project yet. Missions will appear here
              when fleet agents create them with this project&apos;s ID.
            </div>
          )}
        </section>
      </div>

      {/* ---- Edit Modal ---- */}
      {showEdit && (
        <div
          className={styles.editOverlay}
          onClick={() => setShowEdit(false)}
        >
          <div
            className={styles.editModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.editTitle}>Edit Project</div>

            <div className={styles.editField}>
              <label className={styles.editLabel} htmlFor="edit-project-name">
                Name
              </label>
              <input
                id="edit-project-name"
                className="input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
              />
            </div>

            <div className={styles.editField}>
              <label className={styles.editLabel} htmlFor="edit-project-desc">
                Description
              </label>
              <textarea
                id="edit-project-desc"
                className={styles.editTextarea}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
              />
            </div>

            <div className={styles.editActions}>
              <button
                className="btn btn-ghost"
                onClick={() => setShowEdit(false)}
              >
                Cancel
              </button>
              <button
                id="edit-project-submit"
                className="btn btn-primary"
                onClick={handleSave}
                disabled={!editName.trim() || saving}
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
