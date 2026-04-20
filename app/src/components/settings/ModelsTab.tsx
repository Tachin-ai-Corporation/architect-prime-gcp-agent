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
  tier: "preview" | "ga";
  status: "available" | "not_found" | "auth_error" | "timeout" | "checking" | "unknown";
  httpCode?: number;
}

interface ModelsResponse {
  models: ModelInfo[];
  currentModel: string;
  projectId: string;
  scannedAt: string | null;
}

interface ModelsTabProps {
  activePrime: string;
  projectId: string;
}

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "gemini-3.1-pro-preview": "Latest reasoning capabilities with extended context. Best for complex orchestration.",
  "gemini-2.5-pro": "Strong reasoning with proven stability. Recommended for production workloads.",
  "gemini-2.5-flash": "Fast and cost-effective. Good for high-volume fleet operations.",
};

const STATUS_DISPLAY: Record<string, { icon: string; label: string; color: string }> = {
  available: { icon: "✅", label: "Available", color: "#3fb950" },
  not_found: { icon: "❌", label: "Not Available", color: "#f85149" },
  auth_error: { icon: "🔒", label: "Auth Error", color: "#f59e0b" },
  timeout: { icon: "⚠️", label: "Timeout", color: "#f59e0b" },
  checking: { icon: "⏳", label: "Checking...", color: "#58a6ff" },
  unknown: { icon: "❓", label: "Unknown", color: "var(--text-tertiary)" },
};

export function ModelsTab({ activePrime, projectId }: ModelsTabProps) {
  const [models, setModels] = useState<ModelInfo[]>([
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Preview)", tier: "preview", status: "unknown" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tier: "ga", status: "unknown" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "ga", status: "unknown" },
  ]);
  const [currentModel, setCurrentModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ success: boolean; message: string } | null>(null);

  // Load cached model info on mount
  const loadModels = useCallback(async () => {
    if (!activePrime) return;
    const data = await api<ModelsResponse>(`/api/primes/${activePrime}/models`);
    if (data) {
      if (data.models.length > 0) setModels(data.models);
      setCurrentModel(data.currentModel);
      setSelectedModel(data.currentModel);
      setScannedAt(data.scannedAt);
    }
  }, [activePrime]);

  useEffect(() => { loadModels(); }, [loadModels]);

  // Scan models
  const handleScan = async () => {
    if (!activePrime) return;
    setScanning(true);
    setApplyResult(null);

    // Set all models to "checking"
    setModels(prev => prev.map(m => ({ ...m, status: "checking" as const })));

    const result = await api<{ commandId: string }>(`/api/primes/${activePrime}/models/scan`, {
      method: "POST",
    });

    if (!result?.commandId) {
      setScanning(false);
      setModels(prev => prev.map(m => ({ ...m, status: "unknown" as const })));
      return;
    }

    // Poll for result
    const maxAttempts = 20;
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
            if (!selectedModel) setSelectedModel(scanResult.currentModel);
          }
        } catch { /* ignore parse errors */ }
        break;
      }
      if (cmd?.status === "failed") break;
    }
    setScanning(false);
  };

  // Apply model selection
  const handleApply = async () => {
    if (!activePrime || !selectedModel || selectedModel === currentModel) return;
    setApplying(true);
    setApplyResult(null);

    const result = await api<{ success: boolean; commandId?: string; error?: string }>(
      `/api/primes/${activePrime}/models`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: selectedModel }),
      }
    );

    if (result?.success && result.commandId) {
      // Poll for completion
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const cmd = await api<{ status: string; result?: string; error?: string }>(
          `/api/primes/${activePrime}/commands/${result.commandId}`
        );
        if (cmd?.status === "complete") {
          setCurrentModel(selectedModel);
          setApplyResult({ success: true, message: `Model updated to ${selectedModel}. Gateway restarting...` });
          break;
        }
        if (cmd?.status === "failed") {
          setApplyResult({ success: false, message: cmd.error || "Failed to apply model." });
          break;
        }
      }
    } else {
      setApplyResult({ success: false, message: result?.error || "Failed to queue model change." });
    }
    setApplying(false);
  };

  const selectedModelAvailable = models.find(m => m.id === selectedModel)?.status === "available";
  const hasChanges = selectedModel && selectedModel !== currentModel;

  return (
    <>
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>AI Models</span>
          <button
            className="btn btn-sm btn-ghost"
            style={{ borderColor: "var(--border)" }}
            onClick={handleScan}
            disabled={scanning || !activePrime}
          >
            {scanning ? "⏳ Scanning..." : "↻ Scan Models"}
          </button>
        </div>

        {currentModel && (
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
            Currently running: <code className="mono" style={{ color: "var(--accent-primary-hover)", fontSize: 12 }}>google-vertex/{currentModel}</code>
          </div>
        )}

        {scannedAt && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 16 }}>
            Last scanned: {new Date(scannedAt).toLocaleString()}
          </div>
        )}

        {/* Model cards */}
        <div className={styles["model-list"]}>
          {models.map((model) => {
            const statusInfo = STATUS_DISPLAY[model.status] || STATUS_DISPLAY.unknown;
            const isSelected = selectedModel === model.id;
            const isCurrent = currentModel === model.id;
            const isDisabled = model.status !== "available" && model.status !== "unknown";

            return (
              <div
                key={model.id}
                className={`${styles["model-card"]} ${isSelected ? styles["model-card-selected"] : ""} ${isDisabled ? styles["model-card-disabled"] : ""}`}
                onClick={() => !isDisabled && setSelectedModel(model.id)}
                role="button"
                tabIndex={0}
              >
                <div className={styles["model-card-header"]}>
                  <div className={styles["model-card-radio"]}>
                    <div className={`${styles["model-radio"]} ${isSelected ? styles["model-radio-checked"] : ""}`}>
                      {isSelected && <div className={styles["model-radio-dot"]} />}
                    </div>
                  </div>
                  <div className={styles["model-card-info"]}>
                    <div className={styles["model-card-name"]}>
                      {model.name}
                      {model.tier === "preview" && (
                        <span className={styles["model-tier-badge"]}>Preview</span>
                      )}
                      {isCurrent && (
                        <span className={styles["model-active-badge"]}>Active</span>
                      )}
                    </div>
                    <div className={styles["model-card-desc"]}>
                      {MODEL_DESCRIPTIONS[model.id] || ""}
                    </div>
                  </div>
                  <div className={styles["model-card-status"]} style={{ color: statusInfo.color }}>
                    <span>{statusInfo.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 500 }}>{statusInfo.label}</span>
                  </div>
                </div>

                {/* Enable link for 404 models */}
                {model.status === "not_found" && (
                  <div className={styles["model-card-enable"]}>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                      Not available in this project.
                    </span>
                    <a
                      href={`https://console.cloud.google.com/vertex-ai/model-garden?project=${projectId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles["model-enable-link"]}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Enable in Model Garden →
                    </a>
                  </div>
                )}

                {model.status === "auth_error" && (
                  <div className={styles["model-card-enable"]}>
                    <span style={{ fontSize: 12, color: "#f59e0b" }}>
                      Check IAM roles — need <code className="mono" style={{ fontSize: 10 }}>roles/aiplatform.user</code>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Apply button */}
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={!hasChanges || !selectedModelAvailable || applying}
          >
            {applying ? "Applying..." : "Apply as Default"}
          </button>
          {hasChanges && selectedModelAvailable && (
            <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
              Applies to Prime + all Fleet agents
            </span>
          )}
          {hasChanges && !selectedModelAvailable && (
            <span style={{ fontSize: 12, color: "#f59e0b" }}>
              ⚠️ Selected model is not available — run &quot;Scan Models&quot; to refresh
            </span>
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
          ℹ️ Fleet agents will use the new model after their next restart or re-hire.
          To update fleet agents immediately, use &quot;Upgrade Fleet&quot; from the Fleet tab.
        </div>
      </div>
    </>
  );
}
