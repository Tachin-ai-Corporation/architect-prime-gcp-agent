"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import styles from "@/components/projects/ProjectsPage.module.css";
import { ProjectListView } from "@/components/projects/ProjectListView";
import { ProjectDetailView } from "@/components/projects/ProjectDetailView";

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
  const searchParams = useSearchParams();

  /* ---- URL params ---- */
  const paramProject = searchParams.get("project");
  const teamFilter = searchParams.get("team");

  /* ---- Render either list or detail ---- */
  return (
    <div className={styles.shell}>
      {paramProject ? (
        <ProjectDetailView
          projectId={paramProject}
        />
      ) : (
        <ProjectListView teamFilter={teamFilter} />
      )}
    </div>
  );
}
