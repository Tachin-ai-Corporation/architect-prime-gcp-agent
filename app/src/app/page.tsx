"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./page.module.css";

/* ---- Types ---- */
interface PrimeInstance {
  id: string;
  name: string;
  status: "online" | "offline" | "deploying";
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
  status: "online" | "offline" | "deploying";
  specialty: string;
  email: string;
}

/* ---- Mock fallback (local dev without Firestore) ---- */
const MOCK_PRIMES: PrimeInstance[] = [
  { id: "alpha", name: "Alpha", status: "online", zone: "us-central1-a", fleetCount: 2 },
  { id: "bravo", name: "Bravo", status: "offline", zone: "us-east1-b", fleetCount: 0 },
];

const MOCK_MESSAGES: ChatMessage[] = [
  { id: "1", sender: "admin", text: "Hire a devops agent named stan", timestamp: new Date(Date.now() - 300000).toISOString() },
  { id: "2", sender: "prime", text: "Starting deployment of stan as a DevOps specialist.\n\nI'll create a VM, install CoreKit, and configure DWD access. This will take about 15 minutes.\n\nIn the meantime, please create a Workspace email: devops-agent-stan@yourdomain.com", timestamp: new Date(Date.now() - 280000).toISOString() },
  { id: "3", sender: "admin", text: "What's stan's status?", timestamp: new Date(Date.now() - 60000).toISOString() },
  { id: "4", sender: "prime", text: "✅ stan is online and responding to GChat messages.\n\nFleet status:\n• stan (DevOps) — Online\n• ana (QA) — Online", timestamp: new Date(Date.now() - 40000).toISOString() },
];

const MOCK_FLEET: FleetAgent[] = [
  { name: "stan", status: "online", specialty: "DevOps", email: "devops-agent-stan@tachin.ai" },
  { name: "ana", status: "online", specialty: "QA Engineering", email: "qa-agent-ana@tachin.ai" },
];

/* ---- API helpers ---- */
async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T | null> {
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
  const [primes, setPrimes] = useState<PrimeInstance[]>(MOCK_PRIMES);
  const [activePrime, setActivePrime] = useState<string>("alpha");
  const [messages, setMessages] = useState<ChatMessage[]>(MOCK_MESSAGES);
  const [fleet, setFleet] = useState<FleetAgent[]>(MOCK_FLEET);
  const [input, setInput] = useState("");
  const [showDeploy, setShowDeploy] = useState(false);
  const [view, setView] = useState<"chat" | "fleet">("chat");
  const [newPrimeName, setNewPrimeName] = useState("");
  const [newPrimeZone, setNewPrimeZone] = useState("us-central1-a");
  const [deploying, setDeploying] = useState(false);
  const [useMock, setUseMock] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activePrimeData = primes.find((p) => p.id === activePrime);

  // Try to load from API on mount
  useEffect(() => {
    (async () => {
      const data = await fetchJSON<{ primes: PrimeInstance[] }>("/api/primes");
      if (data && data.primes && data.primes.length > 0) {
        setPrimes(data.primes);
        setActivePrime(data.primes[0].id);
        setUseMock(false);
      }
    })();
  }, []);

  // Load messages when activePrime changes (API mode)
  const loadMessages = useCallback(async () => {
    if (useMock) return;
    const data = await fetchJSON<{ messages: ChatMessage[] }>(
      `/api/primes/${activePrime}/messages`
    );
    if (data?.messages) {
      setMessages(data.messages);
    }
  }, [activePrime, useMock]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Poll for new messages every 3 seconds (API mode)
  useEffect(() => {
    if (useMock) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadMessages, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [useMock, loadMessages]);

  // Load fleet when switching to fleet view
  useEffect(() => {
    if (view !== "fleet" || useMock) return;
    (async () => {
      const data = await fetchJSON<{ fleet: FleetAgent[] }>(
        `/api/primes/${activePrime}/fleet`
      );
      if (data?.fleet) setFleet(data.fleet);
    })();
  }, [view, activePrime, useMock]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send message
  const handleSend = async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");

    if (useMock) {
      // Mock mode: local state only
      const msg: ChatMessage = {
        id: String(Date.now()),
        sender: "admin",
        text,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, msg]);
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            sender: "prime",
            text: "I'm processing your request. This is a demo — connect to Firestore for real responses.",
            timestamp: new Date().toISOString(),
          },
        ]);
      }, 1200);
      return;
    }

    // API mode: write to Firestore via API
    const result = await fetchJSON<{ id: string }>(
      `/api/primes/${activePrime}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }
    );

    if (result) {
      // Optimistically add to local state
      setMessages((prev) => [
        ...prev,
        { id: result.id, sender: "admin", text, timestamp: new Date().toISOString() },
      ]);
    }
  };

  // Deploy new Prime
  const handleDeploy = async () => {
    if (!newPrimeName.trim()) return;
    setDeploying(true);

    if (useMock) {
      const id = newPrimeName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      setPrimes((prev) => [
        ...prev,
        {
          id,
          name: newPrimeName,
          status: "deploying",
          zone: newPrimeZone,
          fleetCount: 0,
        },
      ]);
      setActivePrime(id);
      setMessages([]);
      setFleet([]);
      setShowDeploy(false);
      setDeploying(false);
      setNewPrimeName("");
      return;
    }

    const result = await fetchJSON<{ id: string; name: string }>(
      "/api/primes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newPrimeName, zone: newPrimeZone }),
      }
    );

    if (result) {
      const newPrime: PrimeInstance = {
        id: result.id,
        name: result.name,
        status: "deploying",
        zone: newPrimeZone,
        fleetCount: 0,
      };
      setPrimes((prev) => [...prev, newPrime]);
      setActivePrime(result.id);
      setFleet([]);
      setMessages([
        {
          id: "sys-deploy",
          sender: "prime",
          text: `🚀 Deploying Prime "${result.name}" in ${newPrimeZone}...\n\nThis will take about 10 minutes. I'll come online automatically when ready.`,
          timestamp: new Date().toISOString(),
        },
      ]);

      // Trigger VM provisioning
      fetchJSON(`/api/primes/${result.id}/deploy`, { method: "POST" }).then(
        (deployResult) => {
          if (deployResult) {
            setMessages((prev) => [
              ...prev,
              {
                id: "sys-deploy-ok",
                sender: "prime",
                text: "✅ VM creation started. Installing CoreKit and starting control-daemon...",
                timestamp: new Date().toISOString(),
              },
            ]);
          } else {
            setMessages((prev) => [
              ...prev,
              {
                id: "sys-deploy-err",
                sender: "prime",
                text: "⚠️ VM creation failed. Check the Cloud Run logs for details.",
                timestamp: new Date().toISOString(),
              },
            ]);
            setPrimes((prev) =>
              prev.map((p) => (p.id === result.id ? { ...p, status: "offline" } : p))
            );
          }
        }
      );
    }

    setShowDeploy(false);
    setDeploying(false);
    setNewPrimeName("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

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
              onClick={() => {
                setActivePrime(p.id);
                setView("chat");
              }}
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
          <button
            className={`btn btn-ghost ${styles["sidebar-add-btn"]}`}
            onClick={() => setShowDeploy(true)}
          >
            + Deploy Prime
          </button>
          {useMock && (
            <div style={{ marginTop: 8, textAlign: "center", fontSize: 10, color: "var(--text-tertiary)" }}>
              Demo Mode (no Firestore)
            </div>
          )}
        </div>
      </aside>

      {/* ---- Main ---- */}
      <main className={styles.main}>
        {activePrimeData ? (
          <>
            <header className={styles["main-header"]}>
              <div className={styles["main-header-left"]}>
                <h1 className={styles["main-header-title"]}>
                  Prime: {activePrimeData.name}
                </h1>
                <span className={`badge badge-${activePrimeData.status}`}>
                  {activePrimeData.status}
                </span>
              </div>
              <div className={styles["main-header-right"]}>
                <button
                  className={`btn btn-sm ${view === "chat" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setView("chat")}
                >
                  Chat
                </button>
                <button
                  className={`btn btn-sm ${view === "fleet" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setView("fleet")}
                >
                  Fleet ({fleet.length})
                </button>
                <button className="btn btn-sm btn-ghost">⚙</button>
              </div>
            </header>

            {view === "chat" ? (
              <>
                <div className={styles["chat-area"]}>
                  {messages.length === 0 ? (
                    <div className={styles["empty-state"]}>
                      <div className={styles["empty-state-icon"]}>💬</div>
                      <div className={styles["empty-state-title"]}>Start a conversation</div>
                      <div className={styles["empty-state-desc"]}>
                        Send a message to Prime {activePrimeData.name}. Try &quot;hire a devops agent named stan&quot; or &quot;what can you do?&quot;
                      </div>
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`${styles["chat-message"]} ${styles[`from-${msg.sender}`]}`}
                      >
                        <div className={styles["chat-message-avatar"]}>
                          {msg.sender === "prime" ? "P" : "Y"}
                        </div>
                        <div>
                          <div className={styles["chat-message-content"]}>
                            {msg.text.split("\n").map((line, i) => (
                              <span key={i}>
                                {line}
                                {i < msg.text.split("\n").length - 1 && <br />}
                              </span>
                            ))}
                          </div>
                          <div className={styles["chat-message-meta"]}>
                            {msg.timestamp ? formatTime(msg.timestamp) : ""}
                          </div>
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
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      rows={1}
                    />
                    <button
                      className={`btn btn-primary ${styles["chat-send-btn"]}`}
                      onClick={handleSend}
                      disabled={!input.trim()}
                    >
                      ↑
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className={styles["fleet-grid"]}>
                {fleet.map((agent) => (
                  <div key={agent.name} className="card">
                    <div className="card-header">
                      <div>
                        <div className="card-title">{agent.name}</div>
                        <div className="card-subtitle">{agent.specialty}</div>
                      </div>
                      <span className={`badge badge-${agent.status}`}>
                        {agent.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                      <code className="mono">{agent.email}</code>
                    </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
                      <button className="btn btn-sm btn-ghost">Logs</button>
                      <button className="btn btn-sm btn-danger">Fire</button>
                    </div>
                  </div>
                ))}
                <div
                  className="card"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 140,
                    cursor: "pointer",
                    borderStyle: "dashed",
                    color: "var(--text-tertiary)",
                    fontSize: 14,
                  }}
                >
                  + Hire Agent
                </div>
              </div>
            )}
          </>
        ) : (
          <div className={styles["empty-state"]}>
            <div className={styles["empty-state-icon"]}>🏗️</div>
            <div className={styles["empty-state-title"]}>No Prime Selected</div>
            <div className={styles["empty-state-desc"]}>
              Select a Prime instance from the sidebar or deploy a new one.
            </div>
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
              <input
                className="input"
                placeholder="e.g. charlie"
                autoFocus
                value={newPrimeName}
                onChange={(e) => setNewPrimeName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleDeploy(); }}
              />
            </div>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Zone</label>
              <select
                className="input"
                value={newPrimeZone}
                onChange={(e) => setNewPrimeZone(e.target.value)}
              >
                <option value="us-central1-a">us-central1-a</option>
                <option value="us-east1-b">us-east1-b</option>
                <option value="us-west1-a">us-west1-a</option>
                <option value="europe-west1-b">europe-west1-b</option>
              </select>
            </div>
            <div className={styles["modal-actions"]}>
              <button className="btn btn-ghost" onClick={() => setShowDeploy(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleDeploy}
                disabled={!newPrimeName.trim() || deploying}
              >
                {deploying ? "Deploying..." : "Deploy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
