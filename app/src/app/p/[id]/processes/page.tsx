"use client";

import { Suspense, use } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { ProcessListView } from "@/components/processes/ProcessListView";
import { ProcessDetailView } from "@/components/processes/ProcessDetailView";

/* ---- Wrapper with Suspense ---- */
export default function ProcessesPageWrapper({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <ProcessesPage params={params} />
    </Suspense>
  );
}

/* ---- Main page ---- */
function ProcessesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  /* ---- URL params (page-specific) ---- */
  const paramProcess = searchParams.get("process");

  /* ---- Render ---- */
  return (
    <div className={styles.shell}>
      {paramProcess ? (
        <ProcessDetailView
          primeId={id}
          processId={paramProcess}
          router={router}
        />
      ) : (
        <ProcessListView primeId={id} router={router} />
      )}
    </div>
  );
}
