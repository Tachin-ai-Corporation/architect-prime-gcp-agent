"use client";

import React, { useState, useCallback } from "react";
import { api } from "@/lib/api";
import { StepEditor } from "./StepEditor";
import { ParamEditor } from "./ParamEditor";
import type { ProcessSummary, StepDef, ParamDef } from "./types";
import styles from "@/app/p/[id]/processes/page.module.css";

const BLANK_STEP: StepDef = {
  title: "",
  description: "",
  agent: "",
  type: "standard",
  optional: false,
  checkpointBoundary: false,
};

interface CreateProcessModalProps {
  primeId: string;
  onClose: () => void;
  onCreated: (proc: ProcessSummary) => void;
}

export function CreateProcessModal({ primeId, onClose, onCreated }: CreateProcessModalProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [intentKeywords, setIntentKeywords] = useState("");
  const [steps, setSteps] = useState<StepDef[]>([{ ...BLANK_STEP }]);
  const [params, setParams] = useState<ParamDef[]>([]);
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!id.trim() || !name.trim() || steps.length === 0) return;
    setCreating(true);

    // Build parameters object
    const parametersObj: Record<string, Omit<ParamDef, "key">> = {};
    params.forEach((p) => {
      if (p.key.trim()) {
        parametersObj[p.key.trim()] = {
          type: p.type,
          default: p.default,
          description: p.description,
        };
      }
    });

    const result = await api<{ process: ProcessSummary }>(`/api/primes/${primeId}/processes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: id.trim(),
        name: name.trim(),
        description,
        intent_keywords: intentKeywords.split(",").map((k) => k.trim()).filter(Boolean),
        steps,
        parameters: Object.keys(parametersObj).length > 0 ? parametersObj : undefined,
      }),
    });
    if (result?.process) {
      onCreated(result.process);
      onClose();
    }
    setCreating(false);
  }, [id, name, description, intentKeywords, steps, params, primeId, onCreated, onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Create Process</h2>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>

        <div className={styles.modalBody}>
          <label className={styles.fieldLabel}>Process ID</label>
          <input
            className={styles.fieldInput}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. deploy-agent-v2"
          />

          <label className={styles.fieldLabel}>Name</label>
          <input
            className={styles.fieldInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Process name"
          />

          <label className={styles.fieldLabel}>Description</label>
          <textarea
            className={styles.fieldTextarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What does this process do?"
          />

          <label className={styles.fieldLabel}>Intent Keywords (comma-separated)</label>
          <input
            className={styles.fieldInput}
            value={intentKeywords}
            onChange={(e) => setIntentKeywords(e.target.value)}
            placeholder="e.g. deploy, build, compile, snapshot"
          />

          {/* ---- Step Builder ---- */}
          <label className={styles.fieldLabel}>Steps</label>
          <StepEditor
            isEditing={true}
            steps={steps}
            onChange={setSteps}
          />

          {/* ---- Parameter Builder ---- */}
          <label className={styles.fieldLabel}>Parameters (Optional)</label>
          <ParamEditor
            isEditing={true}
            parameters={params}
            onChange={setParams}
          />
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.createBtn}
            onClick={handleCreate}
            disabled={!id.trim() || !name.trim() || steps.length === 0 || !steps[0].title.trim() || creating}
          >
            {creating ? "Creating…" : "Create Process"}
          </button>
        </div>
      </div>
    </div>
  );
}
