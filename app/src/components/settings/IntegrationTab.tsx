"use client";

import styles from "../../app/page.module.css";
import type { SetupState } from "./SettingsView";

interface IntegrationTabProps {
  setup: SetupState;
  copied: string;
  copyToClipboard: (text: string, label: string) => void;
  dwdTestEmail: string;
  setDwdTestEmail: (v: string) => void;
  dwdTesting: boolean;
  dwdTestResult: { success: boolean; message?: string; error?: string; hint?: string } | null;
  handleDwdTest: () => void;
}

/* ---- DWD Guide (shared sub-component) ---- */
export function DWDGuide({ setup, copied, onCopy }: {
  setup: SetupState;
  copied: string;
  onCopy: (text: string, label: string) => void;
}) {
  const clientId = setup.dwdClientId || "Loading...";
  const scopes = "https://www.googleapis.com/auth/chat.messages, https://www.googleapis.com/auth/chat.spaces";

  return (
    <div className={styles["dwd-guide"]}>
      <div className={styles["dwd-guide-title"]}>Configuration Values</div>

      <div className={styles["dwd-copy-row"]}>
        <span className={styles["dwd-copy-label"]}>Client ID</span>
        <span className={styles["dwd-copy-value"]}>{clientId}</span>
        <button className={`${styles["dwd-copy-btn"]} ${copied === "clientId" ? styles.copied : ""}`}
          onClick={() => onCopy(clientId, "clientId")}>
          {copied === "clientId" ? "✓" : "Copy"}
        </button>
      </div>

      <div className={styles["dwd-copy-row"]}>
        <span className={styles["dwd-copy-label"]}>OAuth Scopes</span>
        <span className={styles["dwd-copy-value"]}>{scopes}</span>
        <button className={`${styles["dwd-copy-btn"]} ${copied === "scopes" ? styles.copied : ""}`}
          onClick={() => onCopy(scopes, "scopes")}>
          {copied === "scopes" ? "✓" : "Copy"}
        </button>
      </div>

      <ol className={styles["dwd-steps"]}>
        <li>Open <a href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener noreferrer">Workspace Admin → Security → API Controls → DWD</a></li>
        <li>Click <strong>&quot;Add new&quot;</strong></li>
        <li>Paste the <strong>Client ID</strong> above</li>
        <li>Paste the <strong>OAuth Scopes</strong> above</li>
        <li>Click <strong>&quot;Authorize&quot;</strong></li>
      </ol>
    </div>
  );
}

export function IntegrationTab({
  setup, copied, copyToClipboard,
  dwdTestEmail, setDwdTestEmail, dwdTesting, dwdTestResult, handleDwdTest,
}: IntegrationTabProps) {
  return (
    <>
      {/* DWD */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>
          <span>Domain-Wide Delegation</span>
          <span className={`badge ${setup.dwdConfigured ? "badge-online" : "badge-offline"}`}
            style={{ marginLeft: 8, fontSize: 11 }}>
            {setup.dwdConfigured ? "Configured" : "Not configured"}
          </span>
        </div>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
          DWD allows fleet agents to send and receive Google Chat messages using their Workspace email.
          This is a <strong>one-time setup</strong> in Google Admin Console.
        </p>

        <DWDGuide setup={setup} copied={copied} onCopy={copyToClipboard} />

        <div style={{ marginTop: 20, padding: 16, background: "var(--bg-tertiary)", borderRadius: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Test DWD Configuration</div>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 12 }}>
            Enter a Workspace email to verify DWD is working. This will attempt to sign a JWT and exchange it for a token.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input className="input" placeholder="e.g. devops-stan@yourcompany.com" value={dwdTestEmail}
              onChange={(e) => setDwdTestEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleDwdTest(); }}
              style={{ flex: 1 }} />
            <button className="btn btn-primary" onClick={handleDwdTest}
              disabled={!dwdTestEmail.trim() || dwdTesting}
              style={{ whiteSpace: "nowrap" }}>
              {dwdTesting ? "Testing..." : "Test DWD"}
            </button>
          </div>
          {dwdTestResult && (
            <div style={{
              marginTop: 12, padding: 12, borderRadius: 6, fontSize: 13, lineHeight: 1.5,
              background: dwdTestResult.success ? "rgba(46, 160, 67, 0.15)" : "rgba(248, 81, 73, 0.15)",
              border: `1px solid ${dwdTestResult.success ? "rgba(46, 160, 67, 0.4)" : "rgba(248, 81, 73, 0.4)"}`,
              color: dwdTestResult.success ? "#3fb950" : "#f85149",
            }}>
              {dwdTestResult.success ? "✅ " : "❌ "}
              {dwdTestResult.message || dwdTestResult.error}
              {dwdTestResult.hint && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>
                  💡 {dwdTestResult.hint}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Workspace Email */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Workspace Email Setup</div>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.6 }}>
          Each fleet agent needs a Workspace email to communicate via Google Chat.
          Create the account <strong>before</strong> hiring the agent.
        </p>
        <div style={{ padding: 12, background: "var(--bg-tertiary)", borderRadius: 8, fontSize: 13 }}>
          <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 2 }}>
            <li>Go to <a href="https://admin.google.com/ac/users" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Google Admin → Users</a></li>
            <li>Click <strong>&quot;Add new user&quot;</strong></li>
            <li>Use a naming convention: <code className="mono" style={{ fontSize: 12 }}>job-agent-NAME@domain.com</code></li>
            <li>Set a password (agent won&apos;t use it — DWD handles auth)</li>
            <li>After creating, add the user to your Chat space</li>
          </ol>
        </div>
      </div>
    </>
  );
}
