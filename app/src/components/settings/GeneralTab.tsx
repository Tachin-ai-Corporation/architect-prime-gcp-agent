"use client";

import styles from "../../app/page.module.css";
import type { SetupState } from "./SettingsView";

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
  copied: string;
  setCopied: (v: string) => void;
}

export function GeneralTab({ setup, setSetup, primeCount, fleetCount, copied, setCopied }: GeneralTabProps) {
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
