"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import styles from "./AgentItems.module.css";

/* ================================================================
   Types
   ================================================================ */

interface TeamMember {
  email: string;
  role: string;
  name: string;
  type: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  owner: string;
  status: "active" | "complete" | "completed" | "paused" | "archived";
  description: string;
  team?: (TeamMember | string)[];
  standardProcesses?: string[];
  created_at: string;
}

interface ProjectsResponse {
  projects: ProjectSummary[];
}

interface AgentProjectsProps {
  primeId: string;
  agentEmail: string;
}

/* ================================================================
   Helpers
   ================================================================ */

/** Check if agent email appears in the team array (handles string[] and object[] formats) */
function isAgentOnTeam(team: (TeamMember | string)[] | undefined, email: string): boolean {
  if (!team || team.length === 0) return false;
  return team.some((member) =>
    typeof member === "string"
      ? member === email
      : member.email === email,
  );
}

function getTeamCount(team: (TeamMember | string)[] | undefined): number {
  return team?.length ?? 0;
}

const STATUS_CLASS: Record<string, string> = {
  active: styles.statusActive,
  complete: styles.statusComplete,
  completed: styles.statusCompleted,
  paused: styles.statusPaused,
  archived: styles.statusArchived,
};

/* ================================================================
   Component
   ================================================================ */

export function AgentProjects({ primeId, agentEmail }: AgentProjectsProps) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "mine">("all");

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api<ProjectsResponse>("/api/projects");
    if (!res) {
      setError("Failed to load projects");
      setLoading(false);
      return;
    }
    setProjects(res.projects ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  /* ---- Sorted + filtered list ---- */
  const displayed = useMemo(() => {
    const sorted = [...projects].sort((a, b) => {
      const aAssigned = isAgentOnTeam(a.team, agentEmail) ? 0 : 1;
      const bAssigned = isAgentOnTeam(b.team, agentEmail) ? 0 : 1;
      return aAssigned - bAssigned;
    });

    if (filter === "mine") {
      return sorted.filter((p) => isAgentOnTeam(p.team, agentEmail));
    }
    return sorted;
  }, [projects, agentEmail, filter]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.loadingState}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>Loading projects…</span>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.errorState}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        <button className={styles.retryBtn} onClick={fetchProjects}>
          Retry
        </button>
      </div>
    );
  }

  /* ---- Empty ---- */
  if (projects.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>📁</div>
        No projects found
      </div>
    );
  }

  /* ---- Grid ---- */
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
          My Projects
        </button>
      </div>

      {displayed.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>📁</div>
          No assigned projects
        </div>
      ) : (
        <div className={styles.itemGrid}>
          {displayed.map((project) => {
            const assigned = isAgentOnTeam(project.team, agentEmail);
            return (
              <div
                key={project.id}
                className={`${styles.itemCard} ${
                  assigned ? styles.itemCardHighlighted : styles.itemCardDimmed
                }`}
                onClick={() =>
                  router.push(`/p/${primeId}/projects?project=${project.id}`)
                }
              >
                {/* Header */}
                <div className={styles.cardHeader}>
                  <span className={styles.cardTitle}>{project.name}</span>
                  <div className={styles.badges}>
                    {assigned && (
                      <span className={styles.assignedBadge}>Assigned</span>
                    )}
                    <span
                      className={`${styles.statusBadge} ${STATUS_CLASS[project.status] ?? ""}`}
                    >
                      {project.status}
                    </span>
                  </div>
                </div>

                {/* Goal */}
                {project.goal && (
                  <div className={styles.cardGoal}>{project.goal}</div>
                )}

                {/* Meta */}
                <div className={styles.cardMeta}>
                  <span className={styles.metaItem}>
                    👥 {getTeamCount(project.team)} member
                    {getTeamCount(project.team) !== 1 ? "s" : ""}
                  </span>
                  {project.owner && (
                    <span className={styles.metaItem}>
                      Owner: {project.owner}
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
