"use client";

import { useState, useMemo, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { useProjects } from "@/hooks/useProjects";
import { useWorkEnvelopes } from "@/components/work/useWorkEnvelopes";
import { NavCard } from "@/components/NavCard";
import { AgentChip } from "@/components/AgentChip";
import { api } from "@/lib/api";
import type { Project, WorkEnvelope } from "@/lib/types";

export default function ProjectsPage() {
  const { id } = useParams<{ id: string }>();
  const { primes } = usePrime();
  const prime = primes.find((p) => p.id === id);
  const { projects, loading } = useProjects(id);
  const { envelopes } = useWorkEnvelopes(id);

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [creating, setCreating] = useState(false);

  /* ---- Computed: per-project stats ---- */
  const projectStats = useMemo(() => {
    const stats = new Map<
      string,
      { missions: number; done: number; total: number; agents: Set<string> }
    >();

    for (const proj of projects) {
      stats.set(proj.id, { missions: 0, done: 0, total: 0, agents: new Set() });
    }

    for (const env of envelopes) {
      if (!env.project_id) continue;
      const s = stats.get(env.project_id);
      if (!s) continue;

      if (env.type === "M") {
        s.missions++;
        s.agents.add(env.owner);
      }
      // Count all tasks (T + C types) for progress
      if (env.type === "T" || env.type === "C") {
        s.total++;
        if (env.status === "complete") s.done++;
      }
    }

    return stats;
  }, [projects, envelopes]);

  /* ---- Create project ---- */
  const handleCreate = useCallback(async () => {
    if (!createName.trim() || !id) return;
    setCreating(true);

    await api<{ project: Project }>(`/api/primes/${id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: createName.trim(),
        description: createDesc.trim(),
      }),
    });

    setShowCreate(false);
    setCreating(false);
    setCreateName("");
    setCreateDesc("");
  }, [id, createName, createDesc]);

  const activeProjects = projects.filter((p) => p.status === "active");

  return (
    <div className={styles.shell} id="projects-page">
      <div className={styles.container}>
        {/* ---- Header ---- */}
        <header className={styles.header}>
          <span className={styles.headerIcon}>📁</span>
          <div>
            <h1 className={styles.title}>Projects</h1>
            <div className={styles.subtitle}>
              {prime?.name} · {activeProjects.length} project
              {activeProjects.length !== 1 ? "s" : ""}
            </div>
          </div>
          <Link href={`/p/${id}`} className={styles.backBtn} id="projects-back-btn">
            ← Hub
          </Link>
        </header>

        {/* ---- Grid ---- */}
        {loading ? (
          <div className={styles.loading}>Loading projects…</div>
        ) : (
          <div className={styles.grid} id="projects-grid">
            {activeProjects.map((project) => {
              const s = projectStats.get(project.id);
              const progress =
                s && s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
              const agents = s ? Array.from(s.agents) : [];

              return (
                <Link
                  key={project.id}
                  href={`/p/${id}/projects/${project.id}`}
                  className={styles.projectCard}
                  id={`project-card-${project.id}`}
                >
                  <div className={styles.cardHeader}>
                    <span className={styles.cardIcon}>📋</span>
                    <div className={styles.cardMeta}>
                      <div className={styles.cardTitle}>{project.name}</div>
                      {project.description && (
                        <div className={styles.cardDesc}>
                          {project.description}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className={styles.cardStats}>
                    <span className={styles.cardStat}>
                      Missions:{" "}
                      <span className={styles.cardStatValue}>
                        {s?.missions ?? 0}
                      </span>
                    </span>
                    <span className={styles.cardStat}>
                      Progress:{" "}
                      <span className={styles.cardStatValue}>
                        {progress}%
                      </span>
                    </span>
                  </div>

                  <div className={styles.progressWrap}>
                    <div
                      className={styles.progressBar}
                      style={{ width: `${progress}%` }}
                    />
                  </div>

                  {agents.length > 0 && (
                    <div className={styles.agentRow}>
                      {agents.slice(0, 4).map((a) => (
                        <AgentChip key={a} name={a} working />
                      ))}
                      {agents.length > 4 && (
                        <span
                          style={{
                            fontSize: 11,
                            color: "#566373",
                            alignSelf: "center",
                          }}
                        >
                          +{agents.length - 4}
                        </span>
                      )}
                    </div>
                  )}
                </Link>
              );
            })}

            <NavCard
              id="create-project-card"
              icon="+"
              title="Create Project"
              description="Start a new project"
              variant="action"
              onClick={() => setShowCreate(true)}
            />
          </div>
        )}

        {activeProjects.length === 0 && !loading && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>📁</div>
            <div className={styles.emptyTitle}>No projects yet</div>
            <div>Create your first project to organize missions and track progress.</div>
          </div>
        )}
      </div>

      {/* ---- Create Modal ---- */}
      {showCreate && (
        <div
          className={styles.modalOverlay}
          onClick={() => setShowCreate(false)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>Create Project</div>
            <div className={styles.modalDesc}>
              Projects organize related missions and provide progress tracking
              across your fleet.
            </div>

            <div className={styles.modalField}>
              <label
                className={styles.modalLabel}
                htmlFor="create-project-name"
              >
                Project Name
              </label>
              <input
                id="create-project-name"
                className="input"
                placeholder="e.g. API v2 Migration"
                autoFocus
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
            </div>

            <div className={styles.modalField}>
              <label
                className={styles.modalLabel}
                htmlFor="create-project-desc"
              >
                Description
              </label>
              <textarea
                id="create-project-desc"
                className={styles.modalTextarea}
                placeholder="Brief description of the project goals…"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
              />
            </div>

            <div className={styles.modalActions}>
              <button
                className="btn btn-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button
                id="create-project-submit"
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={!createName.trim() || creating}
              >
                {creating ? "Creating…" : "Create Project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
