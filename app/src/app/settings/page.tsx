"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";

type SettingsTab = "general" | "integration" | "security" | "models" | "system";

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "⚙️" },
  { id: "integration", label: "Integration", icon: "🔗" },
  { id: "security", label: "Security", icon: "🔐" },
  { id: "models", label: "Models", icon: "🧠" },
  { id: "system", label: "System", icon: "🖥️" },
];

/* ---- Model types & constants ---- */
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

interface ModelsResponse {
  models: ModelInfo[];
  currentModel: string;
  projectId: string;
  scannedAt: string | null;
  assignments: unknown;
}

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

export default function DashboardSettingsPage() {
  const { setup, versionInfo, primes, sidebarFleet } = usePrime();
  const dialog = useDialog();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  // Read ?tab= query param on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab && TABS.find((t) => t.id === tab)) {
      setActiveTab(tab as SettingsTab);
    }
  }, []);

  // DWD test state
  const [dwdTestEmail, setDwdTestEmail] = useState("");
  const [dwdTesting, setDwdTesting] = useState(false);
  const [dwdTestResult, setDwdTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
    hint?: string;
  } | null>(null);

  // OAuth state
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [oauthDomain, setOauthDomain] = useState("");
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthResult, setOauthResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // System state
  const [upgrading, setUpgrading] = useState(false);
  const [buildStatus, setBuildStatus] = useState<string | null>(null);

  // Models state
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const firstPrimeId = primes.length > 0 ? primes[0].id : null;
  const projectId = setup.projectId;

  // Load models
  const loadModels = useCallback(async () => {
    if (!firstPrimeId) return;
    const data = await api<ModelsResponse>(`/api/primes/${firstPrimeId}/models`);
    if (data) {
      if (data.models.length > 0) setModels(data.models);
      setScannedAt(data.scannedAt);
    }
  }, [firstPrimeId]);

  // Load models when switching to models tab
  useEffect(() => {
    if (activeTab === "models") {
      loadModels();
    }
  }, [activeTab, loadModels]);

  // Group models by provider
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
        sorted.push({ provider: p, label: PROVIDER_LABELS[p] || p, models: groups[p] });
        delete groups[p];
      }
    }
    for (const [p, m] of Object.entries(groups)) {
      sorted.push({ provider: p, label: p.charAt(0).toUpperCase() + p.slice(1), models: m });
    }
    return sorted;
  }, [models]);

  // Scan models
  const handleScan = async () => {
    if (!firstPrimeId) return;
    setScanning(true);
    setModels((prev) => prev.map((m) => ({ ...m, status: "checking" as const })));

    const result = await api<{ commandId: string }>(`/api/primes/${firstPrimeId}/models/scan`, {
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
        `/api/primes/${firstPrimeId}/commands/${result.commandId}`
      );
      if (cmd?.status === "complete" && cmd.result) {
        try {
          const scanResult = JSON.parse(cmd.result);
          if (scanResult.models) {
            setModels(scanResult.models);
            setScannedAt(new Date().toISOString());
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

  const getTierClass = (tier: string) => {
    if (tier === "preview") return styles.previewTag;
    return "";
  };

  // Clipboard
  const [copied, setCopied] = useState("");
  const copyToClipboard = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  }, []);

  /* ---- DWD Test ---- */
  const handleDwdTest = async () => {
    if (!dwdTestEmail.trim()) return;
    setDwdTesting(true);
    setDwdTestResult(null);
    const result = await api<{ success: boolean; message?: string; error?: string; hint?: string }>(
      "/api/setup/dwd-test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: dwdTestEmail.trim() }),
      }
    );
    setDwdTestResult(result || { success: false, error: "Request failed" });
    setDwdTesting(false);
  };

  /* ---- OAuth Save ---- */
  const handleOauthSave = async () => {
    if (!clientId || !clientSecret) {
      setOauthResult({ ok: false, msg: "Client ID and Client Secret are required" });
      return;
    }
    setOauthSaving(true);
    setOauthResult(null);
    const result = await api<{ success: boolean; error?: string }>(
      "/api/setup/oauth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, domain: oauthDomain }),
      }
    );
    if (result?.success) {
      setOauthResult({ ok: true, msg: "OAuth configured! Dashboard will restart in ~30s." });
    } else {
      setOauthResult({ ok: false, msg: result?.error || "Failed to configure OAuth" });
    }
    setOauthSaving(false);
  };

  /* ---- System Upgrade ---- */
  const handleUpgrade = async () => {
    setUpgrading(true);
    setBuildStatus("Submitting build...");
    const result = await api<{
      success: boolean;
      message?: string;
      error?: string;
      buildId?: string;
      version?: string;
    }>("/api/upgrade", { method: "POST" });

    if (result?.success && result.buildId) {
      setBuildStatus(`Build ${result.buildId.substring(0, 8)} submitted. Polling for status...`);
      dialog.toast({ message: result.message || "Dashboard upgrade initiated!", variant: "success", duration: 6000 });

      // Poll Cloud Build status every 5s
      const pollBuild = async () => {
        try {
          const status = await api<{
            buildId: string;
            status: string;
            progress: number;
            activeStep: string | null;
            failedStep: string | null;
            doneSteps: number;
            totalSteps: number;
            steps?: Array<{ label: string; status: string; startTime?: string; endTime?: string }>;
            startTime?: string | null;
          }>(`/api/upgrade/status?buildId=${result.buildId}`);

          if (!status) {
            setBuildStatus("Failed to check build status.");
            setUpgrading(false);
            return;
          }

          if (status.status === "SUCCESS") {
            setBuildStatus("✅ Deploy complete! Refreshing in 5s...");
            setUpgrading(false);
            setTimeout(() => window.location.reload(), 5000);
            return;
          }

          if (status.status === "FAILURE" || status.status === "TIMEOUT" || status.status === "CANCELLED") {
            setBuildStatus(`❌ Build ${status.status.toLowerCase()}${status.failedStep ? ` at: ${status.failedStep}` : ""}`);
            setUpgrading(false);
            return;
          }

          // QUEUED vs WORKING display
          if (status.status === "QUEUED") {
            setBuildStatus("⏳ Build queued — waiting for Cloud Build to start...");
          } else {
            // WORKING — show step progress
            const stepLabel = status.activeStep
              ? `⏳ ${status.activeStep}`
              : `${status.doneSteps}/${status.totalSteps} steps`;
            const elapsed = status.startTime
              ? ` (${Math.round((Date.now() - new Date(status.startTime).getTime()) / 1000)}s)`
              : "";
            setBuildStatus(`Building... ${status.progress}% — ${stepLabel}${elapsed}`);
          }

          // Continue polling
          setTimeout(pollBuild, 5000);
        } catch {
          setBuildStatus("Error polling build status. Build may still be running.");
          setUpgrading(false);
        }
      };

      // Start polling after a short delay (build needs time to initialize)
      setTimeout(pollBuild, 3000);
    } else if (result?.success) {
      // No buildId returned — fallback message
      setBuildStatus("Build submitted. Dashboard will update automatically.");
      setTimeout(() => {
        setBuildStatus(null);
        setUpgrading(false);
      }, 10000);
    } else {
      dialog.toast({ message: result?.error || "Upgrade failed", variant: "error" });
      setBuildStatus(null);
      setUpgrading(false);
    }
  };

  const fleetCount = Object.values(sidebarFleet).flat().filter((a) => a.status !== "removed").length;

  return (
    <div className={styles.settingsShell} id="dashboard-settings-page">
      <div className={styles.settingsContainer}>
        {/* ---- Header ---- */}
        <header className={styles.settingsHeader}>
          <span className={styles.settingsHeaderIcon}>⚙️</span>
          <div>
            <h1 className={styles.settingsTitle}>Settings</h1>
            <div className={styles.settingsSubtitle}>Dashboard configuration</div>
          </div>
          <Link href="/" className={styles.settingsBack} id="settings-back-btn">
            ← Home
          </Link>
        </header>

        {/* ---- Tab Bar ---- */}
        <nav className={styles.tabBar} id="settings-tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={styles.tabIcon}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>

        {/* ---- Tab Content ---- */}
        <div className={styles.tabContent}>
          {/* ==== General Tab ==== */}
          {activeTab === "general" && (
            <>
              {/* Project Info */}
              <section className={styles.section} id="settings-project-info">
                <div className={styles.sectionTitle}>Project Info</div>
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>GCP Project</span>
                  <span className={styles.fieldValue}>{setup.projectId || "—"}</span>
                </div>
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>DWD Signer SA</span>
                  <span className={styles.fieldValue}>{setup.dwdSignerSA || "—"}</span>
                </div>
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>Prime Instances</span>
                  <span className={styles.fieldValue}>{primes.length}</span>
                </div>
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>Fleet Agents</span>
                  <span className={styles.fieldValue}>{fleetCount}</span>
                </div>
              </section>

              {/* Agent Defaults */}
              <section className={styles.section} id="settings-agent-defaults">
                <div className={styles.sectionTitle}>Agent Defaults</div>
                <div className={styles.sectionDesc}>
                  Configure defaults that apply to all new fleet agents.
                </div>
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>Agent Email Domain</span>
                  <span className={styles.fieldValue}>{setup.agentEmailDomain || "—"}</span>
                </div>
                <div style={{ fontSize: 11, color: "#566373", marginTop: 4 }}>
                  When set, agent emails auto-fill as{" "}
                  <code style={{ fontSize: 10, background: "rgba(32,40,51,0.5)", padding: "1px 4px", borderRadius: 3 }}>
                    specialty-agent-name@domain
                  </code>{" "}
                  during hire.
                </div>
              </section>
            </>
          )}

          {/* ==== Integration Tab ==== */}
          {activeTab === "integration" && (
            <>
              {/* DWD */}
              <section className={styles.section} id="settings-dwd">
                <div className={styles.sectionTitle}>
                  Domain-Wide Delegation
                  <span
                    className={`${styles.badge} ${setup.dwdConfigured ? styles.badgeSuccess : styles.badgeWarning}`}
                  >
                    {setup.dwdConfigured ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className={styles.sectionDesc}>
                  DWD allows fleet agents to send and receive Google Chat messages using their Workspace email.
                  This is a <strong>one-time setup</strong> in Google Admin Console.
                </div>

                {/* Copy values */}
                <div className={styles.copyRow}>
                  <span className={styles.copyLabel}>Client ID</span>
                  <span className={styles.copyValue}>{setup.dwdClientId || "Loading..."}</span>
                  <button
                    className={styles.copyBtn}
                    id="settings-copy-client-id"
                    onClick={() => copyToClipboard(setup.dwdClientId || "", "clientId")}
                  >
                    {copied === "clientId" ? "✓" : "Copy"}
                  </button>
                </div>
                <div className={styles.copyRow}>
                  <span className={styles.copyLabel}>OAuth Scopes</span>
                  <span className={styles.copyValue}>
                    https://www.googleapis.com/auth/chat.messages, https://www.googleapis.com/auth/chat.spaces
                  </span>
                  <button
                    className={styles.copyBtn}
                    id="settings-copy-scopes"
                    onClick={() =>
                      copyToClipboard(
                        "https://www.googleapis.com/auth/chat.messages, https://www.googleapis.com/auth/chat.spaces",
                        "scopes"
                      )
                    }
                  >
                    {copied === "scopes" ? "✓" : "Copy"}
                  </button>
                </div>

                <ol className={styles.steps}>
                  <li>
                    Open{" "}
                    <a href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener noreferrer">
                      Workspace Admin → Security → API Controls → DWD
                    </a>
                  </li>
                  <li>Click <strong>&quot;Add new&quot;</strong></li>
                  <li>Paste the <strong>Client ID</strong> above</li>
                  <li>Paste the <strong>OAuth Scopes</strong> above</li>
                  <li>Click <strong>&quot;Authorize&quot;</strong></li>
                </ol>

                {/* DWD Test */}
                <div style={{ marginTop: 20, padding: 16, background: "rgba(32,40,51,0.5)", borderRadius: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#E6EBF0", marginBottom: 8 }}>
                    Test DWD Configuration
                  </div>
                  <div style={{ fontSize: 12, color: "#566373", marginBottom: 12 }}>
                    Enter a Workspace email to verify DWD is working.
                  </div>
                  <div className={styles.inputRow}>
                    <input
                      id="settings-dwd-test-email"
                      className="input"
                      placeholder="e.g. devops-stan@yourcompany.com"
                      value={dwdTestEmail}
                      onChange={(e) => setDwdTestEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDwdTest(); }}
                      style={{ flex: 1 }}
                    />
                    <button
                      id="settings-dwd-test-btn"
                      className="btn btn-primary"
                      onClick={handleDwdTest}
                      disabled={!dwdTestEmail.trim() || dwdTesting}
                    >
                      {dwdTesting ? "Testing..." : "Test DWD"}
                    </button>
                  </div>
                  {dwdTestResult && (
                    <div className={`${styles.alertBox} ${dwdTestResult.success ? styles.alertSuccess : styles.alertError}`}>
                      {dwdTestResult.success ? "✅ " : "❌ "}
                      {dwdTestResult.message || dwdTestResult.error}
                      {dwdTestResult.hint && (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#AEB8C4" }}>💡 {dwdTestResult.hint}</div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {/* ==== Security Tab ==== */}
          {activeTab === "security" && (
            <section className={styles.section} id="settings-security">
              <div className={styles.sectionTitle}>🔐 Authentication</div>

              {process.env.NEXT_PUBLIC_AUTH_CONFIGURED === "true" ? (
                <div className={`${styles.alertBox} ${styles.alertSuccess}`}>
                  <strong>✓ Google OAuth is configured</strong>
                  <div style={{ marginTop: 4, fontSize: 12, color: "#AEB8C4" }}>
                    Users must sign in with a Google Workspace account to access this dashboard.
                  </div>
                </div>
              ) : (
                <>
                  <div className={`${styles.alertBox} ${styles.alertWarning}`} style={{ marginTop: 0 }}>
                    <strong>⚠ Authentication not configured</strong>
                    <div style={{ marginTop: 4, fontSize: 12, color: "#AEB8C4" }}>
                      This dashboard is currently accessible without login.
                    </div>
                  </div>

                  <div style={{ marginTop: 16 }}>
                    <div className={styles.sectionTitle} style={{ fontSize: 14 }}>Setup Guide</div>
                    <ol className={styles.steps}>
                      <li>
                        Go to{" "}
                        <a
                          href={`https://console.cloud.google.com/apis/credentials/consent?project=${setup.projectId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          OAuth consent screen
                        </a>{" "}
                        → Choose <strong>Internal</strong> → Save
                      </li>
                      <li>
                        Go to{" "}
                        <a
                          href={`https://console.cloud.google.com/apis/credentials?project=${setup.projectId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Credentials
                        </a>{" "}
                        → <strong>Create Credentials</strong> → <strong>OAuth client ID</strong>
                      </li>
                      <li>
                        Add redirect URI:{" "}
                        <code style={{ fontSize: 11, background: "rgba(32,40,51,0.5)", padding: "2px 6px", borderRadius: 3 }}>
                          {typeof window !== "undefined" ? window.location.origin : ""}/api/auth/callback/google
                        </code>
                      </li>
                      <li>Copy the Client ID and Client Secret below</li>
                    </ol>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
                    <label style={{ fontSize: 12, color: "#AEB8C4", fontWeight: 500 }}>OAuth Client ID</label>
                    <input
                      id="settings-oauth-client-id"
                      className="input"
                      type="text"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="123456789-abc.apps.googleusercontent.com"
                    />
                    <label style={{ fontSize: 12, color: "#AEB8C4", fontWeight: 500 }}>OAuth Client Secret</label>
                    <input
                      id="settings-oauth-client-secret"
                      className="input"
                      type="password"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder="GOCSPX-..."
                    />
                    <label style={{ fontSize: 12, color: "#AEB8C4", fontWeight: 500 }}>Allowed Domain (optional)</label>
                    <input
                      id="settings-oauth-domain"
                      className="input"
                      type="text"
                      value={oauthDomain}
                      onChange={(e) => setOauthDomain(e.target.value)}
                      placeholder="tachin.ag"
                    />
                    <button
                      id="settings-oauth-save-btn"
                      className="btn btn-primary"
                      onClick={handleOauthSave}
                      disabled={oauthSaving || !clientId || !clientSecret}
                      style={{ alignSelf: "flex-start" }}
                    >
                      {oauthSaving ? "Saving..." : "🔐 Configure OAuth & Restart"}
                    </button>
                  </div>

                  {oauthResult && (
                    <div className={`${styles.alertBox} ${oauthResult.ok ? styles.alertSuccess : styles.alertError}`}>
                      {oauthResult.msg}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {/* ==== Models Tab ==== */}
          {activeTab === "models" && (
            <section className={styles.section} id="settings-models">
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>Available Models</span>
                <button
                  id="settings-models-scan-btn"
                  className="btn btn-sm btn-ghost"
                  style={{ borderColor: "rgba(86,99,115,0.35)" }}
                  onClick={handleScan}
                  disabled={scanning || !firstPrimeId}
                >
                  {scanning ? "⏳ Scanning..." : "↻ Scan Models"}
                </button>
              </div>

              {!firstPrimeId && (
                <div className={`${styles.alertBox} ${styles.alertWarning}`} style={{ marginTop: 0 }}>
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

                      return (
                        <div
                          key={model.id}
                          id={`settings-model-card-${model.id}`}
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
                                href={`https://console.cloud.google.com/vertex-ai/publishers/${
                                  model.provider === "anthropic" ? "anthropic" : "google"
                                }/model-garden/${model.id}?project=${projectId}`}
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
                </div>
              ))}
            </section>
          )}

          {/* ==== System Tab ==== */}
          {activeTab === "system" && (
            <section className={styles.section} id="settings-system">
              <div className={styles.sectionTitle}>Version & Upgrade</div>

              {versionInfo ? (
                <>
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>Deployed Version</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={styles.fieldValue}>{versionInfo.deployedVersion}</span>
                      <span
                        className={`${styles.badge} ${versionInfo.deployedStable ? styles.badgeSuccess : styles.badgeWarning}`}
                      >
                        {versionInfo.deployedStable ? "Stable" : "Unstable"}
                      </span>
                    </span>
                  </div>
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>Latest Version</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={styles.fieldValue}>{versionInfo.latestVersion}</span>
                      <span
                        className={`${styles.badge} ${versionInfo.latestStable ? styles.badgeSuccess : styles.badgeWarning}`}
                      >
                        {versionInfo.latestStable ? "Stable" : "Unstable"}
                      </span>
                    </span>
                  </div>

                  {buildStatus && (
                    <div className={styles.buildStatus}>
                      {upgrading && <span className="cmd-progress-spinner" />}
                      <span>{buildStatus}</span>
                    </div>
                  )}

                  <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      id="settings-upgrade-btn"
                      className="btn btn-primary"
                      onClick={handleUpgrade}
                      disabled={upgrading}
                    >
                      {upgrading
                        ? "Upgrading..."
                        : versionInfo.updateAvailable
                          ? "⬆ Upgrade Dashboard"
                          : "↻ Redeploy Dashboard"}
                    </button>
                    {versionInfo.updateAvailable && !upgrading && (
                      <span style={{ fontSize: 12, color: "#D6A83A" }}>
                        Update available: {versionInfo.latestVersion}
                      </span>
                    )}
                    {!versionInfo.updateAvailable && !upgrading && (
                      <span style={{ fontSize: 12, color: "#566373" }}>
                        Up to date — redeploy will rebuild from main
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ color: "#AEB8C4", fontSize: 13 }}>Loading version info...</div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
