"use client";

import { useParams, useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { useDialog } from "@/components/DialogProvider";
import type { AgentDetail } from "@/lib/types";

/* ---- Process types (from /api/primes/[id]/processes) ---- */
interface ProcessParam {
  description?: string;
  default?: string;
  required?: boolean;
}

interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  status: string;
  parameters?: Record<string, ProcessParam | string>;
  steps?: { id: string; title: string }[];
}

export default function AgentSettings() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const router = useRouter();
  const dialog = useDialog();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  /* ---- Process linking state ---- */
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [processesLoading, setProcessesLoading] = useState(false);
  const [selectedProcessId, setSelectedProcessId] = useState("");
  const [responsibilityId, setResponsibilityId] = useState("");
  const [paramOverrides, setParamOverrides] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const fetchDetail = useCallback(async () => {
    const data = await api<AgentDetail>(`/api/primes/${id}/fleet/${agent}/logs`);
    if (data) setDetail(data);
    setLoading(false);
  }, [id, agent]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  /* ---- Fetch processes for the dropdown ---- */
  const fetchProcesses = useCallback(async () => {
    setProcessesLoading(true);
    const data = await api<{ processes: ProcessSummary[] }>(`/api/primes/${id}/processes`);
    if (data?.processes) setProcesses(data.processes.filter((p) => p.status === "active"));
    setProcessesLoading(false);
  }, [id]);

  useEffect(() => { fetchProcesses(); }, [fetchProcesses]);

  /* ---- Derived: selected process detail ---- */
  const selectedProcess = processes.find((p) => p.id === selectedProcessId) || null;

  /* Reset param overrides when process changes */
  useEffect(() => {
    setParamOverrides({});
    setCopied(false);
  }, [selectedProcessId]);

  /* ---- Build the CLI command ---- */
  const buildCommand = (): string => {
    if (!responsibilityId || !selectedProcessId) return "";
    const parts = [`responsibility-manage update '${responsibilityId}' '{}'`];
    parts.push(`--process-ref ${selectedProcessId}`);
    const nonEmpty = Object.fromEntries(
      Object.entries(paramOverrides).filter(([, v]) => v.trim() !== "")
    );
    if (Object.keys(nonEmpty).length > 0) {
      parts.push(`--process-params '${JSON.stringify(nonEmpty)}'`);
    }
    return parts.join(" \\\n  ");
  };

  const handleCopy = async () => {
    const cmd = buildCommand();
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      dialog.toast({ message: "Command copied to clipboard.", variant: "success" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      dialog.toast({ message: "Failed to copy.", variant: "error" });
    }
  };

  /* ---- Build the unlink command ---- */
  const buildUnlinkCommand = (): string => {
    if (!responsibilityId) return "";
    return `responsibility-manage update '${responsibilityId}' '{}' --process-ref ""`;
  };

  const handleCopyUnlink = async () => {
    const cmd = buildUnlinkCommand();
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      dialog.toast({ message: "Unlink command copied.", variant: "success" });
    } catch {
      dialog.toast({ message: "Failed to copy.", variant: "error" });
    }
  };

  /* ---- Existing handlers ---- */
  const handleFire = async () => {
    const confirmed = await dialog.confirm({
      title: `Fire ${agent}?`,
      message: `This will permanently remove ${agent} from your fleet.\nThis action cannot be undone.`,
      confirmText: "Fire Agent",
      variant: "danger",
    });
    if (!confirmed) return;
    const res = await api<{ success: boolean }>(`/api/primes/${id}/fleet/fire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agent }),
    });
    if (res?.success) {
      dialog.toast({ message: `${agent} has been fired.`, variant: "success" });
      router.push(`/p/${id}/fleet`);
    } else {
      dialog.toast({ message: "Failed to fire agent.", variant: "error" });
    }
  };

  const handleUpgrade = async () => {
    const res = await api<{ id: string }>(`/api/primes/${id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fleet_upgrade", args: { name: agent, ref: "main" } }),
    });
    if (res?.id) {
      dialog.trackCommand(id, res.id, `Upgrade ${agent}`);
    } else {
      dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
    }
  };

  /* ---- Render helpers ---- */
  const renderParamFields = () => {
    if (!selectedProcess?.parameters) return null;
    const params = selectedProcess.parameters;
    const entries = Object.entries(params);
    if (entries.length === 0) return null;

    return (
      <div className={styles.paramFields}>
        <label className={styles.fieldLabel}>Process Parameters</label>
        {entries.map(([key, val]) => {
          const param = typeof val === "object" ? val : { description: String(val) };
          return (
            <div key={key} className={styles.paramRow}>
              <div className={styles.paramHeader}>
                <span className={styles.paramName}>{key}</span>
                {param.required && <span className={styles.paramRequired}>required</span>}
              </div>
              {param.description && (
                <div className={styles.paramDesc}>{param.description}</div>
              )}
              <input
                className={styles.paramInput}
                type="text"
                placeholder={param.default || ""}
                value={paramOverrides[key] || ""}
                onChange={(e) =>
                  setParamOverrides((prev) => ({ ...prev, [key]: e.target.value }))
                }
              />
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading…</div>
        </div>
      </div>
    );
  }

  const command = buildCommand();

  return (
    <div className={styles.shell} id="agent-settings">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>⚙ Settings — {agent}</h1>
        </header>

        {/* Identity Section */}
        <section className={styles.section} id="agent-settings-identity">
          <h2 className={styles.sectionTitle}>Identity</h2>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Agent Name</label>
              <div className={styles.fieldValue}>{agent}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Specialty</label>
              <div className={styles.fieldValue}>{detail?.specialty || "—"}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Email</label>
              <div className={styles.fieldValue}>{detail?.email || "—"}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>SOUL File</label>
              <div className={styles.fieldValueMono}>
                /home/{agent}/.agent/workspace/SOUL.md
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>VM</label>
              <div className={styles.fieldValueMono}>{detail?.vm || "—"}</div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Zone</label>
              <div className={styles.fieldValue}>{detail?.zone || "—"}</div>
            </div>
          </div>
        </section>

        {/* Responsibilities → Process Linking Section */}
        <section className={styles.section} id="agent-settings-responsibilities">
          <h2 className={styles.sectionTitle}>Responsibilities — Process Linking</h2>
          <p className={styles.sectionDesc}>
            Link a responsibility to a process definition. Responsibilities live on the agent
            VM and are managed via <code>responsibility-manage</code>. Select a process below
            to build the linking command.
          </p>

          {/* Responsibility ID input */}
          <div className={styles.respField}>
            <label className={styles.fieldLabel}>Responsibility ID</label>
            <input
              className={styles.respInput}
              type="text"
              placeholder="e.g. r-memory-consolidation"
              value={responsibilityId}
              onChange={(e) => {
                setResponsibilityId(e.target.value);
                setCopied(false);
              }}
            />
            <div className={styles.respHint}>
              Run <code>responsibility-manage list</code> on the VM to see available IDs.
            </div>
          </div>

          {/* Process selector */}
          <div className={styles.respField}>
            <label className={styles.fieldLabel}>Link to Process</label>
            {processesLoading ? (
              <div className={styles.respHint}>Loading processes…</div>
            ) : processes.length === 0 ? (
              <div className={styles.respHint}>
                No active processes found.{" "}
                <a href={`/processes`} className={styles.link}>Create one →</a>
              </div>
            ) : (
              <select
                className={styles.respSelect}
                value={selectedProcessId}
                onChange={(e) => setSelectedProcessId(e.target.value)}
              >
                <option value="">— Select a process —</option>
                {processes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Selected process detail */}
          {selectedProcess && (
            <div className={styles.processDetail}>
              <div className={styles.processHeader}>
                <span className={styles.processName}>{selectedProcess.name}</span>
                <span className={styles.processBadge}>{selectedProcess.id}</span>
              </div>
              <div className={styles.processDesc}>{selectedProcess.description}</div>

              {selectedProcess.steps && selectedProcess.steps.length > 0 && (
                <div className={styles.processSteps}>
                  <label className={styles.fieldLabel}>
                    Steps ({selectedProcess.steps.length})
                  </label>
                  <ol className={styles.stepsList}>
                    {selectedProcess.steps.map((s, i) => (
                      <li key={s.id || i} className={styles.stepItem}>
                        {s.title || s.id}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {renderParamFields()}
            </div>
          )}

          {/* Command output */}
          {command && (
            <div className={styles.commandBlock}>
              <label className={styles.fieldLabel}>Generated Command</label>
              <pre className={styles.commandPre}>{command}</pre>
              <div className={styles.commandActions}>
                <button className={styles.copyBtn} onClick={handleCopy}>
                  {copied ? "✓ Copied" : "📋 Copy Command"}
                </button>
                <button
                  className={styles.unlinkBtn}
                  onClick={handleCopyUnlink}
                  title="Copy the command to unlink any process from this responsibility"
                >
                  🔗 Copy Unlink Command
                </button>
              </div>
            </div>
          )}

          {/* Hint */}
          <div className={styles.respHint} style={{ marginTop: 12 }}>
            Paste the command on the agent VM to link the process. The brain scheduler
            auto-reloads within 10 seconds.
          </div>
        </section>

        {/* Upgrade Section */}
        <section className={styles.section} id="agent-settings-upgrade">
          <h2 className={styles.sectionTitle}>Upgrade</h2>
          <p className={styles.sectionDesc}>
            Pull the latest CoreKit from the main branch and restart the agent daemon.
          </p>
          <button
            className={styles.upgradeBtn}
            onClick={handleUpgrade}
            id="agent-upgrade-btn"
          >
            ⬆ Upgrade CoreKit
          </button>
        </section>

        {/* Danger Zone */}
        <section className={`${styles.section} ${styles.danger}`} id="agent-settings-danger">
          <h2 className={`${styles.sectionTitle} ${styles.dangerTitle}`}>Danger Zone</h2>
          <p className={styles.sectionDesc}>
            Permanently remove this agent from your fleet. The VM will be deleted and all local
            data will be lost.
          </p>
          <button
            className={styles.fireBtn}
            onClick={handleFire}
            id="agent-fire-btn"
          >
            🔥 Fire {agent}
          </button>
        </section>
      </div>
    </div>
  );
}

