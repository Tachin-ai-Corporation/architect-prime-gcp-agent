"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { ProcessDetail } from "./types";
import styles from "@/app/p/[id]/processes/page.module.css";

interface ProcessDetailViewProps {
  primeId: string;
  processId: string;
  router: ReturnType<typeof useRouter>;
}

export function ProcessDetailView({ primeId, processId, router }: ProcessDetailViewProps) {
  const [process, setProcess] = useState<ProcessDetail | null>(null);
  const [loading, setLoading] = useState(true);

  /* ---- Editing state ---- */
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editNarrative, setEditNarrative] = useState("");
  const [editIntentKeywords, setEditIntentKeywords] = useState("");
  const [saving, setSaving] = useState(false);

  /* ---- Fetch process ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Inside the IIFE, not the effect body: still the same tick (nothing is
      // awaited before it), so the loader appears exactly as it did.
      setLoading(true);
      const data = await api<{ process: ProcessDetail }>(`/api/primes/${primeId}/processes/${processId}`);
      if (!cancelled && data?.process) {
        setProcess(data.process);
        setLoading(false);
      } else if (!cancelled) {
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primeId, processId]);

  /* ---- Enter edit mode ---- */
  const startEditing = useCallback(() => {
    if (!process) return;
    setEditName(process.name);
    setEditDesc(process.description);
    setEditNarrative(process.narrative || "");
    setEditIntentKeywords((process.intent_keywords || []).join(", "));
    setIsEditing(true);
  }, [process]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
  }, []);

  /* ---- Save changes ---- */
  const handleSave = useCallback(async () => {
    if (!process) return;
    setSaving(true);

    const result = await api<{ process: ProcessDetail }>(`/api/primes/${primeId}/processes/${processId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName.trim(),
        description: editDesc.trim(),
        narrative: editNarrative.trim(),
        intent_keywords: editIntentKeywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      }),
    });

    if (result?.process) {
      setProcess(result.process);
    }
    setIsEditing(false);
    setSaving(false);
  }, [process, editName, editDesc, editNarrative, editIntentKeywords, primeId, processId]);

  /* ---- Deprecate ---- */
  const handleDeprecate = useCallback(async () => {
    if (!process) return;
    setSaving(true);
    const result = await api<{ process: ProcessDetail }>(`/api/primes/${primeId}/processes/${processId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "deprecated" }),
    });
    if (result?.process) {
      setProcess(result.process);
    }
    setSaving(false);
  }, [process, primeId, processId]);

  /* ---- Back nav ---- */
  const handleBack = useCallback(() => {
    router.push(`/p/${primeId}/processes`);
  }, [primeId, router]);

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading process…</span>
      </div>
    );
  }

  if (!process) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>⚠</div>
        <div className={styles.emptyTitle}>Process not found</div>
        <button className={styles.backBtn} onClick={handleBack}>
          ← Back to processes
        </button>
      </div>
    );
  }

  return (
    <>
      {/* ---- Header ---- */}
      <button className={styles.backBtn} onClick={handleBack}>
        ← Back to processes
      </button>

      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          {isEditing ? (
            <input
              className={`${styles.fieldInput} ${styles.editTitleInput}`}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Process name"
            />
          ) : (
            <h1 className={styles.pgTitle}>{process.name}</h1>
          )}
          <span className={styles.versionBadge}>v{process.version}</span>
          <span
            className={`${styles.statusBadge} ${
              process.status === "active" ? styles.badgeActive : styles.badgeDeprecated
            }`}
          >
            {process.status}
          </span>
          {!isEditing && process.status === "active" && (
            <button className={styles.editBtn} onClick={startEditing} title="Edit process">
              ✏️
            </button>
          )}
        </div>

        {isEditing ? (
          <>
            <textarea
              className={`${styles.fieldTextarea} ${styles.editDescTextarea}`}
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={2}
              placeholder="One line: what kind of work is this?"
            />
            <div style={{ marginTop: 12, marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, color: "var(--mist)", marginBottom: 4 }}>
                Intent Keywords (comma-separated, matches user prompt to auto-route this process)
              </label>
              <input
                type="text"
                className={styles.fieldInput}
                value={editIntentKeywords}
                onChange={(e) => setEditIntentKeywords(e.target.value)}
                placeholder="e.g. build, compile, deploy, snapshot"
              />
            </div>
          </>
        ) : (
          <>
            <div className={styles.detailDesc}>{process.description}</div>
            {process.intent_keywords && process.intent_keywords.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  marginBottom: 16,
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--mist)" }}>Intent keywords:</span>
                {process.intent_keywords.map((k) => (
                  <span key={k} className={styles.versionBadge}>
                    {k}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {(process.updated_by || process.updated_at) && !isEditing && (
          <div className={styles.detailMetaRow}>
            {process.updated_by && (
              <span className={styles.detailMetaItem}>👤 {process.updated_by}</span>
            )}
            {process.updated_at && (
              <span className={styles.detailMetaItem}>
                📅 {new Date(process.updated_at).toLocaleDateString()}
              </span>
            )}
          </div>
        )}

        {/* ---- Action buttons ---- */}
        {isEditing && (
          <div className={styles.editActions}>
            <button className={styles.cancelBtn} onClick={cancelEditing}>
              Cancel
            </button>
            <button
              className={styles.deprecateBtn}
              onClick={handleDeprecate}
              disabled={saving || process.status === "deprecated"}
            >
              Deprecate
            </button>
            <button
              className={styles.createBtn}
              onClick={handleSave}
              disabled={saving || !editName.trim() || !editNarrative.trim()}
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        )}
      </div>

      {/* ---- Narrative ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Narrative</h2>
        </div>

        {isEditing ? (
          <textarea
            className={styles.fieldTextarea}
            value={editNarrative}
            onChange={(e) => setEditNarrative(e.target.value)}
            rows={12}
            placeholder="How we've done this kind of work well before — the approach, in prose."
          />
        ) : process.narrative ? (
          <div className={styles.narrative}>{process.narrative}</div>
        ) : (
          <div className={styles.emptySection}>No narrative yet.</div>
        )}
      </div>
    </>
  );
}
