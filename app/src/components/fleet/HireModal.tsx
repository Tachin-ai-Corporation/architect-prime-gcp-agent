"use client";

import { useState, useEffect } from "react";
import styles from "./HireModal.module.css";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";

interface AgentType {
  id: string;
  title: string;
  specialty: string;
  emailPattern: string;
  skills: string[];
}

interface HireModalProps {
  primeId: string;
  agentEmailDomain: string;
  open: boolean;
  onClose: () => void;
  onHired: () => void;
}

export function HireModal({ primeId, agentEmailDomain, open, onClose, onHired }: HireModalProps) {
  const dialog = useDialog();
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [hireName, setHireName] = useState("");
  const [hireType, setHireType] = useState("");
  const [hiring, setHiring] = useState(false);

  /* ---- Load agent types on first open ---- */
  useEffect(() => {
    if (!open || agentTypes.length > 0) return;
    (async () => {
      const res = await api<{ types: AgentType[] }>("/api/agent-types");
      if (res?.types) {
        setAgentTypes(res.types);
        if (res.types.length > 0) setHireType(res.types[0].id);
      }
    })();
  }, [open, agentTypes.length]);

  const generatedEmail = hireName && hireType
    ? `${hireType}-agent-${hireName}@${agentEmailDomain || 'example.com'}`
    : '';

  const handleHire = async () => {
    if (!hireName.trim() || !hireType || !generatedEmail) return;
    setHiring(true);
    const res = await api<{ id: string }>(`/api/primes/${primeId}/fleet/hire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: hireName, specialty: hireType, email: generatedEmail }),
    });
    if (res?.id) {
      onHired();
    } else {
      dialog.toast({ message: "Failed to hire agent.", variant: "error" });
    }
    onClose();
    setHiring(false);
    setHireName("");
  };

  if (!open) return null;

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>Hire New Agent</div>
        <div className={styles.modalField}>
          <label className={styles.modalLabel} htmlFor="hire-agent-type">Specialty</label>
          {agentTypes.length === 0 ? (
            <div className={styles.modalHint}>Loading specialties…</div>
          ) : (
            <select
              id="hire-agent-type"
              className="input"
              value={hireType}
              onChange={(e) => setHireType(e.target.value)}
            >
              {agentTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
          )}
          {hireType && agentTypes.length > 0 && (
            <div className={styles.modalHint}>
              {agentTypes.find((t) => t.id === hireType)?.specialty}
            </div>
          )}
        </div>
        <div className={styles.modalField}>
          <label className={styles.modalLabel} htmlFor="hire-agent-name">Agent Name</label>
          <input
            id="hire-agent-name"
            className="input"
            placeholder="e.g. alice"
            autoFocus
            value={hireName}
            maxLength={15}
            onChange={(e) => {
              const v = e.target.value.toLowerCase().replace(/[^a-z]/g, '');
              setHireName(v.slice(0, 15));
            }}
            onKeyDown={(e) => { if (e.key === "Enter") handleHire(); }}
          />
          <div className={styles.modalHint}>
            Lowercase letters only, max 15 characters
          </div>
        </div>
        {generatedEmail && (
          <div className={styles.modalField}>
            <label className={styles.modalLabel}>Workspace Email</label>
            <div
              style={{
                padding: '8px 12px',
                background: 'rgba(32,40,51,0.5)',
                borderRadius: 8,
                fontSize: 13,
                color: '#AEB8C4',
                fontFamily: 'monospace',
                letterSpacing: '0.02em',
              }}
            >
              {generatedEmail}
            </div>
          </div>
        )}
        <div className={styles.modalActions}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            id="hire-agent-submit"
            className="btn btn-primary"
            onClick={handleHire}
            disabled={!hireName.trim() || !hireType || !generatedEmail || hiring}
          >
            {hiring ? "Hiring…" : "Hire"}
          </button>
        </div>
      </div>
    </div>
  );
}
