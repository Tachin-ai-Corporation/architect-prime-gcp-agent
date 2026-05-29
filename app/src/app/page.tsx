"use client";

import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import styles from "./page.module.css";
import { DialogProvider, useDialog } from "@/components/DialogProvider";
import { DWDGuide } from "@/components/settings/IntegrationTab";
import { ChatPanel } from "@/components/ChatPanel";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import type { PrimeInstance, SetupState, FleetAgent, DeployStep } from "@/lib/types";

interface AgentType {
  id: string;
  title: string;
  specialty: string;
  emailPattern: string;
  skills: string[];
}

/* ---- SVG connection line data ---- */
interface ConnectionLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  id: string;
}

/* ---- Chat target ---- */
interface ChatTarget {
  type: "prime" | "agent";
  primeId: string;
  agentName?: string;
  entityName: string;
  entityStatus: string;
  specialty?: string;
}

function HomeInner() {
  const dialog = useDialog();
  const { primes, setup, sidebarFleet, loading, versionInfo, refreshPrimes } = usePrime();

  /* ---- State ---- */
  const [selectedPrimeId, setSelectedPrimeId] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [newPrimeName, setNewPrimeName] = useState("");
  const [newPrimeZone, setNewPrimeZone] = useState("us-central1-a");
  const [deploying, setDeploying] = useState(false);
  const [copied, setCopied] = useState("");
  const [lines, setLines] = useState<ConnectionLine[]>([]);
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null);
  const [chatWidth, setChatWidth] = useState(420); // pixels

  /* ---- Hire state ---- */
  const [showHire, setShowHire] = useState(false);
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [hireName, setHireName] = useState("");
  const [hireType, setHireType] = useState("");
  const [hiring, setHiring] = useState(false);

  /* ---- Refs ---- */
  const containerRef = useRef<HTMLDivElement>(null);
  const primeChipRef = useRef<HTMLButtonElement>(null);
  const agentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isDragging = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);

  /* ---- Auto-select first prime ---- */
  useEffect(() => {
    if (primes.length > 0 && !selectedPrimeId) {
      setSelectedPrimeId(primes[0].id);
    }
  }, [primes, selectedPrimeId]);

  /* ---- Derived data ---- */
  const selectedPrime = primes.find((p) => p.id === selectedPrimeId);
  const selectedFleet = selectedPrimeId ? sidebarFleet[selectedPrimeId] || [] : [];
  const activeFleet = selectedFleet.filter((a) => a.status !== "removed");

  /* ---- Compute SVG connection lines ---- */
  const computeLines = useCallback(() => {
    const container = containerRef.current;
    const primeEl = primeChipRef.current;
    if (!container || !primeEl || activeFleet.length === 0) {
      setLines([]);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const primeRect = primeEl.getBoundingClientRect();
    const x1 = primeRect.left + primeRect.width / 2 - containerRect.left;
    const y1 = primeRect.bottom - containerRect.top;

    const newLines: ConnectionLine[] = [];
    agentCardRefs.current.forEach((el, name) => {
      const agentRect = el.getBoundingClientRect();
      const x2 = agentRect.left + agentRect.width / 2 - containerRect.left;
      const y2 = agentRect.top - containerRect.top;
      newLines.push({ x1, y1, x2, y2, id: name });
    });

    setLines(newLines);
  }, [activeFleet.length]);

  useLayoutEffect(() => {
    const timer = setTimeout(computeLines, 100);
    return () => clearTimeout(timer);
  }, [computeLines, selectedPrimeId]);

  /* ---- ResizeObserver ---- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => computeLines());
    observer.observe(container);
    return () => observer.disconnect();
  }, [computeLines]);

  /* ---- Chat panel resize (left-edge drag) ---- */
  const handleResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const newWidth = window.innerWidth - ev.clientX;
      setChatWidth(Math.max(320, Math.min(800, newWidth)));
    };

    const handleUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, []);

  /* ---- Select Prime for chat ---- */
  const selectPrimeChat = useCallback((prime: PrimeInstance) => {
    setSelectedPrimeId(prime.id);
    setChatTarget({
      type: "prime",
      primeId: prime.id,
      entityName: prime.name,
      entityStatus: prime.status,
    });
  }, []);

  /* ---- Select Agent for chat ---- */
  const selectAgentChat = useCallback((agent: FleetAgent) => {
    if (!selectedPrimeId) return;
    setChatTarget({
      type: "agent",
      primeId: selectedPrimeId,
      agentName: agent.name,
      entityName: agent.name,
      entityStatus: agent.status,
      specialty: agent.specialty,
    });
  }, [selectedPrimeId]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  /* ---- Deploy Prime ---- */
  const handleDeploy = async () => {
    if (!newPrimeName.trim()) return;
    setDeploying(true);

    const result = await api<{ id: string; name: string }>("/api/primes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newPrimeName, zone: newPrimeZone }),
    });

    if (result) {
      api(`/api/primes/${result.id}/deploy`, { method: "POST" });
      dialog.toast({
        message: `Deploying Prime "${result.name}" in ${newPrimeZone}…`,
        variant: "success",
        duration: 5000,
      });
      refreshPrimes();
    }

    setShowDeploy(false);
    setDeploying(false);
    setNewPrimeName("");
  };

  /* ---- Hire agent ---- */
  const openHireModal = async () => {
    setShowHire(true);
    if (agentTypes.length === 0) {
      const res = await api<{ types: AgentType[] }>("/api/agent-types");
      if (res?.types) {
        setAgentTypes(res.types);
        if (res.types.length > 0) setHireType(res.types[0].id);
      }
    }
  };

  // Auto-generate email from type + name + domain
  const generatedEmail = hireName && hireType
    ? `${hireType}-agent-${hireName}@${setup.agentEmailDomain || 'example.com'}`
    : '';

  const handleHire = async () => {
    if (!hireName.trim() || !hireType || !generatedEmail || !selectedPrimeId) return;
    setHiring(true);
    const res = await api<{ id: string }>(`/api/primes/${selectedPrimeId}/fleet/hire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: hireName, specialty: hireType, email: generatedEmail }),
    });
    if (res?.id) {
      dialog.trackCommand(selectedPrimeId, res.id, `Hire ${hireName}`);
      refreshPrimes();
    } else {
      dialog.toast({ message: "Failed to hire agent.", variant: "error" });
    }
    setShowHire(false);
    setHiring(false);
    setHireName("");
  };

  /* ---- Status class helper ---- */
  const statusClass = (status: string) => {
    switch (status) {
      case "online":
        return styles.statusOnline;
      case "deploying":
        return styles.statusDeploying;
      case "error":
        return styles.statusError;
      default:
        return styles.statusOffline;
    }
  };

  /* ---- Deploy progress helper ---- */
  const getDeployProgress = (steps: DeployStep[] | undefined) => {
    if (!steps || steps.length === 0) return null;
    const done = steps.filter((s) => s.status === "done").length;
    const failed = steps.filter((s) => s.status === "failed").length;
    const active = steps.find((s) => s.status === "active");
    const lastDone = [...steps].reverse().find((s) => s.status === "done");
    const progress = Math.round((done / steps.length) * 100);
    return { progress, done, total: steps.length, failed, activeStep: active, lastDoneStep: lastDone };
  };

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.loading} id="home-loading">
        <div className={styles.loadingCard}>
          <Image src="/architect-prime-logo.png" alt="Architect Prime" width={48} height={48} className={styles.loadingLogo} />
          <div className={styles.loadingText}>Loading<span className={styles.loadingDots} /></div>
        </div>
      </div>
    );
  }

  /* ---- Onboarding (no primes) ---- */
  if (primes.length === 0) {
    return (
      <div className={styles.onboarding} id="home-onboarding">
        <div className={styles.onboardingCard}>
          <div className={styles.onboardingHero}>
            <Image src="/architect-prime-logo.png" alt="Architect Prime" width={64} height={64} className={styles.onboardingLogo} />
            <h1 className={styles.onboardingTitle}>Welcome to Architect Prime</h1>
            <p className={styles.onboardingSubtitle}>
              AI Agent Fleet Management for your organization.<br />
              Let&apos;s get your first Prime instance running.
            </p>
          </div>
          <div className={styles.steps}>
            <div className={`${styles.step} ${styles.active}`}>
              <div className={styles.stepNumber}>1</div>
              <div className={styles.stepContent}>
                <div className={styles.stepTitle}>Deploy your first Prime</div>
                <div className={styles.stepDesc}>
                  Prime is your fleet orchestrator. It runs on a VM in this project and manages your AI agent fleet.
                </div>
                <div className={styles.stepAction}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <input
                      id="onboarding-prime-name"
                      className="input"
                      placeholder="Instance name (e.g. alpha)"
                      value={newPrimeName}
                      onChange={(e) => setNewPrimeName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDeploy(); }}
                      style={{ flex: 1 }}
                    />
                    <select
                      id="onboarding-prime-zone"
                      className="input"
                      value={newPrimeZone}
                      onChange={(e) => setNewPrimeZone(e.target.value)}
                      style={{ width: 180 }}
                    >
                      <option value="us-central1-a">us-central1-a</option>
                      <option value="us-east1-b">us-east1-b</option>
                      <option value="us-west1-a">us-west1-a</option>
                      <option value="europe-west1-b">europe-west1-b</option>
                    </select>
                  </div>
                  <button
                    id="onboarding-deploy-btn"
                    className="btn btn-primary"
                    onClick={handleDeploy}
                    disabled={!newPrimeName.trim() || deploying}
                  >
                    {deploying ? "Deploying…" : "Deploy Prime"}
                  </button>
                </div>
              </div>
            </div>
            <div className={styles.step}>
              <div className={styles.stepNumber}>2</div>
              <div className={styles.stepContent}>
                <div className={styles.stepTitle}>Configure Domain-Wide Delegation</div>
                <div className={styles.stepDesc}>
                  Required for fleet agents to communicate via Google Chat. You can do this while Prime deploys.
                </div>
                <DWDGuide setup={setup} copied={copied} onCopy={copyToClipboard} />
              </div>
            </div>
            <div className={styles.step}>
              <div className={styles.stepNumber}>3</div>
              <div className={styles.stepContent}>
                <div className={styles.stepTitle}>Start chatting with Prime</div>
                <div className={styles.stepDesc}>
                  Once online, click your Prime to open the hub. Chat, manage fleet, and monitor work.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ==================================================
     Living Agent Graph — Split Panel Layout
     ================================================== */

  /* Shared sub-page quick nav — same icons for Prime and Fleet */
  const navItems = [
    { label: "Projects", path: "projects" },
    { label: "Processes", path: "processes" },
    { label: "Work", path: "work" },
    { label: "Brain", path: "brain" },
    { label: "Skills", path: "skills" },
    { label: "Agent Types", path: "agent-types" },
  ];

  return (
    <div className={styles.homeShell} id="home-page">
      {/* ---- Full-width Graph ---- */}
      <div
        className={styles.splitPanel}
        ref={splitRef}
      >
        <div className={styles.leftPanel}>
          <div className={styles.graphContainer} ref={containerRef}>

            {/* ---- Prime Chip Bar ---- */}
            <div className={styles.primeChipBar} id="prime-chip-bar">
              {primes.map((p) => {
                const isSelected = p.id === selectedPrimeId;
                return (
                  <button
                    key={p.id}
                    id={`prime-chip-${p.id}`}
                    ref={isSelected ? primeChipRef : undefined}
                    className={`${styles.primeChip} ${isSelected ? styles.primeChipSelected : ""}`}
                    onClick={() => selectPrimeChat(p)}
                  >
                    <span className={`${styles.statusDot} ${statusClass(p.status)}`} />
                    <span className={styles.chipName}>{p.name}</span>
                    <span className={styles.chipMeta}>
                      {(sidebarFleet[p.id] || []).filter((a) => a.status !== "removed").length} agent{(sidebarFleet[p.id] || []).filter((a) => a.status !== "removed").length !== 1 ? "s" : ""}
                    </span>
                    {/* Inline nav icons for selected prime */}
                    {isSelected && (
                      <span className={styles.chipNavIcons}>
                        {navItems.map((item) => (
                          <Link
                            key={item.path}
                            href={`/${item.path}?prime=${p.id}`}
                            className={styles.chipNavIcon}
                            data-tooltip={item.label}
                            id={`prime-nav-${item.path}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {item.label}
                          </Link>
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Deploy Prime — always last chip */}
              <button
                id="deploy-prime-btn"
                className={styles.deployChip}
                onClick={() => setShowDeploy(true)}
              >
                <span className={styles.deployChipIcon}>+</span>
                <span className={styles.chipName}>Deploy Prime</span>
              </button>
            </div>

            {/* ---- SVG Connection Layer ---- */}
            <svg className={styles.connectionLayer} aria-hidden="true">
              <defs>
                <linearGradient id="lineGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="rgba(31,154,155,0.35)" />
                  <stop offset="100%" stopColor="rgba(31,154,155,0.08)" />
                </linearGradient>
              </defs>
              {lines.map((line) => {
                const pathD = `M ${line.x1} ${line.y1} Q ${(line.x1 + line.x2) / 2} ${line.y1 + 30} ${line.x2} ${line.y2}`;
                return (
                  <g key={line.id}>
                    <path d={pathD} stroke="url(#lineGrad)" strokeWidth="1.5" fill="none" opacity="0.7" />
                    <circle r="2.5" className={styles.pulseDot}>
                      <animateMotion dur={`${2 + Math.random() * 1.5}s`} repeatCount="indefinite" path={pathD} />
                    </circle>
                    <circle r="1.5" className={styles.pulseDot} opacity="0.4">
                      <animateMotion dur={`${2.5 + Math.random() * 1.5}s`} repeatCount="indefinite" path={pathD} begin={`${1 + Math.random()}s`} />
                    </circle>
                  </g>
                );
              })}
            </svg>

            {/* ---- Agent Grid ---- */}
            {selectedPrime && (
              <div className={styles.agentGrid} id="agent-grid">
                {activeFleet.map((agent, i) => {
                  const dp = getDeployProgress(agent.deploySteps);
                  const isDeploying = agent.status === "deploying" && dp;
                  const isChatTarget = chatTarget?.type === "agent" && chatTarget?.agentName === agent.name;

                  return (
                    <div
                      key={agent.name}
                      ref={(el) => {
                        if (el) agentCardRefs.current.set(agent.name, el);
                        else agentCardRefs.current.delete(agent.name);
                      }}
                      className={`${styles.agentCard} ${agent.status === "online" ? styles.agentCardOnline : ""} ${isChatTarget ? styles.agentCardActive : ""}`}
                      style={{ animationDelay: `${i * 80}ms` }}
                      id={`agent-card-${agent.name}`}
                      onClick={() => selectAgentChat(agent)}
                    >
                      <div className={styles.agentHeader}>
                        <div className={styles.agentAvatar}>
                          {agent.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className={styles.agentName}>{agent.name}</div>
                          <div className={styles.agentMeta}>
                            <span className={styles.specialtyBadge}>{agent.specialty}</span>
                            <span className={`${styles.statusDot} ${statusClass(agent.status)}`} />
                            <span>{agent.status}</span>
                          </div>
                        </div>
                      </div>

                      {/* Deploy progress */}
                      {isDeploying && dp && (
                        <div className={styles.deploySection}>
                          <div className={styles.deployBar}>
                            <div
                              className={`${styles.deployBarFill} ${dp.failed > 0 ? styles.deployBarFailed : ""}`}
                              style={{ width: `${dp.progress}%` }}
                            />
                          </div>
                          <div className={styles.deployInfo}>
                            <span className={styles.deployPct}>{dp.progress}%</span>
                            <span className={styles.deployStep}>
                              {dp.activeStep
                                ? `⏳ ${dp.activeStep.label}`
                                : dp.lastDoneStep
                                ? `✅ ${dp.lastDoneStep.label}`
                                : `${dp.done}/${dp.total}`}
                            </span>
                          </div>
                        </div>
                      )}


                    </div>
                  );
                })}

                {/* +Hire card — always last in the grid */}
                <div
                  className={styles.hireCard}
                  onClick={openHireModal}
                  id="hire-agent-btn"
                >
                  <span className={styles.hireCardIcon}>+</span>
                  <span className={styles.hireCardText}>Hire</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- Floating Chat Panel ---- */}
      {chatTarget && (
        <div
          className={styles.chatOverlay}
          style={{ width: chatWidth }}
          id="chat-overlay"
        >
          {/* Resize handle (left edge) */}
          <div
            className={styles.chatResizeHandle}
            onMouseDown={handleResizeDown}
          />
          {/* Close button */}
          <button
            className={styles.chatCloseBtn}
            onClick={() => setChatTarget(null)}
            aria-label="Close chat"
            id="chat-close-btn"
          >
            ✕
          </button>
          <ChatPanel
            key={`${chatTarget.primeId}-${chatTarget.agentName || "prime"}`}
            primeId={chatTarget.primeId}
            agentName={chatTarget.type === "agent" ? chatTarget.agentName : undefined}
            entityName={chatTarget.entityName}
            entityStatus={chatTarget.entityStatus}
            specialty={chatTarget.specialty}
          />
        </div>
      )}

      {/* ---- Deploy Modal ---- */}
      {showDeploy && (
        <div className={styles.modalOverlay} onClick={() => setShowDeploy(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>Deploy New Prime</div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="deploy-prime-name">Instance Name</label>
              <input
                id="deploy-prime-name"
                className="input"
                placeholder="e.g. charlie"
                autoFocus
                value={newPrimeName}
                onChange={(e) => setNewPrimeName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleDeploy(); }}
              />
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="deploy-prime-zone">Zone</label>
              <select
                id="deploy-prime-zone"
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
            <div className={styles.modalActions}>
              <button className="btn btn-ghost" onClick={() => setShowDeploy(false)}>Cancel</button>
              <button
                id="deploy-prime-submit"
                className="btn btn-primary"
                onClick={handleDeploy}
                disabled={!newPrimeName.trim() || deploying}
              >
                {deploying ? "Deploying…" : "Deploy"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Hire Agent Modal ---- */}
      {showHire && (
        <div className={styles.modalOverlay} onClick={() => setShowHire(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>Hire New Agent</div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="hire-agent-type">Specialty</label>
              {agentTypes.length === 0 ? (
                <div className={styles.modalHint}>Loading specialties…</div>
              ) : (
                <select
                  id="hire-agent-type"
                  className="input"
                  value={hireType}
                  onChange={(e) => setHireType(e.target.value)}
                >
                  {agentTypes.map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              )}
              {hireType && agentTypes.length > 0 && (
                <div className={styles.modalHint}>
                  {agentTypes.find((t) => t.id === hireType)?.specialty}
                </div>
              )}
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="hire-agent-name">Agent Name</label>
              <input
                id="hire-agent-name"
                className="input"
                placeholder="e.g. alice"
                autoFocus
                value={hireName}
                maxLength={15}
                onChange={(e) => {
                  const v = e.target.value.toLowerCase().replace(/[^a-z]/g, '');
                  setHireName(v.slice(0, 15));
                }}
                onKeyDown={(e) => { if (e.key === "Enter") handleHire(); }}
              />
              <div className={styles.modalHint}>
                Lowercase letters only, max 15 characters
              </div>
            </div>
            {generatedEmail && (
              <div className={styles.modalField}>
                <label className={styles.modalLabel}>Workspace Email</label>
                <div
                  style={{
                    padding: '8px 12px',
                    background: 'rgba(32,40,51,0.5)',
                    borderRadius: 8,
                    fontSize: 13,
                    color: '#AEB8C4',
                    fontFamily: 'monospace',
                    letterSpacing: '0.02em',
                  }}
                >
                  {generatedEmail}
                </div>
              </div>
            )}
            <div className={styles.modalActions}>
              <button className="btn btn-ghost" onClick={() => setShowHire(false)}>Cancel</button>
              <button
                id="hire-agent-submit"
                className="btn btn-primary"
                onClick={handleHire}
                disabled={!hireName.trim() || !hireType || !generatedEmail || hiring}
              >
                {hiring ? "Hiring…" : "Hire"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <DialogProvider>
      <HomeInner />
    </DialogProvider>
  );
}
