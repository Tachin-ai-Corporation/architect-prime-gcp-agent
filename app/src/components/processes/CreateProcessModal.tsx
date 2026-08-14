"use client";

import React, { useState, useCallback } from "react";
import { api } from "@/lib/api";
import type { ProcessSummary } from "./types";
import styles from "@/app/p/[id]/processes/page.module.css";
import { Modal } from "@/components/ui/Modal";

interface CreateProcessModalProps {
  primeId: string;
  onClose: () => void;
  onCreated: (proc: ProcessSummary) => void;
}

export function CreateProcessModal({ primeId, onClose, onCreated }: CreateProcessModalProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [narrative, setNarrative] = useState("");
  const [intentKeywords, setIntentKeywords] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!id.trim() || !name.trim() || !narrative.trim()) return;
    setCreating(true);

    const result = await api<{ process: ProcessSummary }>(`/api/primes/${primeId}/processes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: id.trim(),
        name: name.trim(),
        description: description.trim(),
        narrative: narrative.trim(),
        intent_keywords: intentKeywords.split(",").map((k) => k.trim()).filter(Boolean),
      }),
    });
    if (result?.process) {
      onCreated(result.process);
      onClose();
    }
    setCreating(false);
  }, [id, name, description, narrative, intentKeywords, primeId, onCreated, onClose]);

  return (
    <Modal onClose={onClose} overlayClassName={styles.overlay} className={styles.modal}>
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
            placeholder="e.g. ship-a-website"
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
            rows={2}
            placeholder="One line: what kind of work is this?"
          />

          <label className={styles.fieldLabel}>Narrative</label>
          <textarea
            className={styles.fieldTextarea}
            value={narrative}
            onChange={(e) => setNarrative(e.target.value)}
            rows={8}
            placeholder="How we've done this kind of work well before — the approach, in prose."
          />

          <label className={styles.fieldLabel}>Intent Keywords (comma-separated)</label>
          <input
            className={styles.fieldInput}
            value={intentKeywords}
            onChange={(e) => setIntentKeywords(e.target.value)}
            placeholder="e.g. deploy, build, compile, snapshot"
          />
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.createBtn}
            onClick={handleCreate}
            disabled={!id.trim() || !name.trim() || !narrative.trim() || creating}
          >
            {creating ? "Creating…" : "Create Process"}
          </button>
        </div>
    </Modal>
  );
}
