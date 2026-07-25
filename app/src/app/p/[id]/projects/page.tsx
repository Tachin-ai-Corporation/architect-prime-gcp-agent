"use client";

import { Suspense, use } from "react";
import { useSearchParams } from "next/navigation";
import styles from "@/components/projects/ProjectsPage.module.css";
import { ProjectListView } from "@/components/projects/ProjectListView";
import { ProjectDetailView } from "@/components/projects/ProjectDetailView";

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
        />
      ) : (
        <ProjectListView primeId={primeId} />
      )}
    </div>
  );
}
