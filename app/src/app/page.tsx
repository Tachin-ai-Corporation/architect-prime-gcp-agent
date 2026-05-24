"use client";

import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import styles from "./page.module.css";
import { DialogProvider, useDialog } from "@/components/DialogProvider";
import { DWDGuide } from "@/components/settings/IntegrationTab";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import type { PrimeInstance, SetupState } from "@/lib/types";

/* ---- SVG connection line data ---- */
interface ConnectionLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  id: string;
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

  /* ---- Refs for SVG line computation ---- */
  const containerRef = useRef<HTMLDivElement>(null);
  const primeChipRef = useRef<HTMLButtonElement>(null);
  const agentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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
    // Small delay to let CSS animations settle
    const timer = setTimeout(computeLines, 100);
    return () => clearTimeout(timer);
  }, [computeLines, selectedPrimeId]);

  /* ---- ResizeObserver for dynamic recomputation ---- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      computeLines();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [computeLines]);

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
     Living Agent Graph
     ================================================== */

  /* Prime sub-page quick nav config */
  const primeNavItems = [
    { icon: "💬", label: "Chat", path: "chat" },
    { icon: "📁", label: "Projects", path: "projects" },
    { icon: "🌳", label: "Work", path: "work" },
    { icon: "🧠", label: "Models", path: "models" },
    { icon: "⚙", label: "Settings", path: "settings" },
  ];

  /* Agent sub-page quick nav config */
  const agentNavItems = [
    { icon: "💬", label: "Chat", path: "chat" },
    { icon: "📋", label: "Work", path: "work" },
    { icon: "🧠", label: "Brain", path: "brain" },
    { icon: "🔧", label: "Skills", path: "skills" },
    { icon: "⚙", label: "Settings", path: "settings" },
  ];

  return (
    <div className={styles.homeShell} id="home-page">
      {/* ---- Header ---- */}
      <header className={styles.homeHeader}>
        <Image src="/architect-prime-logo.png" alt="Architect Prime" width={40} height={40} className={styles.homeLogo} />
        <div>
          <h1 className={styles.homeTitle}>Architect Prime</h1>
          <div className={styles.homeSubtitle}>
            {primes.length} instance{primes.length !== 1 ? "s" : ""}
            {versionInfo && ` · ${versionInfo.deployedVersion}`}
          </div>
        </div>
        <button
          id="deploy-prime-btn"
          className={styles.deployBtn}
          onClick={() => setShowDeploy(true)}
        >
          + Deploy Prime
        </button>
      </header>

      {/* ---- Graph Container ---- */}
      <div className={styles.graphContainer} ref={containerRef}>

        {/* ---- Prime Chip Bar ---- */}
        <div className={styles.primeChipBar} id="prime-chip-bar">
          {primes.map((p) => (
            <button
              key={p.id}
              id={`prime-chip-${p.id}`}
              ref={p.id === selectedPrimeId ? primeChipRef : undefined}
              className={`${styles.primeChip} ${p.id === selectedPrimeId ? styles.primeChipSelected : ""}`}
              onClick={() => setSelectedPrimeId(p.id)}
            >
              <span className={`${styles.statusDot} ${statusClass(p.status)}`} />
              <span className={styles.chipName}>{p.name}</span>
              <span className={styles.chipMeta}>
                {p.fleetCount} agent{p.fleetCount !== 1 ? "s" : ""}
              </span>
            </button>
          ))}
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
            const midX = (line.x1 + line.x2) / 2;
            const midY = (line.y1 + line.y2) / 2;
            const pathD = `M ${line.x1} ${line.y1} Q ${midX} ${line.y1 + 30} ${line.x2} ${line.y2}`;
            return (
              <g key={line.id}>
                {/* Connection curve */}
                <path
                  d={pathD}
                  stroke="url(#lineGrad)"
                  strokeWidth="1.5"
                  fill="none"
                  opacity="0.7"
                />
                {/* Traveling pulse dot */}
                <circle r="2.5" className={styles.pulseDot}>
                  <animateMotion
                    dur={`${2 + Math.random() * 1.5}s`}
                    repeatCount="indefinite"
                    path={pathD}
                  />
                </circle>
                {/* Second pulse dot, offset */}
                <circle r="1.5" className={styles.pulseDot} opacity="0.4">
                  <animateMotion
                    dur={`${2.5 + Math.random() * 1.5}s`}
                    repeatCount="indefinite"
                    path={pathD}
                    begin={`${1 + Math.random()}s`}
                  />
                </circle>
              </g>
            );
          })}
        </svg>

        {/* ---- Selected Prime Info + Quick Nav ---- */}
        {selectedPrime && (
          <>
            <div className={styles.primeInfoStrip}>
              <span className={`${styles.statusDot} ${statusClass(selectedPrime.status)}`} />
              <Link href={`/p/${selectedPrimeId}`} className={styles.primeInfoName}>
                {selectedPrime.name}
              </Link>
              <span className={styles.primeInfoStatus}>
                {selectedPrime.status} · {selectedPrime.zone}
              </span>
              <div className={styles.primeQuickNav}>
                {primeNavItems.map((item) => (
                  <Link
                    key={item.path}
                    href={`/p/${selectedPrimeId}/${item.path}`}
                    className={styles.quickNavIcon}
                    data-tooltip={item.label}
                    id={`prime-nav-${item.path}`}
                  >
                    {item.icon}
                  </Link>
                ))}
              </div>
            </div>
            <div className={styles.graphDivider} />
          </>
        )}

        {/* ---- Agent Grid ---- */}
        {selectedPrime && (
          <div className={styles.agentGrid} id="agent-grid">
            {activeFleet.map((agent, i) => (
              <div
                key={agent.name}
                ref={(el) => {
                  if (el) agentCardRefs.current.set(agent.name, el);
                  else agentCardRefs.current.delete(agent.name);
                }}
                className={`${styles.agentCard} ${agent.status === "online" ? styles.agentCardOnline : ""}`}
                style={{ animationDelay: `${i * 80}ms` }}
                id={`agent-card-${agent.name}`}
              >
                <Link href={`/p/${selectedPrimeId}/a/${agent.name}`} className={styles.agentMain}>
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
                </Link>
                <div className={styles.agentIconRow}>
                  {agentNavItems.map((item) => (
                    <Link
                      key={item.path}
                      href={`/p/${selectedPrimeId}/a/${agent.name}/${item.path}`}
                      className={styles.agentIcon}
                      data-tooltip={item.label}
                    >
                      {item.icon}
                    </Link>
                  ))}
                </div>
              </div>
            ))}

            {activeFleet.length === 0 && (
              <div className={styles.emptyFleet}>
                <div className={styles.emptyFleetIcon}>🚀</div>
                <div className={styles.emptyFleetText}>No agents deployed yet</div>
                <Link
                  href={`/p/${selectedPrimeId}/fleet`}
                  className={styles.emptyFleetLink}
                >
                  Hire your first agent →
                </Link>
              </div>
            )}
          </div>
        )}
      </div>

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
