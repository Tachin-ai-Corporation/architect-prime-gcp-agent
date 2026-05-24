"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { usePrime } from "@/contexts/PrimeContext";

interface ModelsData {
  models: string[];
  currentModel: string;
  assignments: { default: string; overrides: Record<string, string> } | null;
  scannedAt: string | null;
}

const SLOTS = [
  { key: "cortex", label: "Cortex", desc: "Plan executor", icon: "🧩" },
  { key: "prefrontal", label: "Prefrontal", desc: "Planner", icon: "🎯" },
  { key: "temporal-research", label: "Temporal Research", desc: "Researcher", icon: "🔬" },
  { key: "temporal-memory", label: "Temporal Memory", desc: "Memory", icon: "💾" },
  { key: "motor", label: "Motor", desc: "28 tools", icon: "⚡" },
  { key: "cerebellum", label: "Cerebellum", desc: "Verifier", icon: "✅" },
] as const;

function groupByProvider(models: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const m of models) {
    const slash = m.indexOf("/");
    const provider = slash > 0 ? m.slice(0, slash) : "other";
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(m);
  }
  return groups;
}

export default function PrimeBrain() {
  const { id } = useParams<{ id: string }>();
  const { primes } = usePrime();
  const prime = primes.find((p) => p.id === id);
  const [data, setData] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchModels = useCallback(async () => {
    const res = await api<ModelsData>(`/api/primes/${id}/models`);
    if (res) setData(res);
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  const getSlotModel = (slot: string): string => {
    if (!data) return "—";
    return data.assignments?.overrides?.[slot] || data.assignments?.default || data.currentModel || "—";
  };

  const handleSelect = async (slot: string, model: string) => {
    if (!data) return;
    setSaving(true);
    const overrides = { ...(data.assignments?.overrides || {}) };
    overrides[slot] = model;
    const defaultModel = data.assignments?.default || data.currentModel || model;
    await api<{ success: boolean }>(`/api/primes/${id}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel, assignments: { default: defaultModel, overrides } }),
    });
    setPickerSlot(null);
    setSaving(false);
    fetchModels();
  };

  const grouped = data ? groupByProvider(data.models || []) : {};

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading models…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="prime-brain">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>🧠 Brain — LLM Slots{prime ? ` · ${prime.name}` : ""}</h1>
          {data?.scannedAt && (
            <span className={styles.scanned}>Scanned {new Date(data.scannedAt).toLocaleDateString()}</span>
          )}
        </header>

        <div className={styles.grid} id="brain-slot-grid">
          {SLOTS.map(({ key, label, desc, icon }) => {
            const model = getSlotModel(key);
            return (
              <button
                key={key}
                className={styles.slot}
                onClick={() => setPickerSlot(key)}
                id={`brain-slot-${key}`}
              >
                <span className={styles.slotIcon}>{icon}</span>
                <span className={styles.slotLabel}>{label}</span>
                <span className={styles.slotDesc}>{desc}</span>
                <span className={styles.slotModel}>{model.split("/").pop() || model}</span>
                <span className={styles.slotSwap}>click to swap</span>
              </button>
            );
          })}
        </div>

        {/* Model Picker Modal */}
        {pickerSlot && (
          <div className={styles.overlay} onClick={() => setPickerSlot(null)} id="brain-picker-overlay">
            <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" id="brain-picker-modal">
              <div className={styles.modalHeader}>
                <h2 className={styles.modalTitle}>
                  Select model for {SLOTS.find((s) => s.key === pickerSlot)?.label}
                </h2>
                <button className={styles.modalClose} onClick={() => setPickerSlot(null)} aria-label="Close">✕</button>
              </div>
              <div className={styles.modalBody}>
                {Object.keys(grouped).length === 0 && (
                  <div className={styles.noModels}>No models available. Run a scan first.</div>
                )}
                {Object.entries(grouped).map(([provider, models]) => (
                  <div key={provider} className={styles.providerGroup}>
                    <div className={styles.providerLabel}>{provider}</div>
                    {models.map((m) => {
                      const isCurrent = m === getSlotModel(pickerSlot);
                      return (
                        <button
                          key={m}
                          className={`${styles.modelOption} ${isCurrent ? styles.modelCurrent : ""}`}
                          onClick={() => handleSelect(pickerSlot, m)}
                          disabled={saving}
                          id={`model-opt-${m.replace(/[^a-z0-9]/gi, "-")}`}
                        >
                          <span className={styles.modelName}>{m.split("/").pop()}</span>
                          {isCurrent && <span className={styles.currentBadge}>current</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
