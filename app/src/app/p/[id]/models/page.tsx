"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";

/* ---- Types ---- */
interface ModelInfo {
  id: string;
  name: string;
  tier: string;
  provider: string;
  status: "available" | "not_found" | "auth_error" | "timeout" | "checking" | "unknown";
  httpCode?: number;
  openclawId?: string;
  description?: string;
  cost?: string;
}

interface ModelAssignments {
  default: string;
  overrides: Record<string, string>;
}

interface ModelsResponse {
  models: ModelInfo[];
  currentModel: string;
  projectId: string;
  scannedAt: string | null;
  assignments: ModelAssignments | null;
}

/* ---- Brain agent definitions ---- */
const BRAIN_AGENTS = [
  { id: "cortex", label: "Cortex", desc: "Orchestrator — user-facing", icon: "🧠", recommended: "pro" },
  { id: "prefrontal", label: "Prefrontal", desc: "Strategic planning", icon: "📋", recommended: "pro" },
  { id: "motor", label: "Motor", desc: "Code execution", icon: "⚡", recommended: "any" },
  { id: "temporal-research", label: "Research", desc: "Web search", icon: "🔍", recommended: "flash" },
  { id: "temporal-memory", label: "Memory", desc: "Context recall", icon: "💾", recommended: "flash" },
  { id: "cerebellum", label: "Cerebellum", desc: "QA verification", icon: "✅", recommended: "flash" },
];

const PROVIDER_COLORS: Record<string, string> = {
  google: "rgba(66,133,244,0.15)",
  anthropic: "rgba(217,119,87,0.15)",
  openai: "rgba(0,166,126,0.15)",
  meta: "rgba(0,128,255,0.15)",
  mistral: "rgba(255,128,0,0.15)",
};

const STATUS_DISPLAY: Record<string, { icon: string; label: string; color: string }> = {
  available: { icon: "✅", label: "Available", color: "#3BAA78" },
  not_found: { icon: "❌", label: "Not Available", color: "#D84F45" },
  auth_error: { icon: "🔒", label: "Needs Enablement", color: "#D6A83A" },
  timeout: { icon: "⚠️", label: "Timeout", color: "#D6A83A" },
  checking: { icon: "⏳", label: "Checking...", color: "#2F80A8" },
  unknown: { icon: "❓", label: "Not Scanned", color: "#566373" },
};

const PROVIDER_ORDER = ["google", "anthropic", "openai", "meta", "mistral"];
const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  anthropic: "Anthropic",
  openai: "OpenAI",
  meta: "Meta",
  mistral: "Mistral",
};

export default function PrimeModelsPage() {
  const { id } = useParams<{ id: string }>();
  const { primes, setup } = usePrime();
  const prime = primes.find((p) => p.id === id);
  const projectId = setup.projectId;

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ success: boolean; message: string } | null>(null);

  // Brain agent assignments
  const [defaultModel, setDefaultModel] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [assignmentsDirty, setAssignmentsDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load models
  const loadModels = useCallback(async () => {
    if (!id) return;
    const data = await api<ModelsResponse>(`/api/primes/${id}/models`);
    if (data) {
      if (data.models.length > 0) setModels(data.models);
      setCurrentModel(data.currentModel);
      setScannedAt(data.scannedAt);
      if (data.assignments) {
        setDefaultModel(data.assignments.default || data.currentModel);
        setOverrides(data.assignments.overrides || {});
      } else {
        setDefaultModel(data.currentModel);
      }
    }
  }, [id]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // Group models by provider
  const groupedModels = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const model of models) {
      const provider = model.provider || "other";
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(model);
    }
    // Sort by defined order
    const sorted: { provider: string; label: string; models: ModelInfo[] }[] = [];
    for (const p of PROVIDER_ORDER) {
      if (groups[p]) {
        sorted.push({ provider: p, label: PROVIDER_LABELS[p] || p, models: groups[p] });
        delete groups[p];
      }
    }
    // Remaining providers
    for (const [p, m] of Object.entries(groups)) {
      sorted.push({ provider: p, label: p.charAt(0).toUpperCase() + p.slice(1), models: m });
    }
    return sorted;
  }, [models]);

  // Scan
  const handleScan = async () => {
    if (!id) return;
    setScanning(true);
    setApplyResult(null);
    setModels((prev) => prev.map((m) => ({ ...m, status: "checking" as const })));

    const result = await api<{ commandId: string }>(`/api/primes/${id}/models/scan`, {
      method: "POST",
    });

    if (!result?.commandId) {
      setScanning(false);
      setModels((prev) => prev.map((m) => ({ ...m, status: "unknown" as const })));
      return;
    }

    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const cmd = await api<{ status: string; result?: string }>(
        `/api/primes/${id}/commands/${result.commandId}`
      );
      if (cmd?.status === "complete" && cmd.result) {
        try {
          const scanResult = JSON.parse(cmd.result);
          if (scanResult.models) {
            setModels(scanResult.models);
            setScannedAt(new Date().toISOString());
          }
          if (scanResult.currentModel) {
            setCurrentModel(scanResult.currentModel);
            if (!defaultModel) setDefaultModel(scanResult.currentModel);
          }
        } catch {
          /* ignore parse error */
        }
        break;
      }
      if (cmd?.status === "failed") break;
    }
    await loadModels();
    setScanning(false);
  };

  // Save assignments
  const handleSaveAssignments = async () => {
    if (!id) return;
    setSaving(true);
    setApplyResult(null);

    const defaultInfo = models.find((m) => m.id === defaultModel);
    const ocDefault =
      defaultInfo?.openclawId ||
      (defaultInfo?.provider === "anthropic" ? `vertex_ai/${defaultModel}` : `google-vertex/${defaultModel}`);

    const ocOverrides: Record<string, string> = {};
    for (const [agentId, modelId] of Object.entries(overrides)) {
      if (modelId && modelId !== "") {
        const info = models.find((m) => m.id === modelId);
        ocOverrides[agentId] =
          info?.openclawId ||
          (info?.provider === "anthropic" ? `vertex_ai/${modelId}` : `google-vertex/${modelId}`);
      }
    }

    const result = await api<{ success: boolean; commandId?: string; error?: string }>(
      `/api/primes/${id}/models`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: ocDefault,
          assignments: { default: ocDefault, overrides: ocOverrides },
        }),
      }
    );

    if (result?.success && result.commandId) {
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const cmd = await api<{ status: string; error?: string }>(
          `/api/primes/${id}/commands/${result.commandId}`
        );
        if (cmd?.status === "complete") {
          setCurrentModel(defaultModel);
          setApplyResult({ success: true, message: "Model assignments saved. Gateway restarting..." });
          setAssignmentsDirty(false);
          break;
        }
        if (cmd?.status === "failed") {
          setApplyResult({ success: false, message: cmd.error || "Failed to apply." });
          break;
        }
      }
    } else {
      setApplyResult({ success: false, message: result?.error || "Failed to save." });
    }
    setSaving(false);
  };

  const availableModels = models.filter((m) => m.status === "available" || m.status === "unknown");

  const modelDisplayName = (modelId: string) => {
    const m = models.find((x) => x.id === modelId);
    return m ? m.name : modelId;
  };

  const getTierClass = (tier: string) => {
    if (tier === "preview") return styles.previewTag;
    return "";
  };

  return (
    <div className={styles.modelsShell} id="prime-models-page">
      <div className={styles.modelsContainer}>
        {/* ---- Header ---- */}
        <header className={styles.modelsHeader}>
          <span className={styles.modelsHeaderIcon}>🧠</span>
          <div>
            <h1 className={styles.modelsTitle}>Models</h1>
            <div className={styles.modelsSubtitle}>
              {prime?.name || id} · AI model configuration
            </div>
          </div>
          <Link href={`/p/${id}`} className={styles.modelsBack} id="models-back-btn">
            ← Hub
          </Link>
        </header>

        {/* ---- Model Discovery ---- */}
        <section className={styles.section} id="models-discovery">
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Available Models</span>
            <button
              id="models-scan-btn"
              className="btn btn-sm btn-ghost"
              style={{ borderColor: "rgba(86,99,115,0.35)" }}
              onClick={handleScan}
              disabled={scanning || !id}
            >
              {scanning ? "⏳ Scanning..." : "↻ Scan Models"}
            </button>
          </div>

          {scannedAt && (
            <div className={styles.scannedAt}>
              Last scanned: {new Date(scannedAt).toLocaleString()}
            </div>
          )}

          {/* Empty state */}
          {models.length === 0 && !scanning && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>🔍</div>
              No models discovered yet.<br />
              Click <strong>&quot;Scan Models&quot;</strong> to probe Vertex AI for available models.<br />
              <span style={{ fontSize: 12 }}>
                Models are discovered dynamically via{" "}
                <code style={{ fontSize: 11, background: "rgba(32,40,51,0.5)", padding: "1px 4px", borderRadius: 3 }}>
                  discover-models
                </code>{" "}
                on the Prime VM.
              </span>
            </div>
          )}

          {/* Model cards grouped by provider */}
          {groupedModels.map((group) => (
            <div key={group.provider} className={styles.providerGroup}>
              <div className={styles.providerLabel}>{group.label}</div>
              <div className={styles.modelGrid}>
                {group.models.map((model) => {
                  const statusInfo = STATUS_DISPLAY[model.status] || STATUS_DISPLAY.unknown;
                  const providerColor = PROVIDER_COLORS[model.provider] || "rgba(128,128,128,0.15)";
                  const isSelected = model.id === defaultModel;

                  return (
                    <div
                      key={model.id}
                      id={`model-card-${model.id}`}
                      className={`${styles.modelCard} ${isSelected ? styles.modelCardSelected : ""} ${
                        model.status === "not_found" || model.status === "auth_error"
                          ? styles.modelCardUnavailable
                          : ""
                      }`}
                      onClick={() => {
                        if (model.status === "available" || model.status === "unknown") {
                          setDefaultModel(model.id);
                          setAssignmentsDirty(true);
                        }
                      }}
                    >
                      <div className={styles.modelCardHeader}>
                        <div>
                          <div className={styles.modelName}>
                            {model.name}
                            {model.tier && model.tier !== "standard" && (
                              <span className={`${styles.tierTag} ${getTierClass(model.tier)}`}>
                                {model.tier}
                              </span>
                            )}
                            <span
                              className={styles.providerTag}
                              style={{ background: providerColor, color: "#AEB8C4" }}
                            >
                              {model.provider}
                            </span>
                            {model.cost && <span className={styles.costTag}>{model.cost}</span>}
                          </div>
                          {model.description && (
                            <div className={styles.modelDesc}>{model.description}</div>
                          )}
                        </div>
                        <div className={styles.modelStatus} style={{ color: statusInfo.color }}>
                          <span>{statusInfo.icon}</span>
                          <span>{statusInfo.label}</span>
                        </div>
                      </div>

                      {(model.status === "not_found" || model.status === "auth_error") && (
                        <div className={styles.enableHint}>
                          <span style={{ fontSize: 12, color: "#566373" }}>
                            Enable in Google Cloud Console to use.
                          </span>
                          <a
                            href={`https://console.cloud.google.com/vertex-ai/publishers/${
                              model.provider === "anthropic" ? "anthropic" : "google"
                            }/model-garden/${model.id}?project=${projectId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.enableLink}
                            onClick={(e) => e.stopPropagation()}
                          >
                            Open in Model Garden →
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        {/* ---- Brain Agent Model Assignments ---- */}
        <section className={styles.section} id="models-assignments">
          <div className={styles.sectionTitle}>Brain Agent Models</div>
          <div className={styles.sectionDesc}>
            Tune which model each brain agent uses. Use powerful models for reasoning-heavy agents
            and cost-effective models for simple tasks. Changes apply to both Prime and Fleet.
          </div>

          {/* Default model */}
          <div className={styles.assignmentRow}>
            <div className={styles.assignmentAgent}>
              <span className={styles.assignmentIcon}>⚙️</span>
              <div>
                <div className={styles.assignmentLabel}>Default</div>
                <div className={styles.assignmentDesc}>All agents unless overridden</div>
              </div>
            </div>
            <select
              id="models-default-select"
              className="input"
              style={{ width: 280, fontSize: 13, padding: "6px 10px" }}
              value={defaultModel}
              onChange={(e) => {
                setDefaultModel(e.target.value);
                setAssignmentsDirty(true);
              }}
            >
              <option value="">— select —</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} {m.cost || ""}
                </option>
              ))}
            </select>
          </div>

          {/* Per-agent overrides */}
          {BRAIN_AGENTS.map((agent) => {
            const override = overrides[agent.id] || "";
            return (
              <div key={agent.id} className={styles.assignmentRow}>
                <div className={styles.assignmentAgent}>
                  <span className={styles.assignmentIcon}>{agent.icon}</span>
                  <div>
                    <div className={styles.assignmentLabel}>{agent.label}</div>
                    <div className={styles.assignmentDesc}>{agent.desc}</div>
                  </div>
                </div>
                <select
                  id={`models-override-${agent.id}`}
                  className="input"
                  style={{
                    width: 280,
                    fontSize: 13,
                    padding: "6px 10px",
                    color: override ? "#E6EBF0" : "#566373",
                  }}
                  value={override}
                  onChange={(e) => {
                    setOverrides((prev) => ({ ...prev, [agent.id]: e.target.value }));
                    setAssignmentsDirty(true);
                  }}
                >
                  <option value="">
                    Use default ({defaultModel ? modelDisplayName(defaultModel) : "—"})
                  </option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.cost || ""}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}

          {/* Save button */}
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
            <button
              id="models-save-btn"
              className="btn btn-primary"
              onClick={handleSaveAssignments}
              disabled={!assignmentsDirty || !defaultModel || saving}
            >
              {saving ? "Saving..." : "Save Assignments"}
            </button>
            {assignmentsDirty && <span className={styles.unsaved}>● Unsaved changes</span>}
          </div>

          {/* Result feedback */}
          {applyResult && (
            <div
              className={`${styles.alertBox} ${applyResult.success ? styles.alertSuccess : styles.alertError}`}
            >
              {applyResult.success ? "✅ " : "❌ "}
              {applyResult.message}
            </div>
          )}

          <div className={styles.footerNote}>
            ℹ️ Changes apply to both Prime and Fleet after gateway restart. Fleet agents pick up new
            models on next hire or &quot;Upgrade Fleet.&quot;
          </div>
        </section>
      </div>
    </div>
  );
}
