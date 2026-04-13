"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./page.module.css";

/* ---- Types ---- */
interface PrimeInstance {
  id: string;
  name: string;
  status: "online" | "offline" | "deploying" | "error";
  zone: string;
  fleetCount: number;
}
interface ChatMessage {
  id: string;
  sender: "admin" | "prime";
  text: string;
  timestamp: string;
}
interface FleetAgent {
  name: string;
  status: "online" | "offline" | "deploying" | "needs_action" | "tearing_down" | "removed" | "error";
  specialty: string;
  email: string;
  deploySteps?: DeployStep[];
  actionRequired?: ActionRequired | null;
}
interface DeployStep {
  id: string;
  label: string;
  status: "done" | "active" | "pending" | "failed" | "skipped";
  timestamp: string;
  detail?: string;
}
interface ActionRequired {
  type: string;
  title: string;
  instructions: string[];
}
interface AgentDetail {
  agent: string;
  status: string;
  specialty: string;
  email: string;
  vm: string;
  zone: string;
  deployedAt: string | null;
  lastHeartbeat: string | null;
  uptimeMinutes: number | null;
  healthy: boolean;
  activity: { id: string; type: string; summary: string; timestamp: string; sender: string }[];
  deploySteps?: DeployStep[];
  actionRequired?: ActionRequired | null;
}
interface SetupState {
  hasPrimes: boolean;
  dwdConfigured: boolean;
  projectId: string;
  dwdSignerSA: string;
  dwdClientId: string;
}

/* ---- API helpers ---- */
async function api<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---- Component ---- */
export default function Home() {
  const [primes, setPrimes] = useState<PrimeInstance[]>([]);
  const [activePrime, setActivePrime] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [fleet, setFleet] = useState<FleetAgent[]>([]);
  const [input, setInput] = useState("");
  const [showDeploy, setShowDeploy] = useState(false);
  const [view, setView] = useState<"chat" | "fleet" | "settings">("chat");
  const [newPrimeName, setNewPrimeName] = useState("");
  const [newPrimeZone, setNewPrimeZone] = useState("us-central1-a");
  const [deploying, setDeploying] = useState(false);
  const [showHire, setShowHire] = useState(false);
  const [hireName, setHireName] = useState("");
  const [hireSpecialty, setHireSpecialty] = useState("devops");
  const [hireEmail, setHireEmail] = useState("");
  const [hiring, setHiring] = useState(false);
  const [dwdTestEmail, setDwdTestEmail] = useState("");
  const [dwdTesting, setDwdTesting] = useState(false);
  const [dwdTestResult, setDwdTestResult] = useState<{success: boolean; message?: string; error?: string; hint?: string} | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [versionInfo, setVersionInfo] = useState<{currentVersion: string; latestVersion: string; updateAvailable: boolean} | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [sidebarFleet, setSidebarFleet] = useState<Record<string, FleetAgent[]>>({});
  const [expandedPrimes, setExpandedPrimes] = useState<Record<string, boolean>>({});
  const [setup, setSetup] = useState<SetupState>({
    hasPrimes: false,
    dwdConfigured: false,
    projectId: "",
    dwdSignerSA: "",
    dwdClientId: "",
  });
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string>("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activePrimeData = primes.find((p) => p.id === activePrime);

  // ---- Load initial state ----
  useEffect(() => {
    (async () => {
      // Load setup state
      const setupData = await api<SetupState>("/api/setup");
      if (setupData) setSetup(setupData);

      // Load primes
      const primesData = await api<{ primes: PrimeInstance[] }>("/api/primes");
      if (primesData?.primes?.length) {
        setPrimes(primesData.primes);
        setActivePrime(primesData.primes[0].id);
      }
      setLoading(false);

      // Load version info
      const ver = await api<{currentVersion: string; latestVersion: string; updateAvailable: boolean}>("/api/upgrade");
      if (ver) setVersionInfo(ver);
    })();
  }, []);

  // ---- Load messages for active Prime ----
  const loadMessages = useCallback(async () => {
    if (!activePrime) return;
    const data = await api<{ messages: ChatMessage[] }>(`/api/primes/${activePrime}/messages`);
    if (data?.messages) setMessages(data.messages);
  }, [activePrime]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  // ---- Poll messages every 3s ----
  useEffect(() => {
    if (!activePrime) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadMessages, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activePrime, loadMessages]);

  // ---- Poll primes status every 10s (detect online/offline transitions) ----
  useEffect(() => {
    if (primes.length === 0) return;
    const statusPoll = setInterval(async () => {
      const data = await api<{ primes: PrimeInstance[] }>("/api/primes");
      if (!data?.primes) return;

      setPrimes((prev) => {
        const updated = prev.map((old) => {
          const fresh = data.primes.find((p) => p.id === old.id);
          if (!fresh) return old;

          // Detect status transitions
          if (old.status === "deploying" && fresh.status === "online") {
            // Prime just came online — post a system message
            setMessages((msgs) => [
              ...msgs,
              {
                id: `sys-online-${Date.now()}`,
                sender: "prime",
                text: `✅ Prime "${old.name}" is online and ready!\n\nI can now process your messages. Try "what can you do?" or "hire a devops agent named stan".`,
                timestamp: new Date().toISOString(),
              },
            ]);
          } else if (old.status === "online" && fresh.status === "offline") {
            setMessages((msgs) => [
              ...msgs,
              {
                id: `sys-offline-${Date.now()}`,
                sender: "prime",
                text: `⚠️ Prime "${old.name}" went offline.`,
                timestamp: new Date().toISOString(),
              },
            ]);
          }

          return { ...old, status: fresh.status, fleetCount: fresh.fleetCount };
        });

        // Also add any new primes created from other sessions
        for (const fresh of data.primes) {
          if (!updated.find((p) => p.id === fresh.id)) {
            updated.push(fresh);
          }
        }

        return updated;
      });
    }, 10000);

    return () => clearInterval(statusPoll);
  }, [primes.length]);

  // ---- Load fleet for sidebar (always poll, not just fleet tab) ----
  useEffect(() => {
    if (primes.length === 0) return;
    const loadAllFleet = async () => {
      for (const p of primes) {
        const data = await api<{ fleet: FleetAgent[] }>(`/api/primes/${p.id}/fleet`);
        if (data?.fleet) {
          setSidebarFleet(prev => ({ ...prev, [p.id]: data.fleet }));
          // Also update main fleet state if this is the active prime
          if (p.id === activePrime) setFleet(data.fleet);
        }
      }
    };
    loadAllFleet();
    const fleetPoll = setInterval(loadAllFleet, 8000);
    return () => clearInterval(fleetPoll);
  }, [primes.length, activePrime]);

  // ---- Also load fleet when switching to fleet tab ----
  useEffect(() => {
    if (view !== "fleet" || !activePrime) return;
    const loadFleet = async () => {
      const data = await api<{ fleet: FleetAgent[] }>(`/api/primes/${activePrime}/fleet`);
      if (data?.fleet) setFleet(data.fleet);
    };
    loadFleet();
  }, [view, activePrime]);

  // ---- Auto-scroll chat ----
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---- Send message ----
  const handleSend = async () => {
    if (!input.trim() || !activePrime) return;
    const text = input.trim();
    setInput("");

    // Optimistic update
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [...prev, { id: tempId, sender: "admin", text, timestamp: new Date().toISOString() }]);

    await api(`/api/primes/${activePrime}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  };

  // ---- Deploy Prime ----
  const handleDeploy = async () => {
    if (!newPrimeName.trim()) return;
    setDeploying(true);

    const result = await api<{ id: string; name: string }>("/api/primes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newPrimeName, zone: newPrimeZone }),
    });

    if (result) {
      const newPrime: PrimeInstance = {
        id: result.id, name: result.name, status: "deploying",
        zone: newPrimeZone, fleetCount: 0,
      };
      setPrimes((prev) => [...prev, newPrime]);
      setActivePrime(result.id);
      setSetup((prev) => ({ ...prev, hasPrimes: true }));
      setMessages([{
        id: "sys-deploy", sender: "prime",
        text: `🚀 Deploying Prime "${result.name}" in ${newPrimeZone}...\n\nThis will take about 10 minutes. I'll come online automatically when ready.`,
        timestamp: new Date().toISOString(),
      }]);

      // Trigger VM provisioning
      api(`/api/primes/${result.id}/deploy`, { method: "POST" }).then((r) => {
        setMessages((prev) => [...prev, {
          id: "sys-deploy-status", sender: "prime",
          text: r
            ? "✅ VM creation started. Installing CoreKit + control-daemon..."
            : "⚠️ VM creation failed. Check Cloud Run logs.",
          timestamp: new Date().toISOString(),
        }]);
      });
    }

    setShowDeploy(false);
    setDeploying(false);
    setNewPrimeName("");
  };

  // ---- Hire Agent ----
  const handleHire = async () => {
    if (!hireName.trim() || !activePrime) return;
    setHiring(true);

    await api(`/api/primes/${activePrime}/fleet/hire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: hireName.trim().toLowerCase().replace(/\s+/g, "-"),
        specialty: hireSpecialty,
        email: hireEmail.trim() || undefined,
      }),
    });

    // Optimistic: add to fleet as deploying
    setFleet((prev) => [
      ...prev,
      {
        name: hireName.trim().toLowerCase().replace(/\s+/g, "-"),
        status: "deploying" as const,
        specialty: hireSpecialty,
        email: hireEmail.trim() || "(pending)",
      },
    ]);

    // Also switch to chat view to show the hire command flowing through
    setView("chat");
    setShowHire(false);
    setHiring(false);
    setHireName("");
    setHireEmail("");
  };

  // ---- Fire Agent ----
  const handleFire = async (agentName: string) => {
    if (!activePrime) return;
    if (!confirm(`Fire agent "${agentName}"? This will delete the agent VM.`)) return;

    await api(`/api/primes/${activePrime}/fleet/fire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agentName }),
    });

    // Optimistic: mark as offline
    setFleet((prev) =>
      prev.map((a) => a.name === agentName ? { ...a, status: "offline" as const } : a)
    );

    // Switch to chat to see the fire command flowing
    setView("chat");
  };

  // ---- Test DWD ----
  const handleDwdTest = async () => {
    if (!dwdTestEmail.trim()) return;
    setDwdTesting(true);
    setDwdTestResult(null);

    const result = await api<{success: boolean; message?: string; error?: string; hint?: string}>("/api/setup/dwd-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: dwdTestEmail.trim() }),
    });

    setDwdTestResult(result || { success: false, error: "Network error" });
    setDwdTesting(false);

    if (result?.success) {
      setSetup((prev) => ({ ...prev, dwdConfigured: true }));
    }
  };

  // ---- Load Agent Detail ----
  const loadAgentDetail = async (agentName: string) => {
    if (!activePrime) return;
    setSelectedAgent(agentName);
    setLoadingDetail(true);
    const data = await api<AgentDetail>(`/api/primes/${activePrime}/fleet/${agentName}/logs`);
    setAgentDetail(data);
    setLoadingDetail(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const formatTime = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  // ---- Loading ----
  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.onboarding}>
          <div className={styles["onboarding-card"]}>
            <div className={styles["onboarding-hero"]}>
              <div className={styles["onboarding-logo"]}>A</div>
              <div className={styles["onboarding-title"]}>Loading...</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Onboarding (no Primes deployed yet) ----
  if (primes.length === 0) {
    return (
      <div className={styles.shell}>
        <div className={styles.onboarding}>
          <div className={styles["onboarding-card"]}>
            <div className={styles["onboarding-hero"]}>
              <div className={styles["onboarding-logo"]}>A</div>
              <h1 className={styles["onboarding-title"]}>Welcome to Architect Prime</h1>
              <p className={styles["onboarding-subtitle"]}>
                AI Agent Fleet Management for your organization.<br />
                Let&apos;s get your first Prime instance running.
              </p>
            </div>

            <div className={styles.steps}>
              {/* Step 1: Deploy Prime */}
              <div className={`${styles.step} ${styles.active}`}>
                <div className={styles["step-number"]}>1</div>
                <div className={styles["step-content"]}>
                  <div className={styles["step-title"]}>Deploy your first Prime</div>
                  <div className={styles["step-desc"]}>
                    Prime is your fleet orchestrator. It runs on a VM in this project and manages your AI agent fleet.
                  </div>
                  <div className={styles["step-action"]}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <input
                        className="input"
                        placeholder="Instance name (e.g. alpha)"
                        value={newPrimeName}
                        onChange={(e) => setNewPrimeName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleDeploy(); }}
                        style={{ flex: 1 }}
                      />
                      <select className="input" value={newPrimeZone} onChange={(e) => setNewPrimeZone(e.target.value)} style={{ width: 180 }}>
                        <option value="us-central1-a">us-central1-a</option>
                        <option value="us-east1-b">us-east1-b</option>
                        <option value="us-west1-a">us-west1-a</option>
                        <option value="europe-west1-b">europe-west1-b</option>
                      </select>
                    </div>
                    <button className="btn btn-primary" onClick={handleDeploy} disabled={!newPrimeName.trim() || deploying}>
                      {deploying ? "Deploying..." : "Deploy Prime"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Step 2: DWD Setup */}
              <div className={styles.step}>
                <div className={styles["step-number"]}>2</div>
                <div className={styles["step-content"]}>
                  <div className={styles["step-title"]}>Configure Domain-Wide Delegation</div>
                  <div className={styles["step-desc"]}>
                    Required for fleet agents to communicate via Google Chat. You can do this while Prime deploys. One-time setup.
                  </div>
                  <DWDGuide setup={setup} copied={copied} onCopy={copyToClipboard} />
                </div>
              </div>

              {/* Step 3 */}
              <div className={styles.step}>
                <div className={styles["step-number"]}>3</div>
                <div className={styles["step-content"]}>
                  <div className={styles["step-title"]}>Start chatting with Prime</div>
                  <div className={styles["step-desc"]}>
                    Once online, Prime will appear in the sidebar. Tell it to hire agents, check fleet status, or ask anything.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Main Dashboard ----
  return (
    <div className={styles.shell}>
      {/* ---- Sidebar ---- */}
      <aside className={styles.sidebar}>
        <div className={styles["sidebar-brand"]}>
          <div className={styles["sidebar-brand-icon"]}>A</div>
          <span className={styles["sidebar-brand-text"]}>Architect Prime</span>
        </div>

        <div className={styles["sidebar-section"]}>
          <div className={styles["sidebar-section-title"]}>Prime Instances</div>
          {primes.map((p) => {
            const primeFleet = sidebarFleet[p.id] || [];
            const isExpanded = expandedPrimes[p.id] ?? true;
            return (
              <div key={p.id}>
                <div
                  className={`${styles["sidebar-item"]} ${activePrime === p.id ? styles.active : ""}`}
                  onClick={() => { setActivePrime(p.id); setView("chat"); }}
                >
                  <div className={`${styles["sidebar-item-dot"]} ${styles[p.status]}`} />
                  <span className={styles["sidebar-item-name"]}>{p.name}</span>
                  {primeFleet.length > 0 && (
                    <button
                      className={styles["sidebar-expand-btn"]}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedPrimes(prev => ({ ...prev, [p.id]: !isExpanded }));
                      }}
                      title={isExpanded ? "Collapse agents" : "Expand agents"}
                    >
                      {isExpanded ? "▾" : "▸"}
                    </button>
                  )}
                  {primeFleet.length === 0 && (
                    <span className={styles["sidebar-item-role"]}>
                      0 agents
                    </span>
                  )}
                </div>
                {isExpanded && primeFleet.length > 0 && (
                  <div className={styles["sidebar-fleet"]}>
                    {primeFleet.map((agent) => (
                      <div
                        key={agent.name}
                        className={styles["sidebar-fleet-item"]}
                        onClick={() => { setActivePrime(p.id); setView("fleet"); loadAgentDetail(agent.name); }}
                        title={`${agent.specialty} — ${agent.email}`}
                      >
                        <div className={`${styles["sidebar-fleet-dot"]} ${styles[agent.status]}`} />
                        <span className={styles["sidebar-fleet-name"]}>{agent.name}</span>
                        <span className={styles["sidebar-fleet-role"]}>{agent.specialty}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={styles["sidebar-footer"]}>
          {versionInfo && (
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "center", marginBottom: 6 }}>
              {versionInfo.currentVersion}{versionInfo.updateAvailable && (
                <span style={{ color: "#f0883e", marginLeft: 4 }}>● update</span>
              )}
            </div>
          )}
          <button className={`btn btn-ghost ${styles["sidebar-add-btn"]}`} onClick={() => setShowDeploy(true)}>
            + Deploy Prime
          </button>
        </div>
      </aside>

      {/* ---- Main Panel ---- */}
      <main className={styles.main}>
        {activePrimeData ? (
          <>
            <header className={styles["main-header"]}>
              <div className={styles["main-header-left"]}>
                <h1 className={styles["main-header-title"]}>Prime: {activePrimeData.name}</h1>
                <span className={`badge badge-${activePrimeData.status}`}>{activePrimeData.status}</span>
              </div>
              <div className={styles["main-header-right"]}>
                {(["chat", "fleet", "settings"] as const).map((v) => (
                  <button key={v} className={`btn btn-sm ${view === v ? "btn-primary" : "btn-ghost"}`} onClick={() => setView(v)}>
                    {v === "chat" ? "Chat" : v === "fleet" ? `Fleet (${fleet.length})` : "Setup"}
                  </button>
                ))}
              </div>
            </header>

            {/* ---- DWD Warning Banner ---- */}
            {setup && !setup.dwdConfigured && view !== "settings" && (
              <div style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 24px", background: "rgba(234, 179, 8, 0.08)",
                borderBottom: "1px solid rgba(234, 179, 8, 0.2)",
                fontSize: 13, color: "#eab308",
              }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <span style={{ flex: 1 }}>
                  <strong>Domain-Wide Delegation is not configured.</strong> Fleet agents cannot use Google Chat until DWD is set up.
                </span>
                <button
                  className="btn btn-sm"
                  style={{ borderColor: "rgba(234,179,8,0.3)", color: "#eab308", fontSize: 12 }}
                  onClick={() => setView("settings")}
                >
                  Configure Now →
                </button>
              </div>
            )}

            {/* ---- Chat View ---- */}
            {view === "chat" && (
              <>
                <div className={styles["chat-area"]}>
                  {messages.length === 0 ? (
                    <div className={styles["empty-state"]}>
                      <div className={styles["empty-state-icon"]}>💬</div>
                      <div className={styles["empty-state-title"]}>Start a conversation</div>
                      <div className={styles["empty-state-desc"]}>
                        Send a message to Prime. Try &quot;hire a devops agent named stan&quot; or &quot;what can you do?&quot;
                      </div>
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <div key={msg.id} className={`${styles["chat-message"]} ${styles[`from-${msg.sender}`]}`}>
                        <div className={styles["chat-message-avatar"]}>{msg.sender === "prime" ? "P" : "Y"}</div>
                        <div>
                          <div className={styles["chat-message-content"]}>
                            {msg.text.split("\n").map((line, i) => (
                              <span key={i}>{line}{i < msg.text.split("\n").length - 1 && <br />}</span>
                            ))}
                          </div>
                          <div className={styles["chat-message-meta"]}>{msg.timestamp ? formatTime(msg.timestamp) : ""}</div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div className={styles["chat-input-bar"]}>
                  <div className={styles["chat-input-row"]}>
                    <textarea
                      className={styles["chat-input"]}
                      placeholder={`Message Prime ${activePrimeData.name}...`}
                      value={input} onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown} rows={1}
                    />
                    <button className={`btn btn-primary ${styles["chat-send-btn"]}`} onClick={handleSend} disabled={!input.trim()}>↑</button>
                  </div>
                </div>
              </>
            )}

            {/* ---- Fleet View ---- */}
            {view === "fleet" && (
              <>
                {/* Agent Detail Panel */}
                {selectedAgent && (
                  <div style={{
                    marginBottom: 20, padding: 20, background: "var(--bg-secondary)",
                    borderRadius: 12, border: "1px solid var(--border)",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ fontSize: 18, fontWeight: 600 }}>{selectedAgent}</div>
                        {agentDetail && (
                          <span className={`badge ${agentDetail.healthy ? "badge-online" : "badge-error"}`}>
                            {agentDetail.healthy ? "healthy" : "unhealthy"}
                          </span>
                        )}
                      </div>
                      <button className="btn btn-sm btn-ghost" onClick={() => { setSelectedAgent(null); setAgentDetail(null); }}>✕ Close</button>
                    </div>

                    {loadingDetail ? (
                      <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Loading agent details...</div>
                    ) : agentDetail ? (
                      <div>
                        {/* Deploy Timeline */}
                        {(agentDetail.status === "deploying" || agentDetail.status === "needs_action" || (agentDetail.deploySteps && agentDetail.deploySteps.length > 0)) && (() => {
                          const EXPECTED_STEPS = [
                            { id: "deploy_started", label: "Deployment initiated" },
                            { id: "sa_created", label: "Service account created" },
                            { id: "iam_granted", label: "IAM roles granted" },
                            { id: "vm_created", label: "VM created" },
                            { id: "prime_setup_done", label: "Prime-side setup complete" },
                            { id: "packages_installed", label: "System packages installed" },
                            { id: "docker_installed", label: "Docker CE installed" },
                            { id: "corekit_installed", label: "CoreKit installed" },
                            { id: "openclaw_built", label: "OpenClaw Docker image built" },
                            { id: "gateway_ready", label: "OpenClaw gateway started" },
                            { id: "config_applied", label: "Agent config applied" },
                            { id: "inbox_installed", label: "Inbox daemon started" },
                            { id: "online", label: "Agent online" },
                          ];
                          const completedIds = new Set((agentDetail.deploySteps || []).map(s => s.id));
                          const completedMap = new Map((agentDetail.deploySteps || []).map(s => [s.id, s]));
                          let foundPending = false;

                          return (
                            <div style={{ marginBottom: 20 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Deploy Progress</div>
                              <div className={styles["deploy-timeline"]}>
                                {EXPECTED_STEPS.map((expected) => {
                                  const actual = completedMap.get(expected.id);
                                  let status: string;
                                  let icon: string;
                                  if (actual) {
                                    status = actual.status;
                                    icon = ({ done: "✅", active: "⏳", failed: "❌", skipped: "⏭️" } as Record<string, string>)[actual.status] || "✅";
                                  } else if (agentDetail.status === "online") {
                                    status = "done";
                                    icon = "✅";
                                  } else if (!foundPending && agentDetail.status === "deploying") {
                                    foundPending = true;
                                    status = "active";
                                    icon = "⏳";
                                  } else {
                                    status = "pending";
                                    icon = "⬜";
                                  }
                                  return (
                                    <div key={expected.id} className={`${styles["deploy-step"]} ${styles[`step-${status}`]}`}>
                                      <span className={styles["deploy-step-icon"]}>{icon}</span>
                                      <span className={styles["deploy-step-label"]}>{actual?.label || expected.label}</span>
                                      {actual?.detail && <span className={styles["deploy-step-detail"]}>{actual.detail}</span>}
                                      {actual?.timestamp && (
                                        <span className={styles["deploy-step-time"]}>
                                          {new Date(actual.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                                {/* Show any extra steps not in EXPECTED (e.g. dwd_healthcheck) */}
                                {(agentDetail.deploySteps || []).filter(s => !EXPECTED_STEPS.find(e => e.id === s.id)).map((step, i) => {
                                  const icon = ({ done: "✅", active: "⏳", failed: "❌", skipped: "⏭️" } as Record<string, string>)[step.status] || "❓";
                                  return (
                                    <div key={`extra-${i}`} className={`${styles["deploy-step"]} ${styles[`step-${step.status}`]}`}>
                                      <span className={styles["deploy-step-icon"]}>{icon}</span>
                                      <span className={styles["deploy-step-label"]}>{step.label}</span>
                                      {step.detail && <span className={styles["deploy-step-detail"]}>{step.detail}</span>}
                                      {step.timestamp && (
                                        <span className={styles["deploy-step-time"]}>
                                          {new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Action Required Callout */}
                        {agentDetail.actionRequired && (
                          <div className={styles["action-required"]}>
                            <div className={styles["action-required-header"]}>
                              <span style={{ fontSize: 18 }}>⚠️</span>
                              <span className={styles["action-required-title"]}>{agentDetail.actionRequired.title}</span>
                            </div>
                            <ol className={styles["action-required-list"]}>
                              {agentDetail.actionRequired.instructions.map((inst, i) => (
                                <li key={i}>{inst}</li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {/* Info + Activity Grid */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                          {/* Left: Info */}
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Agent Info</div>
                            <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-secondary)" }}>Specialty</span>
                                <span>{agentDetail.specialty}</span>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-secondary)" }}>VM</span>
                                <code className="mono" style={{ fontSize: 11 }}>{agentDetail.vm || "—"}</code>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-secondary)" }}>Zone</span>
                                <span>{agentDetail.zone || "—"}</span>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-secondary)" }}>Email</span>
                                <code className="mono" style={{ fontSize: 11 }}>{agentDetail.email || "—"}</code>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-secondary)" }}>Uptime</span>
                                <span>{agentDetail.uptimeMinutes != null ? `${agentDetail.uptimeMinutes}m` : "—"}</span>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-secondary)" }}>Last Heartbeat</span>
                                <span>{agentDetail.lastHeartbeat ? formatTime(agentDetail.lastHeartbeat) : "—"}</span>
                              </div>
                            </div>
                          </div>

                          {/* Right: Activity Log */}
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Recent Activity</div>
                            {agentDetail.activity.length === 0 ? (
                              <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No activity recorded yet.</div>
                            ) : (
                              <div style={{ display: "grid", gap: 4, maxHeight: 200, overflowY: "auto" }}>
                                {agentDetail.activity.map((a) => (
                                  <div key={a.id} style={{
                                    padding: "6px 8px", background: "var(--bg-tertiary)", borderRadius: 6, fontSize: 12,
                                    display: "flex", justifyContent: "space-between", gap: 8,
                                  }}>
                                    <span style={{ color: "var(--text-secondary)" }}>{a.summary || a.type}</span>
                                    <span style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>{a.timestamp ? formatTime(a.timestamp) : ""}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Agent not found.</div>
                    )}
                  </div>
                )}

                {/* Fleet Grid */}
                <div className={styles["fleet-grid"]}>
                  {fleet.map((agent) => (
                    <div key={agent.name} className="card">
                      <div className="card-header">
                        <div>
                          <div className="card-title">{agent.name}</div>
                          <div className="card-subtitle">{agent.specialty}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {(agent.status === "deploying" || agent.status === "needs_action" || agent.status === "tearing_down") && agent.deploySteps && agent.deploySteps.length > 0 && (
                            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                              {agent.deploySteps.filter(s => s.status === "done").length}/13 steps
                            </span>
                          )}
                          <span className={`badge badge-${agent.status === "needs_action" ? "warning" : agent.status}`}>{agent.status === "needs_action" ? "action needed" : agent.status === "tearing_down" ? "tearing down" : agent.status}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                        <code className="mono">{agent.email}</code>
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => loadAgentDetail(agent.name)}>Logs</button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleFire(agent.name)}>Fire</button>
                      </div>
                    </div>
                  ))}
                <div
                  className="card"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 140, cursor: "pointer", borderStyle: "dashed", color: "var(--text-tertiary)", fontSize: 14 }}
                  onClick={() => setShowHire(true)}
                >
                  + Hire Agent
                </div>
              </div>
              </>
            )}

            {/* ---- Setup/Settings View ---- */}
            {view === "settings" && (
              <div className={styles["settings-panel"]}>
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

                <div className={styles["settings-section"]}>
                  <div className={styles["settings-section-title"]}>Version & Upgrade</div>
                  {versionInfo ? (
                    <div style={{ display: "grid", gap: 10 }}>
                      <div className={styles["settings-row"]}>
                        <div className={styles["settings-label"]}>Current Version</div>
                        <div className={styles["settings-value"]}><code className="mono">{versionInfo.currentVersion}</code></div>
                      </div>
                      <div className={styles["settings-row"]}>
                        <div className={styles["settings-label"]}>Latest Version</div>
                        <div className={styles["settings-value"]}>
                          <code className="mono">{versionInfo.latestVersion}</code>
                          {versionInfo.updateAvailable && (
                            <span className="badge badge-deploying" style={{ marginLeft: 8, fontSize: 10 }}>update available</span>
                          )}
                        </div>
                      </div>
                      <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn btn-primary" onClick={async () => {
                          setUpgrading(true);
                          const result = await api<{success: boolean; message?: string; error?: string}>("/api/upgrade", { method: "POST" });
                          setUpgrading(false);
                          if (result?.success) alert(result.message || "Dashboard upgrade initiated!");
                          else alert(result?.error || "Upgrade failed");
                        }} disabled={upgrading}>
                          {upgrading ? "Upgrading..." : "Upgrade Dashboard"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Loading version info...</div>
                  )}
                </div>

                <div className={styles["settings-section"]}>
                  <div className={styles["settings-section-title"]}>Prime VM Operations</div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
                    These operations execute on the Prime VM host via the command queue. They are deterministic and not affected by gateway restarts.
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn btn-primary" onClick={async () => {
                      if (!activePrime) return;
                      if (!confirm("Upgrade CoreKit on the Prime VM? This will also restart the gateway.")) return;
                      const result = await api<{id: string}>(`/api/primes/${activePrime}/commands`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ type: "upgrade_corekit", args: { ref: "main" } }),
                      });
                      if (result?.id) alert(`CoreKit upgrade queued (command: ${result.id}). The command-runner will execute it.`);
                      else alert("Failed to queue upgrade command.");
                    }}>
                      ⬆ Upgrade CoreKit
                    </button>
                    <button className="btn btn-ghost" style={{ borderColor: "var(--border)" }} onClick={async () => {
                      if (!activePrime) return;
                      if (!confirm("Restart the OpenClaw gateway on the Prime VM?")) return;
                      const result = await api<{id: string}>(`/api/primes/${activePrime}/commands`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ type: "gateway_restart", args: {} }),
                      });
                      if (result?.id) alert(`Gateway restart queued (command: ${result.id}).`);
                      else alert("Failed to queue restart command.");
                    }}>
                      ↻ Restart Gateway
                    </button>
                  </div>
                </div>

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
                    <div className={styles["settings-value"]}>{primes.length}</div>
                  </div>
                  <div className={styles["settings-row"]}>
                    <div className={styles["settings-label"]}>Fleet Count</div>
                    <div className={styles["settings-value"]}>{fleet.length}</div>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className={styles["empty-state"]}>
            <div className={styles["empty-state-icon"]}>🏗️</div>
            <div className={styles["empty-state-title"]}>No Prime Selected</div>
            <div className={styles["empty-state-desc"]}>Select a Prime from the sidebar or deploy a new one.</div>
          </div>
        )}
      </main>

      {/* ---- Deploy Modal ---- */}
      {showDeploy && (
        <div className={styles["modal-overlay"]} onClick={() => setShowDeploy(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles["modal-title"]}>Deploy New Prime</div>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Instance Name</label>
              <input className="input" placeholder="e.g. charlie" autoFocus value={newPrimeName}
                onChange={(e) => setNewPrimeName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleDeploy(); }} />
            </div>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Zone</label>
              <select className="input" value={newPrimeZone} onChange={(e) => setNewPrimeZone(e.target.value)}>
                <option value="us-central1-a">us-central1-a</option>
                <option value="us-east1-b">us-east1-b</option>
                <option value="us-west1-a">us-west1-a</option>
                <option value="europe-west1-b">europe-west1-b</option>
              </select>
            </div>
            <div className={styles["modal-actions"]}>
              <button className="btn btn-ghost" onClick={() => setShowDeploy(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleDeploy} disabled={!newPrimeName.trim() || deploying}>
                {deploying ? "Deploying..." : "Deploy"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Hire Agent Modal ---- */}
      {showHire && (
        <div className={styles["modal-overlay"]} onClick={() => setShowHire(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles["modal-title"]}>Hire Fleet Agent</div>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 16px" }}>
              Each agent gets its own VM, workspace, and specialist toolset. Prime manages the lifecycle.
            </p>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Agent Name</label>
              <input className="input" placeholder="e.g. stan" autoFocus value={hireName}
                onChange={(e) => setHireName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleHire(); }} />
            </div>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Specialty</label>
              <select className="input" value={hireSpecialty} onChange={(e) => setHireSpecialty(e.target.value)}>
                <option value="devops">DevOps — GCP, infra, CI/CD, reliability</option>
                <option value="swe">SWE — Code, architecture, testing</option>
                <option value="qa">QA — Testing, automation, quality</option>
                <option value="pm">PM — Planning, tickets, coordination</option>
                <option value="data">Data — Analytics, pipelines, BigQuery</option>
                <option value="security">Security — IAM, compliance, audit</option>
              </select>
            </div>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Workspace Email <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>(optional)</span></label>
              <input className="input" placeholder="e.g. devops-stan@yourcompany.com" value={hireEmail}
                onChange={(e) => setHireEmail(e.target.value)} />
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
                If provided, the agent will use this email for Google Chat via DWD. Create the account in Google Admin first.
              </div>
            </div>
            <div className={styles["modal-actions"]}>
              <button className="btn btn-ghost" onClick={() => setShowHire(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleHire} disabled={!hireName.trim() || hiring}>
                {hiring ? "Hiring..." : "Hire Agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- DWD Guide Component ---- */
function DWDGuide({ setup, copied, onCopy }: {
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
