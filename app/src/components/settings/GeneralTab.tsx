"use client";

import styles from "../../app/page.module.css";
import { useDialog } from "@/components/DialogProvider";
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
  const dialog = useDialog();

  /** Queue a command and track its progress */
  const queueAndTrack = async (primeId: string, type: string, args: Record<string, string>, label: string) => {
    const result = await api<{id: string}>(`/api/primes/${primeId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, args }),
    });
    if (result?.id) {
      dialog.trackCommand(primeId, result.id, label);
      return result.id;
    } else {
      dialog.toast({ message: `Failed to queue ${label}.`, variant: "error" });
      return null;
    }
  };

  /** Upgrade Prime CoreKit + cascade to all fleet agents */
  const handleUpgradePrime = async (p: PrimeInstance) => {
    const primeFleet = sidebarFleet[p.id] || [];
    const activeAgents = primeFleet.filter((a) => a.status !== "removed" && a.status !== "tearing_down");
    const agentCount = activeAgents.length;

    const message = agentCount > 0
      ? `This will upgrade CoreKit on ${p.name} and ${agentCount} fleet agent${agentCount !== 1 ? "s" : ""}.\nThe gateway and agents will restart during the upgrade.`
      : "This will pull the latest CoreKit from GitHub and restart the gateway.\nThe agent will be briefly unavailable during the restart.";

    const ok = await dialog.confirm({
      title: `Upgrade ${p.name}${agentCount > 0 ? ` + ${agentCount} agent${agentCount !== 1 ? "s" : ""}` : ""}?`,
      message,
      confirmText: "Upgrade All",
    });
    if (!ok) return;

    const ref = "main";

    // Queue Prime upgrade
    await queueAndTrack(p.id, "upgrade_corekit", { ref }, `Upgrade ${p.name} CoreKit`);

    // Cascade: queue fleet_upgrade for each active agent
    for (const agent of activeAgents) {
      await queueAndTrack(p.id, "fleet_upgrade", { name: agent.name, ref }, `Upgrade ${agent.name}`);
    }
  };

  /** Check if a Prime needs an upgrade */
  const needsUpgrade = (p: PrimeInstance): boolean => {
    if (!versionInfo?.mainHeadSha) return false;
    if (!p.coreRef) return false;
    // If the VM's coreRef contains a commit hash, compare to main HEAD
    // If it equals "main" it was deployed from main but we don't know the exact commit
    if (p.coreRef === "main" || p.coreRef === "unknown") return false;
    // coreRef could be "main@abc1234" or a tag like "v5.1.0" — either way, if it
    // doesn't contain the current main HEAD sha, it's behind
    return !p.coreRef.includes(versionInfo.mainHeadSha);
  };

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
            const upgradeNeeded = needsUpgrade(p);
            const coreRef = p.coreRef;

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
                    {coreRef && (
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: 6 }}>
                        · <code className="mono" style={{ fontSize: 10 }}>{coreRef}</code>
                      </span>
                    )}
                    {isLive && upgradeNeeded && (
                      <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 6, fontWeight: 600 }}>
                        ● needs upgrade
                      </span>
                    )}
                  </div>
                </div>

                {/* Action buttons row */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {isLive && (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={() => handleUpgradePrime(p)}>
                        ⬆ Upgrade CoreKit
                      </button>
                      <button className="btn btn-sm btn-ghost" style={{ borderColor: "var(--border)" }} onClick={async () => {
                        const ok = await dialog.confirm({
                          title: `Restart gateway on ${p.name}?`,
                          message: "The OpenClaw gateway will restart. The agent will be briefly unavailable.",
                          confirmText: "Restart",
                        });
                        if (!ok) return;
                        await queueAndTrack(p.id, "gateway_restart", {}, `Restart ${p.name} gateway`);
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
