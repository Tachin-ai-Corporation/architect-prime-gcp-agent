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
  status: "online" | "offline" | "deploying" | "error";
  specialty: string;
  email: string;
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

  // ---- Load fleet ----
  useEffect(() => {
    if (view !== "fleet" || !activePrime) return;
    (async () => {
      const data = await api<{ fleet: FleetAgent[] }>(`/api/primes/${activePrime}/fleet`);
      if (data?.fleet) setFleet(data.fleet);
    })();
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
          {primes.map((p) => (
            <div
              key={p.id}
              className={`${styles["sidebar-item"]} ${activePrime === p.id ? styles.active : ""}`}
              onClick={() => { setActivePrime(p.id); setView("chat"); }}
            >
              <div className={`${styles["sidebar-item-dot"]} ${styles[p.status]}`} />
              <span className={styles["sidebar-item-name"]}>{p.name}</span>
              <span className={styles["sidebar-item-role"]}>
                {p.fleetCount} agent{p.fleetCount !== 1 ? "s" : ""}
              </span>
            </div>
          ))}
        </div>

        <div className={styles["sidebar-footer"]}>
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
              <div className={styles["fleet-grid"]}>
                {fleet.map((agent) => (
                  <div key={agent.name} className="card">
                    <div className="card-header">
                      <div>
                        <div className="card-title">{agent.name}</div>
                        <div className="card-subtitle">{agent.specialty}</div>
                      </div>
                      <span className={`badge badge-${agent.status}`}>{agent.status}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                      <code className="mono">{agent.email}</code>
                    </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
                      <button className="btn btn-sm btn-ghost">Logs</button>
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
            )}

            {/* ---- Setup/Settings View ---- */}
            {view === "settings" && (
              <div className={styles["settings-panel"]}>
                <div className={styles["settings-section"]}>
                  <div className={styles["settings-section-title"]}>Domain-Wide Delegation</div>
                  <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
                    DWD allows fleet agents to send and receive Google Chat messages on behalf of their Workspace email accounts.
                    This is a one-time setup in your Google Workspace Admin Console.
                  </p>
                  <DWDGuide setup={setup} copied={copied} onCopy={copyToClipboard} />
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
