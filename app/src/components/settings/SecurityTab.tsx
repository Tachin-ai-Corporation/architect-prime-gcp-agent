"use client";

import { useState } from "react";

interface SecurityTabProps {
  projectId: string;
}

export function SecurityTab({ projectId }: SecurityTabProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [domain, setDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Check if OAuth is already configured
  const isConfigured = Boolean(
    typeof window !== "undefined" && document.cookie.includes("next-auth.session-token")
  );

  const handleSave = async () => {
    if (!clientId || !clientSecret) {
      setResult({ ok: false, msg: "Client ID and Client Secret are required" });
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/setup/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, domain }),
      });
      const data = await res.json();
      if (data.success) {
        setResult({
          ok: true,
          msg: "OAuth configured! The dashboard will restart in ~30 seconds. After restart, you'll be prompted to sign in with Google.",
        });
      } else {
        setResult({ ok: false, msg: data.error || "Failed to configure OAuth" });
      }
    } catch (err) {
      setResult({ ok: false, msg: `Error: ${err}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <h3 style={{ margin: 0, fontSize: "1.1rem" }}>🔐 Authentication</h3>

      {process.env.NEXT_PUBLIC_AUTH_CONFIGURED === "true" ? (
        <div
          style={{
            background: "rgba(34,197,94,0.1)",
            border: "1px solid rgba(34,197,94,0.3)",
            borderRadius: "0.75rem",
            padding: "1rem",
          }}
        >
          <strong style={{ color: "#22c55e" }}>✓ Google OAuth is configured</strong>
          <p style={{ margin: "0.5rem 0 0", opacity: 0.7, fontSize: "0.9rem" }}>
            Users must sign in with a Google Workspace account to access this dashboard.
          </p>
        </div>
      ) : (
        <>
          <div
            style={{
              background: "rgba(234,179,8,0.1)",
              border: "1px solid rgba(234,179,8,0.3)",
              borderRadius: "0.75rem",
              padding: "1rem",
            }}
          >
            <strong style={{ color: "#eab308" }}>⚠ Authentication not configured</strong>
            <p style={{ margin: "0.5rem 0 0", opacity: 0.7, fontSize: "0.9rem" }}>
              This dashboard is currently accessible without login. Configure Google OAuth below to require sign-in.
            </p>
          </div>

          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "0.75rem",
              padding: "1.25rem",
            }}
          >
            <h4 style={{ margin: "0 0 0.75rem" }}>Setup Guide</h4>
            <ol style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.8 }}>
              <li>
                Go to{" "}
                <a
                  href={`https://console.cloud.google.com/apis/credentials/consent?project=${projectId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#60a5fa" }}
                >
                  OAuth consent screen
                </a>{" "}
                → Choose <strong>Internal</strong> → Save
              </li>
              <li>
                Go to{" "}
                <a
                  href={`https://console.cloud.google.com/apis/credentials?project=${projectId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#60a5fa" }}
                >
                  Credentials
                </a>{" "}
                → <strong>Create Credentials</strong> → <strong>OAuth client ID</strong> → Web application
              </li>
              <li>
                Add redirect URI: <code style={{ background: "rgba(255,255,255,0.1)", padding: "0.15rem 0.4rem", borderRadius: "0.25rem" }}>{typeof window !== "undefined" ? window.location.origin : ""}/api/auth/callback/google</code>
              </li>
              <li>Copy the Client ID and Client Secret below</li>
            </ol>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <label style={{ fontSize: "0.85rem", opacity: 0.7 }}>OAuth Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="123456789-abc.apps.googleusercontent.com"
              style={{
                padding: "0.6rem 0.8rem",
                borderRadius: "0.5rem",
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(0,0,0,0.3)",
                color: "inherit",
                fontSize: "0.9rem",
              }}
            />

            <label style={{ fontSize: "0.85rem", opacity: 0.7 }}>OAuth Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-..."
              style={{
                padding: "0.6rem 0.8rem",
                borderRadius: "0.5rem",
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(0,0,0,0.3)",
                color: "inherit",
                fontSize: "0.9rem",
              }}
            />

            <label style={{ fontSize: "0.85rem", opacity: 0.7 }}>Allowed Domain (optional)</label>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="yourcompany.com"
              style={{
                padding: "0.6rem 0.8rem",
                borderRadius: "0.5rem",
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(0,0,0,0.3)",
                color: "inherit",
                fontSize: "0.9rem",
              }}
            />

            <button
              onClick={handleSave}
              disabled={saving || !clientId || !clientSecret}
              style={{
                marginTop: "0.5rem",
                padding: "0.6rem 1.2rem",
                borderRadius: "0.5rem",
                border: "none",
                background: saving ? "rgba(255,255,255,0.1)" : "#3b82f6",
                color: "#fff",
                cursor: saving ? "not-allowed" : "pointer",
                fontSize: "0.9rem",
                fontWeight: 600,
              }}
            >
              {saving ? "Saving..." : "🔐 Configure OAuth & Restart"}
            </button>
          </div>

          {result && (
            <div
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "0.5rem",
                background: result.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                border: `1px solid ${result.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                fontSize: "0.9rem",
              }}
            >
              {result.msg}
            </div>
          )}
        </>
      )}
    </div>
  );
}
