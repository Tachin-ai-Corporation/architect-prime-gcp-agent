"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";

type SettingsTab = "general" | "integration" | "security" | "secrets" | "system";

interface SecretData {
  name: string;
  description: string;
  secretManagerName: string;
  createdAt: string | null;
  createdBy: string;
  grants: { agentEmail: string; serviceAccount: string; grantedAt: string | null; grantedBy: string }[];
}

interface FleetAgentInfo {
  name: string;
  email: string;
  specialty: string;
  primeId: string;
}

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "⚙️" },
  { id: "integration", label: "Integration", icon: "🔗" },
  { id: "security", label: "Security", icon: "🔐" },
  { id: "secrets", label: "Secrets", icon: "🔑" },
  { id: "system", label: "System", icon: "🖥️" },
];



function SettingsPageInner() {
  const { setup, versionInfo, primes, sidebarFleet } = usePrime();
  const dialog = useDialog();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [activeTab, setActiveTabState] = useState<SettingsTab>(
    tabParam && TABS.find((t) => t.id === tabParam) ? (tabParam as SettingsTab) : "general"
  );

  const setActiveTab = useCallback((tab: SettingsTab) => {
    setActiveTabState(tab);
    window.history.replaceState(null, "", `/settings?tab=${tab}`);
  }, []);

  // Agent email domain editing state
  const [emailDomain, setEmailDomain] = useState(setup.agentEmailDomain || "");
  const [domainSaving, setDomainSaving] = useState(false);
  const [domainSaved, setDomainSaved] = useState(false);

  // Artifacts root folder editing state
  const [artifactsFolder, setArtifactsFolder] = useState(setup.artifactsRootFolderId || "");
  const [artifactsSaving, setArtifactsSaving] = useState(false);
  const [artifactsSaved, setArtifactsSaved] = useState(false);

  // Sync local state when setup loads from context
  useEffect(() => {
    if (setup.agentEmailDomain) setEmailDomain(setup.agentEmailDomain);
  }, [setup.agentEmailDomain]);

  useEffect(() => {
    if (setup.artifactsRootFolderId) setArtifactsFolder(setup.artifactsRootFolderId);
  }, [setup.artifactsRootFolderId]);

  const handleSaveDomain = useCallback(async () => {
    setDomainSaving(true);
    setDomainSaved(false);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentEmailDomain: emailDomain.trim() }),
      });
      if (res.ok) {
        setDomainSaved(true);
        setTimeout(() => setDomainSaved(false), 2500);
      }
    } catch { /* ignore */ }
    setDomainSaving(false);
  }, [emailDomain]);

  const handleSaveArtifactsFolder = useCallback(async () => {
    setArtifactsSaving(true);
    setArtifactsSaved(false);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactsRootFolderId: artifactsFolder.trim() }),
      });
      if (res.ok) {
        setArtifactsSaved(true);
        setTimeout(() => setArtifactsSaved(false), 2500);
      }
    } catch { /* ignore */ }
    setArtifactsSaving(false);
  }, [artifactsFolder]);

  // ---- Secrets state ----
  const [secrets, setSecrets] = useState<SecretData[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [showCreateSecret, setShowCreateSecret] = useState(false);
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretDesc, setNewSecretDesc] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretCreating, setSecretCreating] = useState(false);
  const [expandedSecret, setExpandedSecret] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");
  const [rotateLoading, setRotateLoading] = useState(false);
  const [allFleetAgents, setAllFleetAgents] = useState<FleetAgentInfo[]>([]);
  const [grantLoading, setGrantLoading] = useState<string | null>(null);

  const loadSecrets = useCallback(async () => {
    setSecretsLoading(true);
    try {
      const res = await fetch("/api/secrets");
      if (res.ok) {
        const data = await res.json();
        setSecrets(data.secrets || []);
      }
    } catch { /* ignore */ }
    setSecretsLoading(false);
  }, []);

  // Load secrets when tab activates
  useEffect(() => {
    if (activeTab === "secrets") {
      loadSecrets();
      // Also build flat list of all fleet agents across all primes
      const agents: FleetAgentInfo[] = [];
      for (const [primeId, fleet] of Object.entries(sidebarFleet || {})) {
        for (const agent of fleet as Array<{ name: string; email: string; specialty: string }>) {
          if (agent.email) {
            agents.push({ name: agent.name, email: agent.email, specialty: agent.specialty, primeId });
          }
        }
      }
      setAllFleetAgents(agents);
    }
  }, [activeTab, loadSecrets, sidebarFleet]);

  const handleCreateSecret = useCallback(async () => {
    if (!newSecretName || !newSecretValue) return;
    setSecretCreating(true);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newSecretName.trim(), description: newSecretDesc.trim(), value: newSecretValue }),
      });
      if (res.ok) {
        dialog.toast({ message: `Secret '${newSecretName}' created`, variant: "success" });
        setNewSecretName(""); setNewSecretDesc(""); setNewSecretValue("");
        setShowCreateSecret(false);
        loadSecrets();
      } else {
        const err = await res.json();
        dialog.toast({ message: err.error || "Failed to create secret", variant: "error" });
      }
    } catch { dialog.toast({ message: "Failed to create secret", variant: "error" }); }
    setSecretCreating(false);
  }, [newSecretName, newSecretDesc, newSecretValue, dialog, loadSecrets]);

  const handleDeleteSecret = useCallback(async (name: string) => {
    const ok = await dialog.confirm({
      title: "Delete Secret",
      message: `Permanently delete '${name}'? This revokes all agent access and destroys the secret value.`,
      confirmText: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) {
        dialog.toast({ message: `Secret '${name}' deleted`, variant: "success" });
        loadSecrets();
      } else {
        dialog.toast({ message: "Failed to delete secret", variant: "error" });
      }
    } catch { dialog.toast({ message: "Failed to delete secret", variant: "error" }); }
  }, [dialog, loadSecrets]);

  const handleRotateSecret = useCallback(async (name: string) => {
    if (!rotateValue) return;
    setRotateLoading(true);
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: rotateValue }),
      });
      if (res.ok) {
        dialog.toast({ message: `Secret '${name}' rotated`, variant: "success" });
        setRotateTarget(null); setRotateValue("");
      } else {
        dialog.toast({ message: "Failed to rotate secret", variant: "error" });
      }
    } catch { dialog.toast({ message: "Failed to rotate secret", variant: "error" }); }
    setRotateLoading(false);
  }, [rotateValue, dialog]);

  const handleGrantAccess = useCallback(async (secretName: string, agentEmail: string) => {
    setGrantLoading(`${secretName}:${agentEmail}`);
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(secretName)}/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentEmail }),
      });
      if (res.ok) {
        dialog.toast({ message: `Access granted to ${agentEmail}`, variant: "success" });
        loadSecrets();
      } else {
        const err = await res.json();
        dialog.toast({ message: err.error || "Failed to grant access", variant: "error" });
      }
    } catch { dialog.toast({ message: "Failed to grant access", variant: "error" }); }
    setGrantLoading(null);
  }, [dialog, loadSecrets]);

  const handleRevokeAccess = useCallback(async (secretName: string, agentEmail: string) => {
    setGrantLoading(`${secretName}:${agentEmail}`);
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(secretName)}/grants/${encodeURIComponent(agentEmail)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        dialog.toast({ message: `Access revoked from ${agentEmail}`, variant: "success" });
        loadSecrets();
      } else {
        dialog.toast({ message: "Failed to revoke access", variant: "error" });
      }
    } catch { dialog.toast({ message: "Failed to revoke access", variant: "error" }); }
    setGrantLoading(null);
  }, [dialog, loadSecrets]);

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

  const firstPrimeId = primes.length > 0 ? primes[0].id : null;



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
      region?: string;
    }>("/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primeId: firstPrimeId }),
    });

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
          }>(`/api/upgrade/status?buildId=${result.buildId}${result.region ? `&region=${result.region}` : ""}`);

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
                <div className={styles.fieldRow} style={{ alignItems: "center" }}>
                  <span className={styles.fieldLabel}>Agent Email Domain</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      id="settings-email-domain-input"
                      className="input"
                      style={{ width: 220, fontSize: 13 }}
                      placeholder="e.g. yourcompany.com"
                      value={emailDomain}
                      onChange={(e) => setEmailDomain(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter") handleSaveDomain();
                      }}
                    />
                    <button
                      id="settings-email-domain-save"
                      className="btn btn-sm btn-primary"
                      onClick={handleSaveDomain}
                      disabled={domainSaving}
                    >
                      {domainSaving ? "Saving..." : "Save"}
                    </button>
                    {domainSaved && (
                      <span style={{ color: "#3BAA78", fontSize: 12, fontWeight: 500 }}>✓ Saved</span>
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#566373", marginTop: 4 }}>
                  When set, agent emails auto-fill as{" "}
                  <code style={{ fontSize: 10, background: "rgba(32,40,51,0.5)", padding: "1px 4px", borderRadius: 3 }}>
                    specialty-agent-name@domain
                  </code>{" "}
                  during hire.
                </div>
                </section>

              {/* Artifacts */}
              <section className={styles.section} id="settings-artifacts">
                <div className={styles.sectionTitle}>
                  Artifacts
                  <span
                    className={`${styles.badge} ${artifactsFolder ? styles.badgeSuccess : styles.badgeWarning}`}
                  >
                    {artifactsFolder ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className={styles.sectionDesc}>
                  Configure the Google Drive folder where project artifacts are stored.
                  Each project gets its own subfolder. Agents auto-publish work products here on mission completion.
                </div>
                <div className={styles.fieldRow} style={{ alignItems: "center" }}>
                  <span className={styles.fieldLabel}>Root Drive Folder ID</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      id="settings-artifacts-folder-input"
                      className="input"
                      style={{ width: 320, fontSize: 13, fontFamily: "monospace" }}
                      placeholder="e.g. 1AbC2dEf3GhI4jKlMnOp..."
                      value={artifactsFolder}
                      onChange={(e) => setArtifactsFolder(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter") handleSaveArtifactsFolder();
                      }}
                    />
                    <button
                      id="settings-artifacts-folder-save"
                      className="btn btn-sm btn-primary"
                      onClick={handleSaveArtifactsFolder}
                      disabled={artifactsSaving}
                    >
                      {artifactsSaving ? "Saving..." : "Save"}
                    </button>
                    {artifactsSaved && (
                      <span style={{ color: "#3BAA78", fontSize: 12, fontWeight: 500 }}>✓ Saved</span>
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#566373", marginTop: 4 }}>
                  Create a folder in{" "}
                  <a
                    href="https://drive.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#6B9FE8" }}
                  >
                    Google Drive
                  </a>
                  , then paste its folder ID here. The ID is the last part of the folder URL:{" "}
                  <code style={{ fontSize: 10, background: "rgba(32,40,51,0.5)", padding: "1px 4px", borderRadius: 3 }}>
                    drive.google.com/drive/folders/<strong>folder-id-here</strong>
                  </code>
                </div>
                {artifactsFolder && (
                  <div style={{ marginTop: 8 }}>
                    <a
                      href={`https://drive.google.com/drive/folders/${artifactsFolder}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: "#6B9FE8" }}
                    >
                      📁 Open folder in Drive →
                    </a>
                  </div>
                )}
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

              {setup.authConfigured ? (
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
                      placeholder="yourcompany.com"
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

          {/* ==== Secrets Tab ==== */}
          {activeTab === "secrets" && (
            <>
              {/* Create Secret */}
              <section className={styles.section} id="settings-secrets">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div className={styles.sectionTitle}>Secret Store</div>
                    <div className={styles.sectionDesc}>Manage secrets for agent access via IAM-controlled grants.</div>
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setShowCreateSecret(!showCreateSecret)}
                  >
                    {showCreateSecret ? "Cancel" : "+ Create Secret"}
                  </button>
                </div>

                {showCreateSecret && (
                  <div style={{ marginTop: 16, padding: 16, background: "var(--bg-tertiary)", borderRadius: "var(--radius-md)" }}>
                    <div className={styles.inputRow}>
                      <label className={styles.fieldLabel}>Name (slug)</label>
                      <input
                        className="input"
                        placeholder="e.g., github-token"
                        value={newSecretName}
                        onChange={(e) => setNewSecretName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                        id="secret-name-input"
                      />
                    </div>
                    <div className={styles.inputRow} style={{ marginTop: 8 }}>
                      <label className={styles.fieldLabel}>Description</label>
                      <input
                        className="input"
                        placeholder="What this secret is for"
                        value={newSecretDesc}
                        onChange={(e) => setNewSecretDesc(e.target.value)}
                        id="secret-desc-input"
                      />
                    </div>
                    <div className={styles.inputRow} style={{ marginTop: 8 }}>
                      <label className={styles.fieldLabel}>Value</label>
                      <input
                        className="input"
                        type="password"
                        placeholder="Secret value (write-only)"
                        value={newSecretValue}
                        onChange={(e) => setNewSecretValue(e.target.value)}
                        id="secret-value-input"
                      />
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      style={{ marginTop: 12 }}
                      disabled={!newSecretName || !newSecretValue || secretCreating}
                      onClick={handleCreateSecret}
                      id="secret-create-btn"
                    >
                      {secretCreating ? "Creating..." : "Create"}
                    </button>
                  </div>
                )}
              </section>

              {/* Secrets List */}
              {secretsLoading ? (
                <section className={styles.section}>
                  <div style={{ color: "var(--mist)", fontSize: 13 }}>Loading secrets...</div>
                </section>
              ) : secrets.length === 0 ? (
                <section className={styles.section}>
                  <div style={{ color: "var(--mist)", fontSize: 13 }}>No secrets created yet.</div>
                </section>
              ) : (
                secrets.map((secret) => (
                  <section className={styles.section} key={secret.name} id={`secret-${secret.name}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div className={styles.sectionTitle} style={{ fontSize: 15 }}>
                          🔑 {secret.name}
                        </div>
                        {secret.description && (
                          <div className={styles.sectionDesc}>{secret.description}</div>
                        )}
                        <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
                          SM: {secret.secretManagerName} · Created {secret.createdAt ? new Date(secret.createdAt).toLocaleDateString() : ""}
                          {secret.createdBy && ` by ${secret.createdBy}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setExpandedSecret(expandedSecret === secret.name ? null : secret.name)}
                        >
                          {expandedSecret === secret.name ? "Close" : `Grants (${secret.grants.length})`}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => { setRotateTarget(rotateTarget === secret.name ? null : secret.name); setRotateValue(""); }}
                        >
                          Rotate
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDeleteSecret(secret.name)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* Rotate panel */}
                    {rotateTarget === secret.name && (
                      <div style={{ marginTop: 12, padding: 12, background: "var(--bg-tertiary)", borderRadius: "var(--radius-sm)" }}>
                        <div style={{ fontSize: 12, color: "var(--mist)", marginBottom: 6 }}>New secret value (agents pick up on next read)</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <input
                            className="input"
                            type="password"
                            placeholder="New value"
                            value={rotateValue}
                            onChange={(e) => setRotateValue(e.target.value)}
                            style={{ flex: 1 }}
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={!rotateValue || rotateLoading}
                            onClick={() => handleRotateSecret(secret.name)}
                          >
                            {rotateLoading ? "Rotating..." : "Confirm"}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Grants panel */}
                    {expandedSecret === secret.name && (
                      <div style={{ marginTop: 12, padding: 12, background: "var(--bg-tertiary)", borderRadius: "var(--radius-sm)" }}>
                        <div style={{ fontSize: 12, color: "var(--mist)", marginBottom: 8 }}>Agent access (IAM-controlled)</div>

                        {/* Current grants */}
                        {secret.grants.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            {secret.grants.map((grant) => (
                              <div key={grant.agentEmail} style={{
                                display: "flex", justifyContent: "space-between", alignItems: "center",
                                padding: "6px 0", borderBottom: "1px solid var(--charcoal)",
                              }}>
                                <div>
                                  <span style={{ fontSize: 13 }}>{grant.agentEmail}</span>
                                  <span style={{ fontSize: 11, color: "var(--slate)", marginLeft: 8 }}>
                                    SA: {grant.serviceAccount}
                                  </span>
                                </div>
                                <button
                                  className="btn btn-ghost btn-sm"
                                  style={{ color: "var(--status-error)", fontSize: 11 }}
                                  disabled={grantLoading === `${secret.name}:${grant.agentEmail}`}
                                  onClick={() => handleRevokeAccess(secret.name, grant.agentEmail)}
                                >
                                  {grantLoading === `${secret.name}:${grant.agentEmail}` ? "..." : "Revoke"}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Grant to new agent */}
                        <div style={{ fontSize: 12, color: "var(--mist)", marginBottom: 6 }}>Grant to agent:</div>
                        {allFleetAgents.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--slate)" }}>No fleet agents found.</div>
                        ) : (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {allFleetAgents
                              .filter((a) => !secret.grants.some((g) => g.agentEmail === a.email))
                              .map((agent) => (
                                <button
                                  key={agent.email}
                                  className="btn btn-secondary btn-sm"
                                  style={{ fontSize: 11 }}
                                  disabled={grantLoading === `${secret.name}:${agent.email}`}
                                  onClick={() => handleGrantAccess(secret.name, agent.email)}
                                >
                                  {grantLoading === `${secret.name}:${agent.email}` ? "..." : `+ ${agent.name} (${agent.specialty})`}
                                </button>
                              ))}
                            {allFleetAgents.filter((a) => !secret.grants.some((g) => g.agentEmail === a.email)).length === 0 && (
                              <div style={{ fontSize: 12, color: "var(--slate)" }}>All agents already granted.</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                ))
              )}
            </>
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

export default function DashboardSettingsPage() {
  return (
    <Suspense>
      <SettingsPageInner />
    </Suspense>
  );
}
