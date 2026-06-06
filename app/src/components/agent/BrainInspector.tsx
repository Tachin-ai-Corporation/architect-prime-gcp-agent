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

/* ================================================================
   Props
   ================================================================ */

interface BrainInspectorProps {
  primeId: string;
  agentName: string; // the raw agent name as it appears in the fleet
}

/* ================================================================
   Constants
   ================================================================ */

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

/** Strip prefix: "google-vertex/gemini-3.1-pro-preview" → "gemini-3.1-pro-preview" */
function stripPrefix(brainModelId: string): string {
  const slash = brainModelId.indexOf("/");
  return slash >= 0 ? brainModelId.slice(slash + 1) : brainModelId;
}

/** Build Brain model ID from catalog model — provider-aware prefix */
function toBrainModelId(modelId: string, provider: string): string {
  if (modelId.includes("/")) return modelId; // already prefixed
  if (provider === "anthropic") return `vertex-anthropic/${modelId}`;
  if (provider === "google")    return `vertex-google/${modelId}`;
  // MaaS: embed publisher so SDK gets "meta/llama-...", "xai/grok-...", etc.
  return `vertex-maas/${provider}/${modelId}`;
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
  const [togglingResp, setTogglingResp] = useState<string | null>(null);

  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  /* ---- Fetch model catalog from Firestore ---- */
  const fetchModelCatalog = useCallback(async () => {
    if (!primeId) return;
    setLoadingModels(true);
    const res = await api<ModelsData>(`/api/primes/${primeId}/models`);
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
    const currentModel = getSlotModelWithoutPending(slot);

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
  const handleToggleResp = async (respId: string, currentEnabled: boolean) => {
    if (!primeId || !agentName) return;
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
        `/api/primes/${primeId}/fleet/${agentName}/introspect`,
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
            `/api/primes/${primeId}/fleet/${agentName}/introspect?queryId=${submit.queryId}`
          );

          if (poll?.status === "complete") {
            if (!poll.result?.success) {
              // Revert optimistic update
              fetchLiveConfig(agentName);
            }
            break;
          }
          if (poll?.status === "error") {
            fetchLiveConfig(agentName);
            break;
          }
        }
      } else {
        fetchLiveConfig(agentName);
      }
    } catch {
      // Revert on error
      fetchLiveConfig(agentName);
    }
    setTogglingResp(null);
  };

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
                    const brainModelId = toBrainModelId(m.id, m.provider);
                    const currentModel = getSlotModelWithoutPending(pickerSlot);
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
