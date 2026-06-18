"use client";

import { useState, useCallback } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import type { SetupState } from "@/lib/types";
import styles from "@/app/settings/page.module.css";
import stylesHome from "@/app/page.module.css";

export function IntegrationTab() {
  const { setup } = usePrime();

  // DWD test state
  const [dwdTestEmail, setDwdTestEmail] = useState("");
  const [dwdTesting, setDwdTesting] = useState(false);
  const [dwdTestResult, setDwdTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
    hint?: string;
  } | null>(null);

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

  return (
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
          <span className={styles.copyValue} style={{ fontSize: 10, wordBreak: "break-all" }}>
            https://www.googleapis.com/auth/chat.messages, https://www.googleapis.com/auth/chat.messages.create, https://www.googleapis.com/auth/chat.messages.readonly, https://www.googleapis.com/auth/chat.spaces.readonly, https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/gmail.send, https://www.googleapis.com/auth/gmail.compose, https://www.googleapis.com/auth/gmail.modify, https://www.googleapis.com/auth/calendar, https://www.googleapis.com/auth/calendar.events, https://www.googleapis.com/auth/drive, https://www.googleapis.com/auth/drive.file, https://www.googleapis.com/auth/documents, https://www.googleapis.com/auth/spreadsheets, https://www.googleapis.com/auth/presentations, https://www.googleapis.com/auth/contacts.readonly, https://www.googleapis.com/auth/admin.directory.orgunit, https://www.googleapis.com/auth/admin.directory.user
          </span>
          <button
            className={styles.copyBtn}
            id="settings-copy-scopes"
            onClick={() =>
              copyToClipboard(
                "https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/chat.messages.create,https://www.googleapis.com/auth/chat.messages.readonly,https://www.googleapis.com/auth/chat.spaces.readonly,https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/documents,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/presentations,https://www.googleapis.com/auth/contacts.readonly,https://www.googleapis.com/auth/admin.directory.orgunit,https://www.googleapis.com/auth/admin.directory.user",
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
  );
}

/* ---- DWD Guide (used by homepage onboarding) ---- */
export function DWDGuide({ setup, copied, onCopy }: {
  setup: SetupState;
  copied: string;
  onCopy: (text: string, label: string) => void;
}) {
  const clientId = setup.dwdClientId || "Loading...";
  const scopes = "https://www.googleapis.com/auth/chat.messages, https://www.googleapis.com/auth/chat.spaces";

  return (
    <div className={stylesHome["dwd-guide"]}>
      <div className={stylesHome["dwd-guide-title"]}>Configuration Values</div>

      <div className={stylesHome["dwd-copy-row"]}>
        <span className={stylesHome["dwd-copy-label"]}>Client ID</span>
        <span className={stylesHome["dwd-copy-value"]}>{clientId}</span>
        <button className={`${stylesHome["dwd-copy-btn"]} ${copied === "clientId" ? stylesHome.copied : ""}`}
          onClick={() => onCopy(clientId, "clientId")}>
          {copied === "clientId" ? "✓" : "Copy"}
        </button>
      </div>

      <div className={stylesHome["dwd-copy-row"]}>
        <span className={stylesHome["dwd-copy-label"]}>OAuth Scopes</span>
        <span className={stylesHome["dwd-copy-value"]}>{scopes}</span>
        <button className={`${stylesHome["dwd-copy-btn"]} ${copied === "scopes" ? stylesHome.copied : ""}`}
          onClick={() => onCopy(scopes, "scopes")}>
          {copied === "scopes" ? "✓" : "Copy"}
        </button>
      </div>

      <ol className={stylesHome["dwd-steps"]}>
        <li>Open <a href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener noreferrer">Workspace Admin → Security → API Controls → DWD</a></li>
        <li>Click <strong>&quot;Add new&quot;</strong></li>
        <li>Paste the <strong>Client ID</strong> above</li>
        <li>Paste the <strong>OAuth Scopes</strong> above</li>
        <li>Click <strong>&quot;Authorize&quot;</strong></li>
      </ol>
    </div>
  );
}
