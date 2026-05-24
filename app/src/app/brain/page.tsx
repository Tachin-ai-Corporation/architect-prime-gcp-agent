"use client";

import { Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { usePrime } from "@/contexts/PrimeContext";

interface ModelInfo {
  id: string;
  name: string;
  tier: string;
  provider: string;
  status: string;
  httpCode?: number;
  openclawId?: string;
  description?: string;
  cost?: string;
}

interface ModelsData {
  models: ModelInfo[];
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

function groupByProvider(models: ModelInfo[]): Record<string, ModelInfo[]> {
  const groups: Record<string, ModelInfo[]> = {};
  for (const m of models) {
    const provider = m.provider || "other";
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(m);
  }
  return groups;
}

export default function BrainPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <BrainPage />
    </Suspense>
  );
}

function BrainPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { primes, sidebarFleet } = usePrime();

  /* ---- Prime selection from URL param or first available ---- */
  const paramPrime = searchParams.get("prime");
  const paramAgent = searchParams.get("agent");

  const selectedPrimeId = paramPrime && primes.find((p) => p.id === paramPrime)
    ? paramPrime
    : primes[0]?.id || null;

  const prime = primes.find((p) => p.id === selectedPrimeId);
  const fleet = selectedPrimeId ? sidebarFleet[selectedPrimeId] || [] : [];

  /* ---- Agent filter — from URL param or local state ---- */
  const [localAgent, setLocalAgent] = useState<string | null>(paramAgent || null);

  useEffect(() => {
    if (paramAgent) setLocalAgent(paramAgent);
  }, [paramAgent]);

  const selectedAgent = localAgent;

  /* ---- Data state ---- */
  const [data, setData] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [primeDropdownOpen, setPrimeDropdownOpen] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);

  /* ---- Close prime dropdown on outside click ---- */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setPrimeDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ---- Update URL params helper ---- */
  const updateParams = useCallback(
    (primeId: string | null, agent: string | null) => {
      const params = new URLSearchParams();
      if (primeId) params.set("prime", primeId);
      if (agent) params.set("agent", agent);
      const qs = params.toString();
      router.replace(`/brain${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router]
  );

  /* ---- Fetch models (always via prime endpoint) ---- */
  const fetchModels = useCallback(async () => {
    if (!selectedPrimeId) return;
    setLoading(true);
    const res = await api<ModelsData>(`/api/primes/${selectedPrimeId}/models`);
    if (res) setData(res);
    setLoading(false);
  }, [selectedPrimeId]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  /* ---- Agent strip data ---- */
  const agentInfo = useMemo(() => {
    const agents = fleet.filter((a) => a.status !== "removed");
    return agents.map((agent) => ({
      name: agent.name,
      working: agent.status === "online",
      status: agent.status,
    }));
  }, [fleet]);

  /* ---- Slot model lookup ---- */
  const getSlotModel = (slot: string): string => {
    if (!data) return "—";
    return data.assignments?.overrides?.[slot] || data.assignments?.default || data.currentModel || "—";
  };

  /* ---- Handle model selection ---- */
  const handleSelect = async (slot: string, model: string) => {
    if (!data || !selectedPrimeId) return;
    setSaving(true);
    const overrides = { ...(data.assignments?.overrides || {}) };
    overrides[slot] = model;
    const defaultModel = data.assignments?.default || data.currentModel || model;
    await api<{ success: boolean }>(`/api/primes/${selectedPrimeId}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel, assignments: { default: defaultModel, overrides } }),
    });
    setPickerSlot(null);
    setSaving(false);
    fetchModels();
  };

  /* ---- Handlers ---- */
  const handleSelectAgent = useCallback(
    (name: string) => {
      const next = localAgent === name ? null : name;
      setLocalAgent(next);
      updateParams(selectedPrimeId, next);
    },
    [localAgent, selectedPrimeId, updateParams]
  );

  const handleSwitchPrime = useCallback(
    (primeId: string) => {
      setPrimeDropdownOpen(false);
      setLocalAgent(null);
      updateParams(primeId, null);
    },
    [updateParams]
  );

  const grouped = data ? groupByProvider(data.models || []) : {};

  /* ---- Title ---- */
  const displayName = selectedAgent
    ? selectedAgent
    : prime?.name || selectedPrimeId || "";
  const titleSuffix = displayName ? ` · ${displayName}` : "";

  /* ---- Loading state ---- */
  if (loading && !data) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading models…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="brain-page">
      <div className={styles.container}>
        {/* ---- Page Header ---- */}
        <div className={styles.pgHeader}>
          <h1 className={styles.pgTitle}>🧠 Brain — LLM Slots{titleSuffix}</h1>

          {/* Prime selector */}
          {primes.length > 0 && (
            <div className={styles.primeSelector} ref={dropdownRef}>
              <button
                className={styles.primeSelectorBtn}
                onClick={() => setPrimeDropdownOpen((v) => !v)}
              >
                {prime?.name || selectedPrimeId || "Select Prime"}
                <span
                  className={`${styles.primeSelectorChev} ${primeDropdownOpen ? styles.primeSelectorChevOpen : ""}`}
                >
                  ▾
                </span>
              </button>
              {primeDropdownOpen && (
                <div className={styles.primeSelectorDropdown}>
                  {primes.map((p) => (
                    <button
                      key={p.id}
                      className={`${styles.primeSelectorItem} ${p.id === selectedPrimeId ? styles.primeSelectorItemActive : ""}`}
                      onClick={() => handleSwitchPrime(p.id)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---- Agent Strip ---- */}
        {agentInfo.length > 0 && (
          <div className={styles.agents}>
            {agentInfo.map((agent) => (
              <button
                key={agent.name}
                className={`${styles.ag} ${selectedAgent === agent.name ? styles.agSel : ""}`}
                onClick={() => handleSelectAgent(agent.name)}
              >
                <span
                  className={`${styles.agDot} ${agent.working ? styles.agDotOn : styles.agDotIdle}`}
                />
                <div className={styles.agInfo}>
                  <span className={styles.agName}>{agent.name}</span>
                  <span className={agent.working ? styles.agDoing : styles.agIdle}>
                    {agent.working ? "Online" : "Idle"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ---- Scanned date ---- */}
        {data?.scannedAt && (
          <div className={styles.scanned}>
            Scanned {new Date(data.scannedAt).toLocaleDateString()}
          </div>
        )}

        {/* ---- Slot Grid ---- */}
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
                      const isCurrent = m.id === getSlotModel(pickerSlot);
                      return (
                        <button
                          key={m.id}
                          className={`${styles.modelOption} ${isCurrent ? styles.modelCurrent : ""}`}
                          onClick={() => handleSelect(pickerSlot, m.id)}
                          disabled={saving}
                          id={`model-opt-${m.id.replace(/[^a-z0-9]/gi, "-")}`}
                        >
                          <span className={styles.modelName}>{m.name || m.id.split("/").pop()}</span>
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
