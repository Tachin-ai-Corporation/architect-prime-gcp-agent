"use client";

import { useState } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import styles from "@/app/settings/page.module.css";

export function SecurityTab() {
  const { setup } = usePrime();

  // OAuth state
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [oauthDomain, setOauthDomain] = useState("");
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthResult, setOauthResult] = useState<{ ok: boolean; msg: string } | null>(null);

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

  return (
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
  );
}
