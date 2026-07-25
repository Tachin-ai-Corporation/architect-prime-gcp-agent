"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { CreateProjectModal } from "./CreateProjectModal";
import { ProjectStatusBadge } from "./ProjectStatusBadge";
import type { ProjectSummary } from "./types";
import styles from "@/components/projects/ProjectsPage.module.css";
import { truncate } from "@/lib/format";

interface ProjectListViewProps {
  primeId?: string;
  teamFilter?: string | null;
}

export function ProjectListView({ primeId, teamFilter }: ProjectListViewProps) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  /* ---- Fetch projects ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const filter = primeId || teamFilter;
      const url = filter ? `/api/projects?team=${encodeURIComponent(filter)}` : `/api/projects`;
      const data = await api<{ projects: ProjectSummary[] }>(url);
      if (!cancelled) {
        setProjects(data?.projects ?? []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId, teamFilter]);

  const handleSelectProject = useCallback(
    (projectId: string) => {
      if (primeId) {
        router.push(`/p/${primeId}/projects?project=${projectId}`);
      } else {
        router.push(`/projects?project=${projectId}`);
      }
    },
    [primeId, router]
  );

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
          <ProjectStatusBadge status={proj.status} />
        </div>
      </div>
      <div className={styles.cardDesc}>{truncate(proj.description, 100)}</div>
      {proj.goal && <div className={styles.goalText}>{truncate(proj.goal, 80)}</div>}

      {/* Parent link */}
      {proj.parent_id && (
        <Link
          href={primeId ? `/p/${primeId}/projects?project=${proj.parent_id}` : `/projects?project=${proj.parent_id}`}
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
              href={primeId ? `/p/${primeId}/projects?project=${dep}` : `/projects?project=${dep}`}
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
        {teamFilter && (
          <span className={styles.countPill} style={{ marginLeft: 4 }}>
            team: {teamFilter}
          </span>
        )}
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
