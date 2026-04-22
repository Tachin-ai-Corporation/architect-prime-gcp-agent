"use client";

import styles from "../../app/page.module.css";
import type { SetupState, PrimeInstance, FleetAgent, VersionInfo } from "./SettingsView";

async function api<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface GeneralTabProps {
  setup: SetupState;
  setSetup: React.Dispatch<React.SetStateAction<SetupState>>;
  primeCount: number;
  fleetCount: number;
  primes: PrimeInstance[];
  sidebarFleet: Record<string, FleetAgent[]>;
  onTeardownPrime: (primeId: string, primeName: string) => void;
  onRedeployPrime: (primeId: string) => void;
  versionInfo: VersionInfo | null;
  copied: string;
  setCopied: (v: string) => void;
}

export function GeneralTab({ setup, setSetup, primeCount, fleetCount, primes, sidebarFleet, onTeardownPrime, onRedeployPrime, versionInfo, copied, setCopied }: GeneralTabProps) {
  return (
    <>
      {/* Agent Defaults */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Agent Defaults</div>
        <div className={styles["settings-row"]} style={{ alignItems: "center" }}>
          <div className={styles["settings-label"]}>Agent Email Domain</div>
          <div className={styles["settings-value"]} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              className="input"
              style={{ width: 260, fontSize: 13 }}
              placeholder="e.g. tachin.ai"
              value={setup.agentEmailDomain}
              onChange={(e) => setSetup(prev => ({ ...prev, agentEmailDomain: e.target.value }))}
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  await api("/api/setup", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ agentEmailDomain: setup.agentEmailDomain.trim() }),
                  });
                  setCopied("domain");
                  setTimeout(() => setCopied(""), 2000);
                }
              }}
            />
            <button className="btn btn-sm btn-primary" onClick={async () => {
              await api("/api/setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agentEmailDomain: setup.agentEmailDomain.trim() }),
              });
              setCopied("domain");
              setTimeout(() => setCopied(""), 2000);
            }}>Save</button>
            {copied === "domain" && (
              <span style={{ color: "#22c55e", fontSize: 12, fontWeight: 500 }}>✓ Saved</span>
            )}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, paddingLeft: 2 }}>
          When set, agent emails auto-fill as <code className="mono" style={{ fontSize: 10 }}>specialty-agent-name@domain</code> during hire.
        </div>
      </div>

      {/* Prime Instances */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Prime Instances</div>
        <div style={{ display: "grid", gap: 12 }}>
          {primes.map((p) => {
            const primeFleet = sidebarFleet[p.id] || [];
            const activeAgents = primeFleet.filter((a) => a.status !== "removed");
            const isRemoved = p.status === "removed";
            const isTearingDown = p.status === "tearing_down";
            const isLive = !isRemoved && !isTearingDown;

            return (
              <div
                key={p.id}
                style={{
                  padding: "14px 16px",
                  background: "var(--bg-tertiary)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                {/* Top row: name + status */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div className={`${styles["sidebar-item-dot"]} ${styles[p.status]}`} style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginLeft: 8 }}>
                      {p.zone} · {activeAgents.length} agent{activeAgents.length !== 1 ? "s" : ""} · {p.status}
                    </span>
                  </div>
                </div>

                {/* Action buttons row */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {isLive && (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={async () => {
                        if (!confirm(`Upgrade CoreKit on "${p.name}"? This will also restart the gateway.`)) return;
                        const result = await api<{id: string}>(`/api/primes/${p.id}/commands`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ type: "upgrade_corekit", args: { ref: versionInfo?.latestTag || "main" } }),
                        });
                        if (result?.id) alert(`CoreKit upgrade queued (command: ${result.id}).`);
                        else alert("Failed to queue upgrade command.");
                      }}>
                        ⬆ Upgrade CoreKit
                      </button>
                      <button className="btn btn-sm btn-ghost" style={{ borderColor: "var(--border)" }} onClick={async () => {
                        if (!confirm(`Restart the OpenClaw gateway on "${p.name}"?`)) return;
                        const result = await api<{id: string}>(`/api/primes/${p.id}/commands`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ type: "gateway_restart", args: {} }),
                        });
                        if (result?.id) alert(`Gateway restart queued (command: ${result.id}).`);
                        else alert("Failed to queue restart command.");
                      }}>
                        ↻ Restart Gateway
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => onTeardownPrime(p.id, p.name)}
                      >
                        Decommission
                      </button>
                    </>
                  )}
                  {isRemoved && (
                    <button className="btn btn-sm btn-primary" onClick={() => onRedeployPrime(p.id)}>
                      ↻ Re-deploy
                    </button>
                  )}
                  {isTearingDown && (
                    <span style={{ fontSize: 12, color: "var(--accent-primary)", padding: "5px 0" }}>Tearing down...</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Project Info */}
      <div className={styles["settings-section"]}>
        <div className={styles["settings-section-title"]}>Project Info</div>
        <div className={styles["settings-row"]}>
          <div className={styles["settings-label"]}>GCP Project</div>
          <div className={styles["settings-value"]}><code className="mono">{setup.projectId || "—"}</code></div>
        </div>
        <div className={styles["settings-row"]}>
          <div className={styles["settings-label"]}>DWD Signer SA</div>
          <div className={styles["settings-value"]}><code className="mono">{setup.dwdSignerSA || "—"}</code></div>
        </div>
        <div className={styles["settings-row"]}>
          <div className={styles["settings-label"]}>Prime Count</div>
          <div className={styles["settings-value"]}>{primeCount}</div>
        </div>
        <div className={styles["settings-row"]}>
          <div className={styles["settings-label"]}>Fleet Count</div>
          <div className={styles["settings-value"]}>{fleetCount}</div>
        </div>
      </div>
    </>
  );
}
