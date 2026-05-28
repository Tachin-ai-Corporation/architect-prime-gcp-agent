"use client";

import { Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { usePrime } from "@/contexts/PrimeContext";

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { primes, sidebarFleet } = usePrime();

  /* ---- Prime/Agent selection ---- */
  const paramPrime = searchParams.get("prime");
  const paramAgent = searchParams.get("agent");

  const selectedPrimeId = paramPrime && primes.find((p) => p.id === paramPrime)
    ? paramPrime
    : primes[0]?.id || null;

  const prime = primes.find((p) => p.id === selectedPrimeId);
  const fleet = selectedPrimeId ? sidebarFleet[selectedPrimeId] || [] : [];

  const [localAgent, setLocalAgent] = useState<string | null>(paramAgent || null);
  useEffect(() => { if (paramAgent) setLocalAgent(paramAgent); }, [paramAgent]);

  const selectedAgent = localAgent;

  /* ---- UI State ---- */
  const [modelsData, setModelsData] = useState<ModelsData | null>(null);
  const [liveConfig, setLiveConfig] = useState<LiveBrainConfig | null>(null);
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadingLive, setLoadingLive] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  const [primeDropdownOpen, setPrimeDropdownOpen] = useState(false);

  // Pending changes: slot → openclawId
  const [pendingChanges, setPendingChanges] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  /* ---- Close dropdown on outside click ---- */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setPrimeDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ---- URL param helper ---- */
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
      fetchLiveConfig(selectedAgent);
    } else {
      setLiveConfig(null);
      setPendingChanges({});
      setApplyResult(null);
    }
  }, [selectedAgent, fetchLiveConfig]);

  /* ---- Agent strip data ---- */
  const agentInfo = useMemo(() => {
    return fleet
      .filter((a) => a.status !== "removed")
      .map((agent) => ({
        name: agent.name,
        working: agent.status === "online",
        status: agent.status,
      }));
  }, [fleet]);

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
        if (slot === "brain") {
          // Brain daemon routes LLM calls through the Cortex gateway route.
          // If no explicit brain model override, it uses whatever Cortex is set to.
          if (dm) return dm;
          return liveConfig.slots["cortex"] || liveConfig.default || "—";
        }
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
        if (slot === "brain") {
          if (dm) return dm;
          return liveConfig.slots["cortex"] || liveConfig.default || "—";
        }
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
      const submit = await api<{ queryId: string }>(`/api/primes/${selectedPrimeId}/fleet/${selectedAgent}/introspect`, {
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
          `/api/primes/${selectedPrimeId}/fleet/${selectedAgent}/introspect?queryId=${submit.queryId}`
        );

        if (poll?.status === "complete") {
          if (poll.result?.success) {
            setApplyResult("✅ Models updated & gateway restarted");
            setPendingChanges({});
            // Refresh live config after a brief delay for gateway to fully start
            setTimeout(() => fetchLiveConfig(selectedAgent), 5000);
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

  /* ---- Title ---- */
  const displayName = selectedAgent
    ? selectedAgent
    : prime?.name || selectedPrimeId || "";
  const titleSuffix = displayName ? ` · ${displayName}` : "";

  /* ---- Loading state ---- */
  if (loadingModels && !modelsData) {
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
                  <div key={r.id} className={styles.respCard} id={`resp-${r.id}`}>
                    <div className={styles.respCardHeader}>
                      <span className={`${styles.respDot} ${r.enabled ? styles.respDotOn : styles.respDotOff}`} />
                      <span className={styles.respCardName}>{r.name}</span>
                      <code className={styles.respSchedule}>{r.schedule}</code>
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
      </div>
    </div>
  );
}
