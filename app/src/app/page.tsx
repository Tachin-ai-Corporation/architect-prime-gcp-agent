"use client";

import { useState, useRef, useEffect } from "react";
import styles from "./page.module.css";

/* ---- Mock data (will be replaced by Firestore) ---- */
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
  timestamp: Date;
}

interface FleetAgent {
  name: string;
  status: "online" | "offline" | "deploying";
  specialty: string;
  email: string;
}

const MOCK_PRIMES: PrimeInstance[] = [
  { id: "alpha", name: "Alpha", status: "online", zone: "us-central1-a", fleetCount: 2 },
  { id: "bravo", name: "Bravo", status: "offline", zone: "us-east1-b", fleetCount: 0 },
];

const MOCK_MESSAGES: ChatMessage[] = [
  { id: "1", sender: "admin", text: "Hire a devops agent named stan", timestamp: new Date(Date.now() - 300000) },
  { id: "2", sender: "prime", text: "Starting deployment of stan as a DevOps specialist.\n\nI'll create a VM, install CoreKit, and configure DWD access. This will take about 15 minutes.\n\nIn the meantime, please create a Workspace email: devops-agent-stan@yourdomain.com", timestamp: new Date(Date.now() - 280000) },
  { id: "3", sender: "admin", text: "What's stan's status?", timestamp: new Date(Date.now() - 60000) },
  { id: "4", sender: "prime", text: "✅ **stan** is online and responding to GChat messages.\n\nFleet status:\n• stan (DevOps) — Online\n• ana (QA) — Online", timestamp: new Date(Date.now() - 40000) },
];

const MOCK_FLEET: FleetAgent[] = [
  { name: "stan", status: "online", specialty: "DevOps", email: "devops-agent-stan@tachin.ai" },
  { name: "ana", status: "online", specialty: "QA Engineering", email: "qa-agent-ana@tachin.ai" },
];

/* ---- Component ---- */
export default function Home() {
  const [primes] = useState<PrimeInstance[]>(MOCK_PRIMES);
  const [activePrime, setActivePrime] = useState<string>("alpha");
  const [messages, setMessages] = useState<ChatMessage[]>(MOCK_MESSAGES);
  const [fleet] = useState<FleetAgent[]>(MOCK_FLEET);
  const [input, setInput] = useState("");
  const [showDeploy, setShowDeploy] = useState(false);
  const [view, setView] = useState<"chat" | "fleet">("chat");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const activePrimeData = primes.find((p) => p.id === activePrime);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    const msg: ChatMessage = {
      id: String(Date.now()),
      sender: "admin",
      text: input.trim(),
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, msg]);
    setInput("");

    // Simulate Prime response
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          sender: "prime",
          text: "I'm processing your request. This is a demo — the real Prime VM will respond via Firestore polling.",
          timestamp: new Date(),
        },
      ]);
    }, 1200);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
              onClick={() => setActivePrime(p.id)}
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
        </div>
      </aside>

      {/* ---- Main ---- */}
      <main className={styles.main}>
        {activePrimeData ? (
          <>
            {/* Header */}
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
                {/* Chat Messages */}
                <div className={styles["chat-area"]}>
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`${styles["chat-message"]} ${
                        styles[`from-${msg.sender}`]
                      }`}
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
                          {formatTime(msg.timestamp)}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>

                {/* Chat Input */}
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
              /* Fleet Grid */
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
        <div
          className={styles["modal-overlay"]}
          onClick={() => setShowDeploy(false)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles["modal-title"]}>Deploy New Prime</div>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Instance Name</label>
              <input className="input" placeholder="e.g. charlie" autoFocus />
            </div>
            <div className={styles["modal-field"]}>
              <label className={styles["modal-label"]}>Zone</label>
              <select className="input" defaultValue="us-central1-a">
                <option>us-central1-a</option>
                <option>us-east1-b</option>
                <option>us-west1-a</option>
                <option>europe-west1-b</option>
              </select>
            </div>
            <div className={styles["modal-actions"]}>
              <button
                className="btn btn-ghost"
                onClick={() => setShowDeploy(false)}
              >
                Cancel
              </button>
              <button className="btn btn-primary">Deploy</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
