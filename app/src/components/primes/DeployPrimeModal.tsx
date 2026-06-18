"use client";

import React, { useState } from "react";
import styles from "@/app/page.module.css";

const DEFAULT_ZONE = process.env.NEXT_PUBLIC_DEFAULT_ZONE || "us-central1-a";
const ZONES = Array.from(
  new Set([DEFAULT_ZONE, "us-central1-a", "us-east1-b", "us-west1-a", "europe-west1-b", "us-east5-a"])
);

interface DeployPrimeModalProps {
  onClose: () => void;
  onDeploy: (name: string, zone: string) => Promise<void> | void;
  deploying: boolean;
}

export function DeployPrimeModal({ onClose, onDeploy, deploying }: DeployPrimeModalProps) {
  const [newPrimeName, setNewPrimeName] = useState("");
  const [newPrimeZone, setNewPrimeZone] = useState(DEFAULT_ZONE);

  const handleDeploy = () => {
    if (!newPrimeName.trim() || deploying) return;
    onDeploy(newPrimeName.trim(), newPrimeZone);
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>Deploy New Prime</div>
        <div className={styles.modalField}>
          <label className={styles.modalLabel} htmlFor="deploy-prime-name">
            Instance Name
          </label>
          <input
            id="deploy-prime-name"
            className="input"
            placeholder="e.g. charlie"
            autoFocus
            value={newPrimeName}
            onChange={(e) => setNewPrimeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleDeploy();
            }}
          />
        </div>
        <div className={styles.modalField}>
          <label className={styles.modalLabel} htmlFor="deploy-prime-zone">
            Zone
          </label>
          <select
            id="deploy-prime-zone"
            className="input"
            value={newPrimeZone}
            onChange={(e) => setNewPrimeZone(e.target.value)}
          >
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.modalActions}>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            id="deploy-prime-submit"
            className="btn btn-primary"
            onClick={handleDeploy}
            disabled={!newPrimeName.trim() || deploying}
          >
            {deploying ? "Deploying…" : "Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}
