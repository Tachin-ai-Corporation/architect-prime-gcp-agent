"use client";

import { useState } from "react";
import styles from "@/app/page.module.css";
import { api } from "@/lib/api";
import type { WorkEnvelope } from "@/lib/types";

interface WorkRespondFormProps {
  envelope: WorkEnvelope;
  primeId: string;
  onResponded: () => void;
}

export function WorkRespondForm({ envelope, primeId, onResponded }: WorkRespondFormProps) {
  const [response, setResponse] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!response.trim()) return;
    setSubmitting(true);
    setError(null);

    const result = await api<{ ok: boolean; intakeId: string }>(
      `/api/primes/${primeId}/work/${envelope.id}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: response.trim() }),
      }
    );

    if (result?.ok) {
      setSuccess(true);
      setResponse("");
      setTimeout(() => {
        onResponded();
      }, 1500);
    } else {
      setError("Failed to submit response. Please try again.");
    }
    setSubmitting(false);
  };

  if (success) {
    return (
      <div className={styles["work-respond"]}>
        <div style={{
          padding: "16px",
          background: "rgba(46, 160, 67, 0.08)",
          border: "1px solid rgba(46, 160, 67, 0.25)",
          borderRadius: 8,
          textAlign: "center",
          color: "#3fb950",
          fontSize: 14,
          fontWeight: 500,
        }}>
          ✅ Response submitted successfully
        </div>
      </div>
    );
  }

  return (
    <div className={styles["work-respond"]}>
      {/* Show the question being asked */}
      {envelope.output && (
        <div style={{
          padding: "12px 14px",
          background: "rgba(245, 158, 11, 0.06)",
          border: "1px solid rgba(245, 158, 11, 0.2)",
          borderRadius: 8,
          marginBottom: 12,
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--text-primary)",
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#f59e0b", marginBottom: 6 }}>
            Input Requested
          </div>
          {envelope.output}
        </div>
      )}

      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="Type your response…"
        style={{
          width: "100%",
          padding: "12px 14px",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          color: "var(--text-primary)",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: 1.5,
          resize: "vertical",
          minHeight: 80,
          outline: "none",
          boxSizing: "border-box",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />

      {error && (
        <div style={{ fontSize: 12, color: "#f85149", marginTop: 6 }}>{error}</div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={!response.trim() || submitting}
        >
          {submitting ? "Submitting…" : "Submit Response"}
        </button>
      </div>
    </div>
  );
}
