"use client";

import React from "react";
import styles from "@/app/page.module.css";
import { Modal } from "@/components/ui/Modal";

interface ActionRequiredModalProps {
  agentName: string;
  action: {
    title: string;
    instructions: string[];
  };
  onClose: () => void;
  onConfirm: () => void;
}

export function ActionRequiredModal({
  agentName,
  action,
  onClose,
  onConfirm,
}: ActionRequiredModalProps) {
  return (
    <Modal onClose={onClose} overlayClassName={styles.modalOverlay} className={styles.modal}>
        <div className={styles.actionModalHeader}>
          <span className={styles.actionModalIcon}>⚠</span>
          <span className={styles.modalTitle} style={{ marginBottom: 0 }}>
            {action.title}
          </span>
        </div>
        <div className={styles.actionModalAgent}>
          Agent: <strong>{agentName}</strong>
        </div>
        <ol className={styles.actionModalSteps}>
          {action.instructions.map((inst, idx) => (
            <li key={idx}>{inst}</li>
          ))}
        </ol>
        <div className={styles.modalActions}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            ✓ Done — I completed these steps
          </button>
        </div>
    </Modal>
  );
}
