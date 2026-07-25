"use client";

import React from "react";
import styles from "@/app/page.module.css";
import { Modal } from "@/components/ui/Modal";

interface ConfirmDeleteModalProps {
  primeName: string;
  activeFleet: string[];
  canDelete: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmDeleteModal({
  primeName,
  activeFleet,
  canDelete,
  onClose,
  onConfirm,
}: ConfirmDeleteModalProps) {
  return (
    <Modal onClose={onClose} overlayClassName={styles.modalOverlay} className={styles.modal}>
        <div className={styles.deleteModalHeader}>
          <span className={styles.deleteModalIcon}>🗑</span>
          <span className={styles.modalTitle} style={{ marginBottom: 0 }}>
            Delete Prime
          </span>
        </div>
        <div className={styles.deleteModalPrime}>
          Prime: <strong>{primeName}</strong>
        </div>
        {!canDelete ? (
          <div className={styles.deleteBlockNotice}>
            <div className={styles.deleteBlockTitle}>⚠ Cannot delete — active fleet agents</div>
            <div className={styles.deleteBlockDesc}>
              All fleet agents must be fired before deleting this Prime.
            </div>
            <div className={styles.deleteBlockAgents}>
              {activeFleet.map((name) => (
                <span key={name} className={styles.deleteBlockAgent}>
                  {name}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.deleteWarning}>
            This will permanently delete the VM and stop all billing. The Prime can be re-deployed later.
          </div>
        )}
        <div className={styles.modalActions}>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {canDelete && (
            <button
              id="confirm-delete-prime"
              className={`btn ${styles.deleteConfirmBtn}`}
              onClick={onConfirm}
            >
              Delete Prime
            </button>
          )}
        </div>
    </Modal>
  );
}
