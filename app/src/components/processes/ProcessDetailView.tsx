"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { StepEditor } from "./StepEditor";
import { ParamEditor } from "./ParamEditor";
import { ContextEditor } from "@/components/projects/ContextEditor";
import type { ProcessDetail, StepDef, ParamDef } from "./types";
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
  const [editIntentKeywords, setEditIntentKeywords] = useState("");
  const [editSteps, setEditSteps] = useState<StepDef[]>([]);
  const [editParams, setEditParams] = useState<ParamDef[]>([]);
  const [saving, setSaving] = useState(false);

  /* ---- Fetch process ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
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
    setEditIntentKeywords((process.intent_keywords || []).join(", "));
    setEditSteps(process.steps.map((s) => ({ ...s })));
    // Convert parameters record to array
    const paramArr: ParamDef[] = Object.entries(process.parameters || {}).map(([key, param]) => ({
      key,
      type: (param as ParamDef).type,
      default: (param as ParamDef).default,
      description: (param as ParamDef).description,
    }));
    setEditParams(paramArr);
    setIsEditing(true);
  }, [process]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
  }, []);

  /* ---- Save changes ---- */
  const handleSave = useCallback(async () => {
    if (!process) return;
    setSaving(true);

    const parametersObj: Record<string, Omit<ParamDef, "key">> = {};
    editParams.forEach((p) => {
      if (p.key.trim()) {
        parametersObj[p.key.trim()] = {
          type: p.type,
          default: p.default,
          description: p.description,
        };
      }
    });

    const result = await api<{ process: ProcessDetail }>(`/api/primes/${primeId}/processes/${processId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName.trim(),
        description: editDesc,
        intent_keywords: editIntentKeywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        steps: editSteps,
        parameters: parametersObj,
      }),
    });

    if (result?.process) {
      setProcess(result.process);
    }
    setIsEditing(false);
    setSaving(false);
  }, [process, editName, editDesc, editIntentKeywords, editSteps, editParams, primeId, processId]);

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

  const contextEntries = Object.entries(process.contextTemplate || {});
  const changelog = process.changelog || [];

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
              rows={3}
              placeholder="Process description"
            />
            <div style={{ marginTop: 12, marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, color: "#AEB8C4", marginBottom: 4 }}>
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
                <span style={{ fontSize: 12, color: "#AEB8C4" }}>Intent keywords:</span>
                {process.intent_keywords.map((k) => (
                  <span
                    key={k}
                    style={{
                      background: "#2A3644",
                      color: "#AEB8C4",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <div className={styles.detailMetaRow}>
          <span className={styles.detailMetaItem}>⚡ {process.execution_count} executions</span>
          <span className={styles.detailMetaItem}>👤 {process.created_by}</span>
          <span className={styles.detailMetaItem}>📅 {new Date(process.created_at).toLocaleDateString()}</span>
          {process.visibility && <span className={styles.detailMetaItem}>👁 {process.visibility}</span>}
        </div>

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
              disabled={saving || !editName.trim() || editSteps.length === 0}
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        )}
      </div>

      {/* ---- Steps ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Steps</h2>
          <span className={styles.countPill}>
            {isEditing ? editSteps.length : process.steps.length} steps
          </span>
        </div>

        <StepEditor
          isEditing={isEditing}
          steps={isEditing ? editSteps : process.steps}
          onChange={isEditing ? setEditSteps : undefined}
        />
      </div>

      {/* ---- Parameters ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Parameters</h2>
        </div>

        <ParamEditor
          isEditing={isEditing}
          parameters={
            isEditing
              ? editParams
              : Object.entries(process.parameters || {}).map(([key, param]) => ({
                  key,
                  type: param.type,
                  default: param.default,
                  description: param.description,
                }))
          }
          onChange={isEditing ? setEditParams : undefined}
        />
      </div>

      {/* ---- Context Template ---- */}
      {contextEntries.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Context Template</h2>
          </div>
          <ContextEditor context={process.contextTemplate} onChange={() => {}} readOnly />
        </div>
      )}

      {/* ---- Changelog ---- */}
      {changelog.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Changelog</h2>
          </div>
          <div className={styles.changelog}>
            {[...changelog].reverse().map((entry, i) => (
              <div key={i} className={styles.changelogItem}>
                <div>
                  <span className={styles.changelogVersion}>v{entry.version}</span>
                  <span className={styles.changelogTime}>
                    {new Date(entry.timestamp).toLocaleDateString()}{" "}
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className={styles.changelogSummary}>{entry.summary}</div>
                <div className={styles.changelogAuthor}>by {entry.author}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
