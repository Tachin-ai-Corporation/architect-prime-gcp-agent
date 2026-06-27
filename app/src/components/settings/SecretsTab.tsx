"use client";

import { useState, useEffect, useCallback } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { useDialog } from "@/components/DialogProvider";
import styles from "@/app/settings/page.module.css";

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

export function SecretsTab() {
  const { sidebarFleet, primes } = usePrime();
  const dialog = useDialog();

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

  // Load secrets on mount
  useEffect(() => {
    loadSecrets();
    // Build flat list of all agents (fleet + primes) across all primes
    const agents: FleetAgentInfo[] = [];

    // Add Prime agents first
    if (primes) {
      for (const prime of primes) {
        if (prime.status !== "removed") {
          agents.push({
            name: prime.name,
            email: `prime:${prime.id}`,
            specialty: "prime",
            primeId: prime.id,
          });
        }
      }
    }

    // Add fleet agents
    if (sidebarFleet) {
      for (const [primeId, fleet] of Object.entries(sidebarFleet)) {
        for (const agent of fleet as Array<{ name: string; email: string; specialty: string }>) {
          if (agent.email) {
            agents.push({ name: agent.name, email: agent.email, specialty: agent.specialty, primeId });
          }
        }
      }
    }
    setAllFleetAgents(agents);
  }, [loadSecrets, sidebarFleet, primes]);

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

  return (
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
  );
}
