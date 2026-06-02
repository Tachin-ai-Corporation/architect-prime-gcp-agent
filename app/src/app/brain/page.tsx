"use client";

import { Suspense, useState, useEffect, useCallback, useMemo } from "react";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { useFleetSelection, FleetSelector, FleetEmptyPrompt } from "@/components/FleetSelector";

/* ================================================================
   Types
   ================================================================ */

interface ModelInfo {
  id: string;
  name: string;
  tier: string;
  provider: string;
  status: string;
  httpCode?: number;
  openclawId?: string;
}

interface ModelsData {
  models: ModelInfo[];
  currentModel: string;
  assignments: { default: string; overrides: Record<string, string> } | null;
  scannedAt: string | null;
}

/** Live config from agent VM via introspection */
interface LiveBrainConfig {
  default: string; // e.g. "google-vertex/gemini-3.1-pro-preview"
  slots: Record<string, string | null>; // per-agent overrides (null = inherits default)
  daemonModels?: { ears?: string | null; mouth?: string | null; brain?: string | null };
  responsibilities?: Responsibility[];
}

interface Responsibility {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  min_spacing_minutes: number;
  instruction: string;
  has_process: boolean;
  process_steps: number;
  source: string;
}

const DAEMON_SLOTS = [
  { key: "ears", label: "Ears", desc: "Input preprocessor", icon: "👂" },
  { key: "mouth", label: "Mouth", desc: "Output voicing", icon: "🗣️" },
  { key: "brain", label: "Brain", desc: "Orchestrator daemon", icon: "🧠" },
] as const;

const SLOTS = [
  { key: "cortex", label: "Cortex", desc: "Plan executor", icon: "🧩" },
  { key: "prefrontal", label: "Prefrontal", desc: "Planner", icon: "🎯" },
  { key: "temporal-research", label: "Temporal Research", desc: "Researcher", icon: "🔬" },
  { key: "temporal-memory", label: "Temporal Memory", desc: "Memory", icon: "💾" },
  { key: "motor", label: "Motor", desc: "Executor", icon: "⚡" },
  { key: "cerebellum", label: "Cerebellum", desc: "Verifier", icon: "✅" },
] as const;

const DAEMON_KEYS: Set<string> = new Set(DAEMON_SLOTS.map(s => s.key));

/* ================================================================
   Model naming helpers
   ================================================================ */

/** Strip OpenClaw prefix: "google-vertex/gemini-3.1-pro-preview" → "gemini-3.1-pro-preview" */
function stripPrefix(openclawId: string): string {
  const slash = openclawId.indexOf("/");
  return slash >= 0 ? openclawId.slice(slash + 1) : openclawId;
}

/** Build OpenClaw ID from catalog model: "gemini-3.1-pro-preview" (provider "google") → "google-vertex/gemini-3.1-pro-preview" */
function toOpenClawId(modelId: string, provider: string): string {
  if (modelId.includes("/")) return modelId; // already prefixed
  return provider === "google" ? `google-vertex/${modelId}` : `vertex_ai/${modelId}`;
}

/** Find display name from model catalog */
function getDisplayName(openclawId: string, models: ModelInfo[]): string {
  const bare = stripPrefix(openclawId);
  const found = models.find((m) => m.id === bare);
  return found?.name || bare;
}

/* ================================================================
   Component
   ================================================================ */

export default function BrainPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <BrainPage />
    </Suspense>
  );
}

function BrainPage() {
  const sel = useFleetSelection();
  const { selectedPrimeId, selectedAgent, isPrimeSelected, fleet, prime, primes } = sel;

  /* ---- UI State ---- */
  const [modelsData, setModelsData] = useState<ModelsData | null>(null);
  const [liveConfig, setLiveConfig] = useState<LiveBrainConfig | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadingLive, setLoadingLive] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);

  // Pending changes: slot → openclawId
  const [pendingChanges, setPendingChanges] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  // Responsibility toggle state
  const [togglingResp, setTogglingResp] = useState<string | null>(null);

  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  /* ---- Fetch model catalog from Firestore ---- */
  const fetchModelCatalog = useCallback(async () => {
    if (!selectedPrimeId) return;
    setLoadingModels(true);
    const res = await api<ModelsData>(`/api/primes/${selectedPrimeId}/models`);
    if (res) setModelsData(res);
    setLoadingModels(false);
  }, [selectedPrimeId]);

  useEffect(() => { fetchModelCatalog(); }, [fetchModelCatalog]);

  /* ---- Introspect: fetch live brain config from agent VM ---- */
  const fetchLiveConfig = useCallback(async (agentName: string) => {
    if (!selectedPrimeId) return;
    setLoadingLive(true);
    setLiveConfig(null);
    setPendingChanges({});
    setApplyResult(null);

    try {
      // Submit introspection query
      const submit = await api<{ queryId: string }>(`/api/primes/${selectedPrimeId}/fleet/${agentName}/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "brain_config" }),
      });

      if (!submit?.queryId) {
        setLoadingLive(false);
        return;
      }

      // Poll for result (max 15 attempts × 2s = 30s)
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await api<{ status: string; result?: LiveBrainConfig; error?: string }>(
          `/api/primes/${selectedPrimeId}/fleet/${agentName}/introspect?queryId=${submit.queryId}`
        );

        if (poll?.status === "complete" && poll.result) {
          setLiveConfig(poll.result);
          break;
        }
        if (poll?.status === "error") {
          console.error("[brain] introspect error:", poll.error);
          break;
        }
      }
    } catch (err) {
      console.error("[brain] live config fetch error:", err);
    }
    setLoadingLive(false);
  }, [selectedPrimeId]);

  // Fetch live config when agent changes
  useEffect(() => {
    if (selectedAgent) {
      const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;
      fetchLiveConfig(introspectAgent);
    } else {
      setLiveConfig(null);
      setPendingChanges({});
      setApplyResult(null);
    }
  }, [selectedAgent, fetchLiveConfig, isPrimeSelected, selectedPrimeId]);



  /* ---- Available models (only "available" status) ---- */
  const availableModels = useMemo(() => {
    if (!modelsData?.models) return [];
    return modelsData.models.filter((m) => m.status === "available");
  }, [modelsData]);

  const unavailableModels = useMemo(() => {
    if (!modelsData?.models) return [];
    return modelsData.models.filter((m) => m.status !== "available");
  }, [modelsData]);

  /* ---- Slot model lookup ---- */
  const getSlotModel = (slot: string): string => {
    // 1. Check pending changes first
    if (pendingChanges[slot]) return pendingChanges[slot];

    // 2. Live config from introspection
    if (liveConfig) {
      // Daemon slots (ears/mouth/brain) read from daemonModels
      if (DAEMON_KEYS.has(slot)) {
        const dm = liveConfig.daemonModels?.[slot as keyof NonNullable<LiveBrainConfig["daemonModels"]>];
        return dm || "gemini-2.5-flash"; // daemon default
      }
      const override = liveConfig.slots[slot];
      return override || liveConfig.default || "—";
    }

    // 3. Fallback to Firestore assignments (for Prime)
    if (modelsData) {
      const override = modelsData.assignments?.overrides?.[slot];
      if (override) {
        const catalogModel = modelsData.models.find((m) => m.id === override);
        return catalogModel ? toOpenClawId(catalogModel.id, catalogModel.provider) : override;
      }
      const defaultModel = modelsData.assignments?.default || modelsData.currentModel;
      if (defaultModel) {
        const catalogModel = modelsData.models.find((m) => m.id === defaultModel);
        return catalogModel ? toOpenClawId(catalogModel.id, catalogModel.provider) : defaultModel;
      }
    }
    return "—";
  };

  /* ---- Handle model selection in picker (UI only) ---- */
  const handleSelectModel = (slot: string, model: ModelInfo) => {
    const openclawId = toOpenClawId(model.id, model.provider);
    const currentModel = getSlotModelWithoutPending(slot);

    if (openclawId === currentModel) {
      // Deselect: remove from pending
      setPendingChanges((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    } else {
      setPendingChanges((prev) => ({ ...prev, [slot]: openclawId }));
    }
    setPickerSlot(null);
  };

  /** Get slot model WITHOUT pending changes (for comparison) */
  const getSlotModelWithoutPending = (slot: string): string => {
    if (liveConfig) {
      if (DAEMON_KEYS.has(slot)) {
        const dm = liveConfig.daemonModels?.[slot as keyof NonNullable<LiveBrainConfig["daemonModels"]>];
        return dm || "gemini-2.5-flash";
      }
      return liveConfig.slots[slot] || liveConfig.default || "—";
    }
    if (modelsData) {
      const override = modelsData.assignments?.overrides?.[slot];
      if (override) {
        const catalogModel = modelsData.models.find((m) => m.id === override);
        return catalogModel ? toOpenClawId(catalogModel.id, catalogModel.provider) : override;
      }
      const defaultModel = modelsData.assignments?.default || modelsData.currentModel;
      if (defaultModel) {
        const catalogModel = modelsData.models.find((m) => m.id === defaultModel);
        return catalogModel ? toOpenClawId(catalogModel.id, catalogModel.provider) : defaultModel;
      }
    }
    return "—";
  };

  /* ---- Apply & Restart ---- */
  const handleApplyRestart = async () => {
    if (!selectedAgent || !selectedPrimeId || !liveConfig) return;
    const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;
    setApplying(true);
    setApplyResult(null);

    try {
      // Build the new config: start from live config, apply pending changes
      const newDefault = liveConfig.default;
      const overrides: Record<string, string> = {};
      const daemonOverrides: Record<string, string> = {};

      for (const slot of SLOTS) {
        const pending = pendingChanges[slot.key];
        if (pending) {
          overrides[slot.key] = pending;
        } else {
          // Keep existing override if any
          const existing = liveConfig.slots[slot.key];
          if (existing) {
            overrides[slot.key] = existing;
          }
        }
      }

      // Daemon slot overrides (ears/mouth) — write to contracts.json
      for (const slot of DAEMON_SLOTS) {
        const pending = pendingChanges[slot.key];
        if (pending) {
          // Daemon models use bare Vertex AI model IDs (no openclaw prefix)
          daemonOverrides[slot.key] = stripPrefix(pending);
        }
      }

      // Fire set_model introspection query
      const submit = await api<{ queryId: string }>(`/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "set_model",
          params: { default: newDefault, overrides, daemonOverrides },
        }),
      });

      if (!submit?.queryId) {
        setApplyResult("Failed to submit model change");
        setApplying(false);
        return;
      }

      // Poll for result (max 30 attempts × 2s = 60s — gateway restart can take a while)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await api<{ status: string; result?: { success: boolean; message?: string; error?: string }; error?: string }>(
          `/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/introspect?queryId=${submit.queryId}`
        );

        if (poll?.status === "complete") {
          if (poll.result?.success) {
            setApplyResult("✅ Models updated & gateway restarted");
            setPendingChanges({});
            // Refresh live config after a brief delay for gateway to fully start
            setTimeout(() => fetchLiveConfig(introspectAgent), 5000);
          } else {
            setApplyResult(`❌ ${poll.result?.error || "Unknown error"}`);
          }
          break;
        }
        if (poll?.status === "error") {
          setApplyResult(`❌ ${poll.error || "Introspection error"}`);
          break;
        }
      }
    } catch (err) {
      setApplyResult(`❌ ${err instanceof Error ? err.message : "Unknown error"}`);
    }
    setApplying(false);
  };

  /* ---- Toggle responsibility enabled/disabled ---- */
  const handleToggleResp = async (respId: string, currentEnabled: boolean) => {
    if (!selectedPrimeId || !selectedAgent) return;
    const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;
    setTogglingResp(respId);

    // Optimistic UI update
    if (liveConfig?.responsibilities) {
      setLiveConfig({
        ...liveConfig,
        responsibilities: liveConfig.responsibilities.map((r) =>
          r.id === respId ? { ...r, enabled: !currentEnabled } : r
        ),
      });
    }

    try {
      const submit = await api<{ queryId: string }>(
        `/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/introspect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "set_responsibility_enabled",
            params: { id: respId, enabled: !currentEnabled },
          }),
        }
      );

      if (submit?.queryId) {
        // Poll for result (max 10 attempts × 2s)
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const poll = await api<{ status: string; result?: { success: boolean; message?: string; error?: string }; error?: string }>(
            `/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/introspect?queryId=${submit.queryId}`
          );

          if (poll?.status === "complete") {
            if (!poll.result?.success) {
              // Revert optimistic update
              fetchLiveConfig(introspectAgent);
            }
            break;
          }
          if (poll?.status === "error") {
            fetchLiveConfig(introspectAgent);
            break;
          }
        }
      } else {
        fetchLiveConfig(introspectAgent);
      }
    } catch {
      // Revert on error
      const intrAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;
      fetchLiveConfig(intrAgent);
    }
    setTogglingResp(null);
  };

  /* ---- Title ---- */
  const displayName = selectedAgent
    ? selectedAgent
    : prime?.name || selectedPrimeId || "";
  const titleSuffix = displayName ? ` · ${displayName}` : "";

  return (
    <div className={styles.shell} id="brain-page">
      <div className={styles.container}>
        {/* ---- Fleet Selector ---- */}
        <FleetSelector mode="agent" selection={sel} />

        {/* ---- Empty state ---- */}
        {!selectedPrimeId && (
          <FleetEmptyPrompt
            icon="🧠"
            title="Select a prime above"
            subtitle="Choose a prime and an agent to view brain configuration"
          />
        )}

        {/* ---- Loading state ---- */}
        {selectedPrimeId && loadingModels && !modelsData && (
          <div className={styles.loading}>Loading models…</div>
        )}

        {/* ---- Page Header ---- */}
        {selectedPrimeId && (
          <div className={styles.pgHeader}>
            <h1 className={styles.pgTitle}>🧠 Brain — LLM Slots{titleSuffix}</h1>
          </div>
        )}

        {/* ---- Live config status ---- */}
        {selectedAgent && (
          <div className={styles.liveStatus}>
            {loadingLive ? (
              <span className={styles.liveLoading}>
                <span className={styles.livePulse} /> Scanning {selectedAgent}&apos;s config…
              </span>
            ) : liveConfig ? (
              <span className={styles.liveConnected}>
                <span className={styles.liveDot} /> Live config from {selectedAgent}
              </span>
            ) : (
              <span className={styles.liveError}>Could not reach {selectedAgent}</span>
            )}
          </div>
        )}

        {!selectedAgent && modelsData?.scannedAt && (
          <div className={styles.scanned}>
            Model catalog scanned {new Date(modelsData.scannedAt).toLocaleDateString()}
          </div>
        )}

        {/* ---- Apply & Restart bar ---- */}
        {hasPendingChanges && selectedAgent && (
          <div className={styles.applyBar}>
            <div className={styles.applyInfo}>
              <span className={styles.applyIcon}>⚠</span>
              <span>{Object.keys(pendingChanges).length} model change{Object.keys(pendingChanges).length > 1 ? "s" : ""} pending</span>
            </div>
            <div className={styles.applyActions}>
              <button
                className={styles.applyDiscard}
                onClick={() => { setPendingChanges({}); setApplyResult(null); }}
                disabled={applying}
              >
                Discard
              </button>
              <button
                className={styles.applyBtn}
                onClick={handleApplyRestart}
                disabled={applying}
              >
                {applying ? "Applying…" : "Apply & Restart"}
              </button>
            </div>
          </div>
        )}

        {applyResult && (
          <div className={`${styles.applyResult} ${applyResult.startsWith("✅") ? styles.applySuccess : styles.applyError}`}>
            {applyResult}
          </div>
        )}

        {/* ---- All brain content gated behind prime selection ---- */}
        {selectedPrimeId && (
          <>
        {/* ---- Daemon Services Section ---- */}
        <div className={styles.sectionLabel} id="brain-daemon-section">Daemon Services</div>
        <div className={styles.grid} id="brain-daemon-grid">
          {DAEMON_SLOTS.map(({ key, label, desc, icon }) => {
            const modelId = getSlotModel(key);
            const isPending = !!pendingChanges[key];
            const displayModel = modelId === "—" ? "—" : getDisplayName(modelId, modelsData?.models || []);
            const shortId = modelId === "—" ? "" : stripPrefix(modelId);

            return (
              <button
                key={key}
                className={`${styles.slot} ${isPending ? styles.slotPending : ""} ${loadingLive ? styles.slotLoading : ""}`}
                onClick={() => setPickerSlot(key)}
                id={`brain-slot-${key}`}
                disabled={loadingLive}
              >
                <span className={styles.slotIcon}>{icon}</span>
                <span className={styles.slotLabel}>{label}</span>
                <span className={styles.slotDesc}>{desc}</span>
                {loadingLive ? (
                  <span className={styles.slotModelLoading}>scanning…</span>
                ) : (
                  <>
                    <span className={styles.slotModel}>{displayModel}</span>
                    {shortId && <span className={styles.slotModelId}>{shortId}</span>}
                  </>
                )}
                {isPending && <span className={styles.slotPendingBadge}>pending</span>}
                {!loadingLive && <span className={styles.slotSwap}>click to swap</span>}
              </button>
            );
          })}
        </div>

        {/* ---- Brain Agents Section ---- */}
        <div className={styles.sectionLabel} id="brain-agents-section">Brain Agents</div>
        <div className={styles.grid} id="brain-slot-grid">
          {SLOTS.map(({ key, label, desc, icon }) => {
            const modelId = getSlotModel(key);
            const isPending = !!pendingChanges[key];
          const displayModel = modelId === "—" ? "—" : getDisplayName(modelId, modelsData?.models || []);
          const shortId = modelId === "—" ? "" : (DAEMON_KEYS.has(key) ? modelId : stripPrefix(modelId));

            return (
              <button
                key={key}
                className={`${styles.slot} ${isPending ? styles.slotPending : ""} ${loadingLive ? styles.slotLoading : ""}`}
                onClick={() => setPickerSlot(key)}
                id={`brain-slot-${key}`}
                disabled={loadingLive}
              >
                <span className={styles.slotIcon}>{icon}</span>
                <span className={styles.slotLabel}>{label}</span>
                <span className={styles.slotDesc}>{desc}</span>
                {loadingLive ? (
                  <span className={styles.slotModelLoading}>scanning…</span>
                ) : (
                  <>
                    <span className={styles.slotModel}>{displayModel}</span>
                    {shortId && <span className={styles.slotModelId}>{shortId}</span>}
                  </>
                )}
                {isPending && <span className={styles.slotPendingBadge}>pending</span>}
                {!loadingLive && <span className={styles.slotSwap}>click to swap</span>}
              </button>
            );
          })}
        </div>

        {/* ---- Responsibilities Section ---- */}
        {selectedAgent && (
          <>
            <div className={styles.sectionLabel} id="brain-responsibilities-section">Responsibilities</div>
            {loadingLive ? (
              <div className={styles.respLoading}>
                <span className={styles.livePulse} /> Scanning responsibilities…
              </div>
            ) : liveConfig?.responsibilities && liveConfig.responsibilities.length > 0 ? (
              <div className={styles.respGrid}>
                {liveConfig.responsibilities.map((r) => (
                  <div
                    key={r.id}
                    className={`${styles.respCard} ${!r.enabled ? styles.respCardDisabled : ""}`}
                    id={`resp-${r.id}`}
                  >
                    <div className={styles.respCardHeader}>
                      <span className={`${styles.respDot} ${r.enabled ? styles.respDotOn : styles.respDotOff}`} />
                      <span className={styles.respCardName}>{r.name}</span>
                      {!r.enabled && <span className={styles.respPausedBadge}>paused</span>}
                      <code className={styles.respSchedule}>{r.schedule}</code>
                      <button
                        className={`${styles.respToggle} ${r.enabled ? styles.respToggleOn : ""}`}
                        onClick={() => handleToggleResp(r.id, r.enabled)}
                        disabled={togglingResp === r.id}
                        title={r.enabled ? "Pause responsibility" : "Resume responsibility"}
                        aria-label={r.enabled ? `Pause ${r.name}` : `Resume ${r.name}`}
                        id={`resp-toggle-${r.id}`}
                      />
                    </div>
                    <div className={styles.respCardDesc}>{r.instruction}</div>
                    <div className={styles.respCardMeta}>
                      {r.has_process && (
                        <span className={styles.respProcess}>{r.process_steps} steps</span>
                      )}
                      {r.min_spacing_minutes > 0 && (
                        <span>min {Math.round(r.min_spacing_minutes / 60)}h spacing</span>
                      )}
                      <span className={styles.respSource}>{r.source}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : !loadingLive && liveConfig ? (
              <div className={styles.respEmpty}>No responsibilities configured for this agent</div>
            ) : null}
          </>
        )}

        {/* ---- Model Picker Modal ---- */}
        {pickerSlot && (
          <div className={styles.overlay} onClick={() => setPickerSlot(null)} id="brain-picker-overlay">
            <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" id="brain-picker-modal">
              <div className={styles.modalHeader}>
                <h2 className={styles.modalTitle}>
                  Select model for {[...DAEMON_SLOTS, ...SLOTS].find((s) => s.key === pickerSlot)?.label}
                </h2>
                <button className={styles.modalClose} onClick={() => setPickerSlot(null)} aria-label="Close">✕</button>
              </div>
              <div className={styles.modalBody}>
                {availableModels.length === 0 && unavailableModels.length === 0 && (
                  <div className={styles.noModels}>
                    No models discovered. Run a scan from Settings → Models first.
                  </div>
                )}

                {/* Available models */}
                {availableModels.length > 0 && (
                  <div className={styles.providerGroup}>
                    <div className={styles.providerLabel}>Available Models</div>
                    {availableModels.map((m) => {
                      const openclawId = toOpenClawId(m.id, m.provider);
                      const currentModel = getSlotModelWithoutPending(pickerSlot);
                      const isCurrent = openclawId === currentModel;
                      const isPendingSelection = pendingChanges[pickerSlot] === openclawId;

                      return (
                        <button
                          key={m.id}
                          className={`${styles.modelOption} ${isCurrent ? styles.modelCurrent : ""} ${isPendingSelection ? styles.modelPending : ""}`}
                          onClick={() => handleSelectModel(pickerSlot, m)}
                          id={`model-opt-${m.id.replace(/[^a-z0-9]/gi, "-")}`}
                        >
                          <div className={styles.modelOptionInfo}>
                            <span className={styles.modelName}>{m.name || m.id}</span>
                            <span className={styles.modelId}>{m.id}</span>
                          </div>
                          <div className={styles.modelOptionRight}>
                            <span className={styles.modelProviderBadge}>{m.provider}</span>
                            {isCurrent && <span className={styles.currentBadge}>current</span>}
                            {isPendingSelection && !isCurrent && <span className={styles.pendingBadge}>pending</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Unavailable models */}
                {unavailableModels.length > 0 && (
                  <div className={styles.providerGroup}>
                    <div className={styles.providerLabel}>
                      Unavailable ({unavailableModels.length})
                    </div>
                    {unavailableModels.map((m) => (
                      <div
                        key={m.id}
                        className={`${styles.modelOption} ${styles.modelDisabled}`}
                      >
                        <div className={styles.modelOptionInfo}>
                          <span className={styles.modelName}>{m.name || m.id}</span>
                          <span className={styles.modelId}>{m.id}</span>
                        </div>
                        <span className={styles.modelProviderBadge} style={{ opacity: 0.5 }}>{m.provider}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}
