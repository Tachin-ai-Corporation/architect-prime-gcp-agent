"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { CreateProcessModal } from "./CreateProcessModal";
import type { ProcessSummary } from "./types";
import styles from "@/app/p/[id]/processes/page.module.css";
import { truncate } from "@/lib/format";

interface ProcessListViewProps {
  primeId: string;
  router: ReturnType<typeof useRouter>;
}

export function ProcessListView({ primeId, router }: ProcessListViewProps) {
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  /* ---- Fetch processes ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await api<{ processes: ProcessSummary[] }>(`/api/primes/${primeId}/processes`);
      if (!cancelled) {
        setProcesses(data?.processes ?? []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primeId]);

  const handleSelectProcess = useCallback(
    (processId: string) => {
      const params = new URLSearchParams();
      params.set("process", processId);
      router.push(`/p/${primeId}/processes?${params.toString()}`);
    },
    [primeId, router]
  );

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading processes…</span>
      </div>
    );
  }

  return (
    <>
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Processes</h1>
        <span className={styles.countPill}>{processes.length} total</span>
      </div>
      <div className={styles.pgSub}>
        Define repeatable workflows with ordered steps, parameters, and context templates
      </div>

      {/* ---- Grid ---- */}
      <div className={styles.grid}>
        {processes.map((proc) => (
          <button
            key={proc.id}
            className={styles.card}
            onClick={() => handleSelectProcess(proc.id)}
          >
            <div className={styles.cardHeader}>
              <span className={styles.cardName}>{proc.name}</span>
              <span
                className={`${styles.statusBadge} ${
                  proc.status === "active" ? styles.badgeActive : styles.badgeDeprecated
                }`}
              >
                {proc.status}
              </span>
            </div>
            <div className={styles.cardDesc}>{truncate(proc.description, 100)}</div>

            <div className={styles.cardMeta}>
              <span className={styles.versionBadge}>v{proc.version}</span>
              <span className={styles.cardMetaItem}>{proc.steps?.length ?? 0} steps</span>
              <span className={styles.cardMetaItem}>⚡ {proc.execution_count} runs</span>
              <span className={styles.cardMetaItem}>by {proc.created_by}</span>
            </div>
          </button>
        ))}

        {/* ---- Create card ---- */}
        <button className={styles.createCard} onClick={() => setShowCreate(true)}>
          <span className={styles.createIcon}>+</span>
          <span className={styles.createLabel}>Create Process</span>
        </button>
      </div>

      {/* ---- Create modal ---- */}
      {showCreate && (
        <CreateProcessModal
          primeId={primeId}
          onClose={() => setShowCreate(false)}
          onCreated={(proc) => {
            setProcesses((prev) => [proc, ...prev]);
            setShowCreate(false);
          }}
        />
      )}
    </>
  );
}
