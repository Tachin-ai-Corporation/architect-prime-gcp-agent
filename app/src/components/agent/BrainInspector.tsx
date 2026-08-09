"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import styles from "./BrainInspector.module.css";
import { api } from "@/lib/api";

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
  brainModelId?: string;
}

interface ModelsData {
  models: ModelInfo[];
  currentModel: string;
  assignments: { default: string; overrides: Record<string, string> } | null;
  scannedAt: string | null;
}

/** Live config from agent VM via introspection */
interface LiveBrainConfig {
  default: string; // e.g. "vertex-anthropic/claude-opus-4-6" or "vertex-google/gemini-2.5-pro"
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

/* ================================================================
   Props
   ================================================================ */

interface BrainInspectorProps {
  primeId: string;
  agentName: string; // the raw agent name as it appears in the fleet
}

interface SlotDef {
  key: string;
  label?: string;
  desc: string;
  icon?: string;
  defaultModel: string;
  tools: string[];
}

const ORGAN_ICONS: Record<string, string> = {
  cortex: "🧩",
  prefrontal: "🎯",
  "temporal-research": "🔬",
  "temporal-memory": "💾",
  motor: "⚡",
  cerebellum: "✅",
};

const ORGAN_LABELS: Record<string, string> = {
  cortex: "Cortex",
  prefrontal: "Prefrontal",
  "temporal-research": "Temporal Research",
  "temporal-memory": "Temporal Memory",
  motor: "Motor",
  cerebellum: "Cerebellum",
};

const DAEMON_SLOTS = [
  { key: "ears", label: "Ears", desc: "Input preprocessor", icon: "👂" },
  { key: "mouth", label: "Mouth", desc: "Output voicing", icon: "🗣️" },
  { key: "brain", label: "Brain", desc: "Orchestrator daemon", icon: "🧠" },
] as const;

const DAEMON_KEYS: Set<string> = new Set(DAEMON_SLOTS.map(s => s.key));

/* ================================================================
   Model naming helpers
   ================================================================ */

/** Strip prefix: "vertex-google/gemini-2.5-pro" → "gemini-2.5-pro" */
function stripPrefix(brainModelId: string): string {
  const slash = brainModelId.indexOf("/");
  return slash >= 0 ? brainModelId.slice(slash + 1) : brainModelId;
}

/** Build Brain model ID from catalog model — provider-aware prefix */
function toBrainModelId(modelId: string, provider: string): string {
  if (modelId.includes("/")) return modelId; // already prefixed
  if (provider === "anthropic") return `vertex-anthropic/${modelId}`;
  return `vertex-google/${modelId}`;
}

/** Find display name from model catalog */
function getDisplayName(brainModelId: string, models: ModelInfo[]): string {
  const bare = stripPrefix(brainModelId);
  const found = models.find((m) => m.id === bare);
  return found?.name || bare;
}

/* ================================================================
   Component
   ================================================================ */

export function BrainInspector({ primeId, agentName }: BrainInspectorProps) {
  /* ---- UI State ---- */
  const [modelsData, setModelsData] = useState<ModelsData | null>(null);
  const [liveConfig, setLiveConfig] = useState<LiveBrainConfig | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadingLive, setLoadingLive] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);

  // Pending changes: slot → brainModelId
  const [pendingChanges, setPendingChanges] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  // Responsibility toggle state


  const [slots, setSlots] = useState<SlotDef[]>([]);
  const [defaultDaemonModel, setDefaultDaemonModel] = useState("gemini-3.6-flash");

  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  /* ---- Fetch brain config details (slots and defaults) ---- */
  const fetchBrainConfig = useCallback(async () => {
    if (!primeId) return;
    try {
      const data = await api<{ slots: SlotDef[]; defaultDaemonModel: string }>(
        `/api/primes/${primeId}/brain-config?agent=${agentName || "cortex"}`
      );
      if (data?.slots) {
        setSlots(data.slots);
      }
      if (data?.defaultDaemonModel) {
        setDefaultDaemonModel(data.defaultDaemonModel);
      }
    } catch (err) {
      console.error("[BrainInspector] Failed to fetch brain config slots:", err);
    }
  }, [primeId, agentName]);

  useEffect(() => {
    fetchBrainConfig();
  }, [fetchBrainConfig]);

  /* ---- Fetch model catalog from Firestore ---- */
  const fetchModelCatalog = useCallback(async () => {
    if (!primeId) return;
    setLoadingModels(true);
    const res = await api<ModelsData>(`/api/models?primeId=${primeId}`);
    if (res) setModelsData(res);
    setLoadingModels(false);
  }, [primeId]);

  useEffect(() => { fetchModelCatalog(); }, [fetchModelCatalog]);

  /* ---- Introspect: fetch live brain config from agent VM ---- */
  const fetchLiveConfig = useCallback(async (introspectAgent: string) => {
    if (!primeId) return;
    setLoadingLive(true);
    setLiveConfig(null);
    setPendingChanges({});
    setApplyResult(null);

    try {
      // Submit introspection query
      const submit = await api<{ queryId: string }>(`/api/primes/${primeId}/fleet/${introspectAgent}/introspect`, {
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
          `/api/primes/${primeId}/fleet/${introspectAgent}/introspect?queryId=${submit.queryId}`
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
  }, [primeId]);

  // Fetch live config when agentName changes
  useEffect(() => {
    if (agentName) {
      fetchLiveConfig(agentName);
    } else {
      setLiveConfig(null);
      setPendingChanges({});
      setApplyResult(null);
    }
  }, [agentName, fetchLiveConfig]);

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
  /** Resolve the model for a slot. When includePending=true (default), pending UI changes take priority. */
  const resolveSlotModel = (slot: string, includePending = true): string => {
    // 1. Check pending changes first
    if (includePending && pendingChanges[slot]) return pendingChanges[slot];

    // 2. Live config from introspection
    if (liveConfig) {
      if (DAEMON_KEYS.has(slot)) {
        const dm = liveConfig.daemonModels?.[slot as keyof NonNullable<LiveBrainConfig["daemonModels"]>];
        return dm || defaultDaemonModel; // daemon default
      }
      return liveConfig.slots[slot] || liveConfig.default || "—";
    }

    // 3. Fallback to Firestore assignments (for Prime)
    if (modelsData) {
      const override = modelsData.assignments?.overrides?.[slot];
      if (override) {
        const catalogModel = modelsData.models.find((m) => m.id === override);
        return catalogModel ? toBrainModelId(catalogModel.id, catalogModel.provider) : override;
      }
      const defaultModel = modelsData.assignments?.default || modelsData.currentModel;
      if (defaultModel) {
        const catalogModel = modelsData.models.find((m) => m.id === defaultModel);
        return catalogModel ? toBrainModelId(catalogModel.id, catalogModel.provider) : defaultModel;
      }
    }
    return "—";
  };

  /* ---- Handle model selection in picker (UI only) ---- */
  const handleSelectModel = (slot: string, model: ModelInfo) => {
    const brainModelId = toBrainModelId(model.id, model.provider);
    const currentModel = resolveSlotModel(slot, false);

    if (brainModelId === currentModel) {
      // Deselect: remove from pending
      setPendingChanges((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    } else {
      setPendingChanges((prev) => ({ ...prev, [slot]: brainModelId }));
    }
    setPickerSlot(null);
  };

  /* ---- Apply & Restart ---- */
  const handleApplyRestart = async () => {
    if (!agentName || !primeId || !liveConfig) return;
    setApplying(true);
    setApplyResult(null);

    try {
      // Build the new config: start from live config, apply pending changes
      const newDefault = liveConfig.default;
      const overrides: Record<string, string> = {};
      const daemonOverrides: Record<string, string> = {};

      for (const slot of slots) {
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
          // Daemon models use bare Vertex AI model IDs (no provider prefix)
          daemonOverrides[slot.key] = stripPrefix(pending);
        }
      }

      // Fire set_model introspection query
      const submit = await api<{ queryId: string }>(`/api/primes/${primeId}/fleet/${agentName}/introspect`, {
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
          `/api/primes/${primeId}/fleet/${agentName}/introspect?queryId=${submit.queryId}`
        );

        if (poll?.status === "complete") {
          if (poll.result?.success) {
            setApplyResult("✅ Models updated & gateway restarted");
            setPendingChanges({});
            // Refresh live config after a brief delay for gateway to fully start
            setTimeout(() => fetchLiveConfig(agentName), 5000);
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


  return (
    <div className={styles.wrapper}>
      {/* ---- Loading state ---- */}
      {loadingModels && !modelsData && (
        <div className={styles.loading}>Loading models…</div>
      )}

      {/* ---- Live config status ---- */}
      {agentName && (
        <div className={styles.liveStatus}>
          {loadingLive ? (
            <span className={styles.liveLoading}>
              <span className={styles.livePulse} /> Scanning {agentName}&apos;s config…
            </span>
          ) : liveConfig ? (
            <span className={styles.liveConnected}>
              <span className={styles.liveDot} /> Live config from {agentName}
            </span>
          ) : (
            <span className={styles.liveError}>Could not reach {agentName}</span>
          )}
        </div>
      )}

      {!agentName && modelsData?.scannedAt && (
        <div className={styles.scanned}>
          Model catalog scanned {new Date(modelsData.scannedAt).toLocaleDateString()}
        </div>
      )}

      {/* ---- Apply & Restart bar ---- */}
      {hasPendingChanges && agentName && (
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

      {/* ---- Daemon Services Section ---- */}
      <div className={styles.sectionLabel} id="brain-daemon-section">Daemon Services</div>
      <div className={styles.grid} id="brain-daemon-grid">
        {DAEMON_SLOTS.map(({ key, label, desc, icon }) => {
          const modelId = resolveSlotModel(key);
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
        {slots.map(({ key, label, desc, icon }) => {
          const modelId = resolveSlotModel(key);
          const isPending = !!pendingChanges[key];
          const displayModel = modelId === "—" ? "—" : getDisplayName(modelId, modelsData?.models || []);
          const shortId = modelId === "—" ? "" : (DAEMON_KEYS.has(key) ? modelId : stripPrefix(modelId));
          const resolvedLabel = ORGAN_LABELS[key] || label || key.charAt(0).toUpperCase() + key.slice(1);
          const resolvedIcon = ORGAN_ICONS[key] || icon || "🔸";

          return (
            <button
              key={key}
              className={`${styles.slot} ${isPending ? styles.slotPending : ""} ${loadingLive ? styles.slotLoading : ""}`}
              onClick={() => setPickerSlot(key)}
              id={`brain-slot-${key}`}
              disabled={loadingLive}
            >
              <span className={styles.slotIcon}>{resolvedIcon}</span>
              <span className={styles.slotLabel}>{resolvedLabel}</span>
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

      {/* ---- Model Picker Modal ---- */}
      {pickerSlot && (
        <div className={styles.overlay} onClick={() => setPickerSlot(null)} id="brain-picker-overlay">
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" id="brain-picker-modal">
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>
                Select model for {(() => {
                  const s = [...DAEMON_SLOTS, ...slots].find((s) => s.key === pickerSlot);
                  if (!s) return "";
                  return ORGAN_LABELS[s.key] || s.label || s.key.charAt(0).toUpperCase() + s.key.slice(1);
                })()}
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
                    const brainModelId = toBrainModelId(m.id, m.provider);
                    const currentModel = resolveSlotModel(pickerSlot, false);
                    const isCurrent = brainModelId === currentModel;
                    const isPendingSelection = pendingChanges[pickerSlot] === brainModelId;

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
    </div>
  );
}
