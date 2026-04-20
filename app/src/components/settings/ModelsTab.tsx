"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "../../app/page.module.css";

async function api<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

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

interface ModelsTabProps {
  activePrime: string;
  projectId: string;
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
};

const STATUS_DISPLAY: Record<string, { icon: string; label: string; color: string }> = {
  available: { icon: "✅", label: "Available", color: "#3fb950" },
  not_found: { icon: "❌", label: "Not Available", color: "#f85149" },
  auth_error: { icon: "🔒", label: "Needs Enablement", color: "#f59e0b" },
  timeout: { icon: "⚠️", label: "Timeout", color: "#f59e0b" },
  checking: { icon: "⏳", label: "Checking...", color: "#58a6ff" },
  unknown: { icon: "❓", label: "Not Scanned", color: "var(--text-tertiary)" },
};

export function ModelsTab({ activePrime, projectId }: ModelsTabProps) {
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

  // Load cached model info + assignments on mount
  const loadModels = useCallback(async () => {
    if (!activePrime) return;
    const data = await api<ModelsResponse>(`/api/primes/${activePrime}/models`);
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
  }, [activePrime]);

  useEffect(() => { loadModels(); }, [loadModels]);

  // Scan models
  const handleScan = async () => {
    if (!activePrime) return;
    setScanning(true);
    setApplyResult(null);
    setModels(prev => prev.map(m => ({ ...m, status: "checking" as const })));

    const result = await api<{ commandId: string }>(`/api/primes/${activePrime}/models/scan`, {
      method: "POST",
    });

    if (!result?.commandId) {
      setScanning(false);
      setModels(prev => prev.map(m => ({ ...m, status: "unknown" as const })));
      return;
    }

    const maxAttempts = 60; // 60 × 2s = 120s — discovery probes 16+ models
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const cmd = await api<{ status: string; result?: string }>(`/api/primes/${activePrime}/commands/${result.commandId}`);
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
        } catch { /* ignore */ }
        break;
      }
      if (cmd?.status === "failed") break;
    }
    // Always re-fetch from Firestore to pick up newly discovered catalog
    await loadModels();
    setScanning(false);
  };

  // Save assignments
  const handleSaveAssignments = async () => {
    if (!activePrime) return;
    setSaving(true);
    setApplyResult(null);

    // Build the OpenClaw model ID for the default
    const defaultInfo = models.find(m => m.id === defaultModel);
    const ocDefault = defaultInfo?.openclawId ||
      (defaultInfo?.provider === "anthropic" ? `vertex_ai/${defaultModel}` : `google-vertex/${defaultModel}`);

    // Build overrides with OpenClaw IDs
    const ocOverrides: Record<string, string> = {};
    for (const [agentId, modelId] of Object.entries(overrides)) {
      if (modelId && modelId !== "") {
        const info = models.find(m => m.id === modelId);
        ocOverrides[agentId] = info?.openclawId ||
          (info?.provider === "anthropic" ? `vertex_ai/${modelId}` : `google-vertex/${modelId}`);
      }
    }

    const result = await api<{ success: boolean; commandId?: string; error?: string }>(
      `/api/primes/${activePrime}/models`,
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
        await new Promise(r => setTimeout(r, 2000));
        const cmd = await api<{ status: string; error?: string }>(
          `/api/primes/${activePrime}/commands/${result.commandId}`
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

  const availableModels = models.filter(m => m.status === "available" || m.status === "unknown");

  // Helper to get display name from model id
  const modelDisplayName = (modelId: string) => {
    const m = models.find(x => x.id === modelId);
    return m ? m.name : modelId;
  };

  return (
    <>
      {/* Model Discovery */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Available Models</span>
          <button
            className="btn btn-sm btn-ghost"
            style={{ borderColor: "var(--border)" }}
            onClick={handleScan}
            disabled={scanning || !activePrime}
          >
            {scanning ? "⏳ Scanning..." : "↻ Scan Models"}
          </button>
        </div>

        {scannedAt && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
            Last scanned: {new Date(scannedAt).toLocaleString()}
          </div>
        )}

        {/* Empty state */}
        {models.length === 0 && !scanning && (
          <div style={{
            padding: 24, textAlign: "center", borderRadius: 8,
            border: "1px dashed var(--border)", color: "var(--text-tertiary)",
            fontSize: 14, lineHeight: 1.8,
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
            No models discovered yet.<br />
            Click <strong>&quot;Scan Models&quot;</strong> to probe Vertex AI for available models.<br />
            <span style={{ fontSize: 12 }}>
              The model catalog is loaded from <code className="mono" style={{ fontSize: 11 }}>model-catalog.json</code> on the Prime VM.
            </span>
          </div>
        )}

        {/* Model cards */}
        <div className={styles["model-list"]}>
          {models.map((model) => {
            const statusInfo = STATUS_DISPLAY[model.status] || STATUS_DISPLAY.unknown;
            const providerColor = PROVIDER_COLORS[model.provider] || "rgba(128,128,128,0.15)";

            return (
              <div key={model.id} className={styles["model-card"]} style={{ cursor: "default" }}>
                <div className={styles["model-card-header"]}>
                  <div className={styles["model-card-info"]}>
                    <div className={styles["model-card-name"]}>
                      {model.name}
                      {model.tier === "preview" && (
                        <span className={styles["model-tier-badge"]}>Preview</span>
                      )}
                      <span style={{
                        fontSize: 9, fontWeight: 600, padding: "2px 5px",
                        borderRadius: 3, background: providerColor,
                        color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>
                        {model.provider}
                      </span>
                      {model.cost && (
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500 }}>{model.cost}</span>
                      )}
                    </div>
                    <div className={styles["model-card-desc"]}>
                      {model.description || ""}
                    </div>
                  </div>
                  <div className={styles["model-card-status"]} style={{ color: statusInfo.color }}>
                    <span>{statusInfo.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 500 }}>{statusInfo.label}</span>
                  </div>
                </div>

                {(model.status === "not_found" || model.status === "auth_error") && (
                  <div className={styles["model-card-enable"]}>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                      Enable in Google Cloud Console to use.
                    </span>
                    <a
                      href={`https://console.cloud.google.com/vertex-ai/publishers/${model.provider === "anthropic" ? "anthropic" : "google"}/model-garden/${model.id}?project=${projectId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles["model-enable-link"]}
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

      {/* Brain Agent Model Assignments */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Brain Agent Models</div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.5 }}>
          Tune which model each brain agent uses. Use powerful models for reasoning-heavy agents
          and cost-effective models for simple tasks. Changes apply to both Prime and Fleet.
        </p>

        {/* Default model */}
        <div className={styles["settings-row"]} style={{ alignItems: "center" }}>
          <div className={styles["settings-label"]} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚙️</span>
            <div>
              <div style={{ fontWeight: 600 }}>Default</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 400 }}>All agents unless overridden</div>
            </div>
          </div>
          <div className={styles["settings-value"]}>
            <select
              className="input"
              style={{ width: 280, fontSize: 13, padding: "6px 10px" }}
              value={defaultModel}
              onChange={(e) => { setDefaultModel(e.target.value); setAssignmentsDirty(true); }}
            >
              <option value="">— select —</option>
              {availableModels.map(m => (
                <option key={m.id} value={m.id}>{m.name} {m.cost || ""}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Per-agent overrides */}
        <div style={{ borderTop: "1px solid var(--border-subtle)", marginTop: 8 }}>
          {BRAIN_AGENTS.map((agent) => {
            const override = overrides[agent.id] || "";
            return (
              <div key={agent.id} className={styles["settings-row"]} style={{ alignItems: "center", paddingTop: 8, paddingBottom: 8 }}>
                <div className={styles["settings-label"]} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 15 }}>{agent.icon}</span>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{agent.label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 400 }}>{agent.desc}</div>
                  </div>
                </div>
                <div className={styles["settings-value"]}>
                  <select
                    className="input"
                    style={{ width: 280, fontSize: 13, padding: "6px 10px", color: override ? "var(--text-primary)" : "var(--text-tertiary)" }}
                    value={override}
                    onChange={(e) => {
                      setOverrides(prev => ({ ...prev, [agent.id]: e.target.value }));
                      setAssignmentsDirty(true);
                    }}
                  >
                    <option value="">Use default ({defaultModel ? modelDisplayName(defaultModel) : "—"})</option>
                    {availableModels.map(m => (
                      <option key={m.id} value={m.id}>{m.name} {m.cost || ""}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>

        {/* Save button */}
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="btn btn-primary"
            onClick={handleSaveAssignments}
            disabled={!assignmentsDirty || !defaultModel || saving}
          >
            {saving ? "Saving..." : "Save Assignments"}
          </button>
          {assignmentsDirty && (
            <span style={{ fontSize: 12, color: "#f59e0b" }}>● Unsaved changes</span>
          )}
        </div>

        {/* Result feedback */}
        {applyResult && (
          <div style={{
            marginTop: 12, padding: 12, borderRadius: 6, fontSize: 13, lineHeight: 1.5,
            background: applyResult.success ? "rgba(46, 160, 67, 0.15)" : "rgba(248, 81, 73, 0.15)",
            border: `1px solid ${applyResult.success ? "rgba(46, 160, 67, 0.4)" : "rgba(248, 81, 73, 0.4)"}`,
            color: applyResult.success ? "#3fb950" : "#f85149",
          }}>
            {applyResult.success ? "✅ " : "❌ "}{applyResult.message}
          </div>
        )}

        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 16, lineHeight: 1.6 }}>
          ℹ️ Changes apply to both Prime and Fleet after gateway restart.
          Fleet agents pick up new models on next hire or &quot;Upgrade Fleet.&quot;
        </div>
      </div>
    </>
  );
}
