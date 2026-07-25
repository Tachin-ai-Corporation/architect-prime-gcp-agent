"use client";

import { useState, useCallback } from "react";
import { api } from "@/lib/api";
import { ContextEditor } from "./ContextEditor";
import type { ContextEntry } from "./ContextEditor";
import type { ProjectSummary } from "./types";
import styles from "@/components/projects/ProjectsPage.module.css";
import { Modal } from "@/components/ui/Modal";

interface CreateProjectModalProps {
  primeId?: string;
  onClose: () => void;
  onCreated: (proj: ProjectSummary) => void;
}

export function CreateProjectModal({
  primeId,
  onClose,
  onCreated,
}: CreateProjectModalProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState<Record<string, ContextEntry>>({});
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!id.trim() || !name.trim()) return;
    setCreating(true);
    const result = await api<{ project: ProjectSummary }>(`/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id.trim(), name: name.trim(), description, context }),
    });
    if (result?.project) {
      onCreated(result.project);
    }
    setCreating(false);
  }, [id, name, description, context, onCreated]);

  return (
    <Modal onClose={onClose} overlayClassName={styles.overlay} className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Create Project</h2>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>

        <div className={styles.modalBody}>
          <label className={styles.fieldLabel}>Project ID</label>
          <input
            className={styles.fieldInput}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. onboarding-v2"
          />

          <label className={styles.fieldLabel}>Name</label>
          <input
            className={styles.fieldInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
          />

          <label className={styles.fieldLabel}>Description</label>
          <textarea
            className={styles.fieldTextarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What is this project about?"
          />

          <label className={styles.fieldLabel}>Initial Context</label>
          <ContextEditor context={context} onChange={setContext} />
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.createBtn}
            onClick={handleCreate}
            disabled={!id.trim() || !name.trim() || creating}
          >
            {creating ? "Creating…" : "Create Project"}
          </button>
        </div>
    </Modal>
  );
}
