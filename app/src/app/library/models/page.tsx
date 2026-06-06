"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import styles from "./page.module.css";

/* ---- Types ---- */
interface ModelInfo {
  id: string;
  name: string;
  tier: string;
  provider: string;
  status: "available" | "not_found" | "auth_error" | "timeout" | "checking" | "unknown";
  httpCode?: number;
  brainModelId?: string;
  description?: string;
  cost?: string;
}

interface ModelsResponse {
  models: ModelInfo[];
  currentModel: string;
  projectId: string;
  scannedAt: string | null;
  assignments: unknown;
}

/* ---- Constants ---- */
const PROVIDER_COLORS: Record<string, string> = {
  google: "rgba(66,133,244,0.15)",
  anthropic: "rgba(217,119,87,0.15)",
  openai: "rgba(0,166,126,0.15)",
  meta: "rgba(0,128,255,0.15)",
  mistralai: "rgba(255,128,0,0.15)",
  xai: "rgba(130,100,255,0.15)",
  deepseek: "rgba(60,180,200,0.15)",
  ai21: "rgba(200,80,160,0.15)",
};

const EXTRA_COLORS = [
  "rgba(180,120,60,0.15)", "rgba(80,180,120,0.15)", "rgba(200,160,60,0.15)",
  "rgba(120,80,200,0.15)", "rgba(60,140,180,0.15)", "rgba(180,60,120,0.15)",
];

function getProviderColor(provider: string, index: number): string {
  return PROVIDER_COLORS[provider] || EXTRA_COLORS[index % EXTRA_COLORS.length];
}

const STATUS_DISPLAY: Record<string, { icon: string; label: string; color: string }> = {
  available: { icon: "✅", label: "Available", color: "#3BAA78" },
  not_found: { icon: "❌", label: "Not Available", color: "#D84F45" },
  auth_error: { icon: "🔒", label: "Needs Enablement", color: "#D6A83A" },
  timeout: { icon: "⚠️", label: "Timeout", color: "#D6A83A" },
  checking: { icon: "⏳", label: "Checking...", color: "#2F80A8" },
  unknown: { icon: "❓", label: "Not Scanned", color: "#566373" },
};

const PROVIDER_ORDER = ["google", "anthropic", "meta", "mistralai", "xai", "deepseek"];
const PROVIDER_LABELS: Record<string, string> = {
  google: "Google", anthropic: "Anthropic", openai: "OpenAI",
  meta: "Meta", mistralai: "Mistral AI", xai: "xAI",
  deepseek: "DeepSeek", ai21: "AI21", nvidia: "NVIDIA",
  writer: "Writer", "stability.ai": "Stability AI",
};

function getProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function LibraryModelsPage() {
  const { setup, primes } = usePrime();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({});

  const firstPrimeId = primes.length > 0 ? primes[0].id : null;
  const projectId = setup.projectId;

  /* ---- Load models ---- */
  const loadModels = useCallback(async () => {
    const data = await api<ModelsResponse>("/api/models");
    if (data) {
      if (data.models.length > 0) setModels(data.models);
      setScannedAt(data.scannedAt);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  /* ---- Group by provider ---- */
  const groupedModels = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const model of models) {
      const provider = model.provider || "other";
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(model);
    }
    const sorted: { provider: string; label: string; models: ModelInfo[] }[] = [];
    for (const p of PROVIDER_ORDER) {
      if (groups[p]) {
        sorted.push({ provider: p, label: getProviderLabel(p), models: groups[p] });
        delete groups[p];
      }
    }
    const remaining = Object.keys(groups).sort();
    for (const p of remaining) {
      sorted.push({ provider: p, label: getProviderLabel(p), models: groups[p] });
    }
    return sorted;
  }, [models]);

  /* ---- Scan models ---- */
  const handleScan = async () => {
    setScanning(true);
    setModels((prev) => prev.map((m) => ({ ...m, status: "checking" as const })));
    try {
      const result = await api<{
        models: ModelInfo[];
        bestModel: string;
        discovered: number;
        available: number;
        scannedAt: string;
        error?: string;
      }>("/api/models/scan", { method: "POST" });
      if (result?.models) {
        setModels(result.models);
        setScannedAt(result.scannedAt);
      } else {
        await loadModels();
      }
    } catch {
      await loadModels();
    }
    setScanning(false);
  };

  const getTierClass = (tier: string) => {
    if (tier === "preview") return styles.previewTag;
    return "";
  };

  /* ---- Counts ---- */
  const totalModels = models.length;
  const availableCount = models.filter((m) => m.status === "available").length;

  return (
    <div className={styles.modelsPage}>
      <div className={styles.modelsHeader}>
        <div>
          <h1 className={styles.modelsTitle}>Model Catalog</h1>
          <div className={styles.modelsSubtitle}>
            {totalModels} models discovered · {availableCount} available
          </div>
        </div>
        <button
          className={styles.scanBtn}
          onClick={handleScan}
          disabled={scanning || !firstPrimeId}
        >
          {scanning ? "⏳ Scanning…" : "↻ Scan Models"}
        </button>
      </div>

      {!firstPrimeId && (
        <div className={styles.alertWarning}>
          No Prime instances found. Deploy a Prime to scan for models.
        </div>
      )}

      {scannedAt && (
        <div className={styles.scannedAt}>
          Last scanned: {new Date(scannedAt).toLocaleString()}
        </div>
      )}

      {/* Empty state */}
      {models.length === 0 && !scanning && firstPrimeId && (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>🔍</div>
          No models discovered yet.<br />
          Click <strong>&quot;Scan Models&quot;</strong> to probe Vertex AI for available models.
        </div>
      )}

      {/* Model cards grouped by provider */}
      {groupedModels.map((group) => {
        const isCollapsed = collapsedProviders[group.provider] || false;
        const availCount = group.models.filter((m) => m.status === "available").length;
        return (
          <div key={group.provider} className={styles.providerGroup}>
            <button
              className={styles.providerLabel}
              onClick={() =>
                setCollapsedProviders((prev) => ({
                  ...prev,
                  [group.provider]: !prev[group.provider],
                }))
              }
            >
              <span
                style={{
                  transition: "transform 160ms",
                  transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                  display: "inline-block",
                  fontSize: 10,
                }}
              >
                ▼
              </span>
              <span>{group.label}</span>
              <span className={styles.providerCount}>
                {availCount}/{group.models.length} available
              </span>
            </button>
            {!isCollapsed && (
              <div className={styles.modelGrid}>
                {group.models.map((model) => {
                  const statusInfo = STATUS_DISPLAY[model.status] || STATUS_DISPLAY.unknown;
                  const providerColor = getProviderColor(model.provider, 0);
                  return (
                    <div
                      key={model.id}
                      className={`${styles.modelCard} ${
                        model.status === "not_found" || model.status === "auth_error"
                          ? styles.modelCardUnavailable
                          : ""
                      }`}
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
                            href={`https://console.cloud.google.com/vertex-ai/publishers/${model.provider}/model-garden/${model.id}?project=${projectId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.enableLink}
                          >
                            Open in Model Garden →
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
