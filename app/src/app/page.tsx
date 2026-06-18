"use client";

import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { DialogProvider, useDialog } from "@/components/DialogProvider";
import { ChatPanel } from "@/components/ChatPanel";
import { LoadingScreen, OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { PrimeChip, ChatTarget } from "@/components/primes/PrimeGrid";
import { FleetVisualization, ConnectionLine } from "@/components/fleet/FleetVisualization";
import { HireModal } from "@/components/fleet/HireModal";
import { DeployPrimeModal } from "@/components/primes/DeployPrimeModal";
import { ConfirmDeleteModal } from "@/components/primes/ConfirmDeleteModal";
import { ActionRequiredModal } from "@/components/fleet/ActionRequiredModal";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import type { PrimeInstance, FleetAgent } from "@/lib/types";

function HomeInner() {
  const dialog = useDialog();
  const router = useRouter();
  const { primes, setup, sidebarFleet, loading, refreshPrimes } = usePrime();

  /* ---- State ---- */
  const [selectedPrimeId, setSelectedPrimeId] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null);
  const [chatWidth, setChatWidth] = useState(420);
  const [showHire, setShowHire] = useState(false);
  const [upgradingPrime, setUpgradingPrime] = useState<string | null>(null);
  const [upgradingAgent, setUpgradingAgent] = useState<string | null>(null);
  const [deletingPrime, setDeletingPrime] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    primeId: string; primeName: string; activeFleet: string[]; canDelete: boolean;
  } | null>(null);
  const [actionModal, setActionModal] = useState<{
    primeId: string; agentName: string; action: { title: string; instructions: string[] };
  } | null>(null);
  const [lines, setLines] = useState<ConnectionLine[]>([]);

  /* ---- Refs ---- */
  const isDragging = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const primeChipRef = useRef<HTMLButtonElement>(null);
  const agentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const proximityRaf = useRef<number>(0);

  /* ---- Auto-select first prime ---- */
  useEffect(() => {
    if (primes.length > 0 && !selectedPrimeId) {
      setSelectedPrimeId(primes[0].id);
    }
  }, [primes, selectedPrimeId]);

  /* ---- Compute SVG connection lines ---- */
  const computeLines = useCallback(() => {
    const primeEl = primeChipRef.current;
    if (!primeEl) { setLines([]); return; }

    const rowEl = primeEl.parentElement;
    if (!rowEl) { setLines([]); return; }

    const rowRect = rowEl.getBoundingClientRect();
    const primeRect = primeEl.getBoundingClientRect();
    const x1 = primeRect.left + primeRect.width / 2 - rowRect.left;
    const y1 = primeRect.bottom - rowRect.top;

    const newLines: ConnectionLine[] = [];
    agentCardRefs.current.forEach((el, name) => {
      const agentRect = el.getBoundingClientRect();
      const x2 = agentRect.left + agentRect.width / 2 - rowRect.left;
      const y2 = agentRect.top - rowRect.top;
      newLines.push({ x1, y1, x2, y2, id: name });
    });
    setLines(newLines);
  }, []);

  useLayoutEffect(() => {
    const timer = setTimeout(computeLines, 120);
    return () => clearTimeout(timer);
  }, [computeLines, selectedPrimeId]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => computeLines());
    observer.observe(container);
    return () => observer.disconnect();
  }, [computeLines]);

  /* ---- Proximity glow effect ---- */
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const RADIUS = 220;

    const handleMouse = (e: MouseEvent) => {
      cancelAnimationFrame(proximityRaf.current);
      proximityRaf.current = requestAnimationFrame(() => {
        const mx = e.clientX;
        const my = e.clientY;
        const els = container.querySelectorAll<HTMLElement>('[data-proximity]');
        els.forEach((el) => {
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const dist = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
          const intensity = Math.max(0, 1 - dist / RADIUS);
          const eased = intensity * intensity * intensity;
          el.style.setProperty('--prox', eased.toFixed(3));
        });
      });
    };

    const handleLeave = () => {
      cancelAnimationFrame(proximityRaf.current);
      const els = container.querySelectorAll<HTMLElement>('[data-proximity]');
      els.forEach((el) => el.style.setProperty('--prox', '0'));
    };

    container.addEventListener('mousemove', handleMouse);
    container.addEventListener('mouseleave', handleLeave);
    return () => {
      container.removeEventListener('mousemove', handleMouse);
      container.removeEventListener('mouseleave', handleLeave);
      cancelAnimationFrame(proximityRaf.current);
    };
  }, []);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Select Prime ---- */
  const selectPrime = useCallback((prime: PrimeInstance) => {
    setSelectedPrimeId((prev) => (prev === prime.id ? null : prime.id));
    router.push(`/p/${prime.id}`);
  }, [router]);

  /* ---- Select Agent for chat ---- */
  const selectAgentChat = useCallback((primeId: string, agent: FleetAgent) => {
    setChatTarget({
      type: "agent",
      primeId,
      agentName: agent.name,
      entityName: agent.name,
      entityStatus: agent.status,
      specialty: agent.specialty,
    });
  }, []);

  /* ---- Deploy Prime ---- */
  const handleDeploy = async (name: string, zone: string) => {
    setDeploying(true);

    const result = await api<{ id: string; name: string }>("/api/primes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, zone }),
    });

    if (result) {
      api(`/api/primes/${result.id}/deploy`, { method: "POST" });
      dialog.toast({
        message: `Deploying Prime "${result.name}" in ${zone}…`,
        variant: "success",
        duration: 5000,
      });
      refreshPrimes();
    }

    setShowDeploy(false);
    setDeploying(false);
  };

  /* ---- Upgrade CoreKit (Prime) ---- */
  const handleUpgradePrime = async (primeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setUpgradingPrime(primeId);
    const res = await api<{ id: string }>(`/api/primes/${primeId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "upgrade_corekit", args: { ref: "main" } }),
    });
    if (res?.id) {
      dialog.toast({ message: `Upgrading ${primeId} CoreKit…`, variant: "success" });
    } else {
      dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
    }
    setUpgradingPrime(null);
  };

  /* ---- Upgrade CoreKit (Fleet Agent) ---- */
  const handleUpgradeAgent = async (primeId: string, agentName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setUpgradingAgent(agentName);
    const res = await api<{ id: string }>(`/api/primes/${primeId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fleet_upgrade", args: { name: agentName, ref: "main" } }),
    });
    if (res?.id) {
      dialog.toast({ message: `Upgrading ${agentName}…`, variant: "success" });
    } else {
      dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
    }
    setUpgradingAgent(null);
  };

  /* ---- Delete Prime (with fleet guard) ---- */
  const handleDeletePrime = async (primeId: string, primeName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const fleet = (sidebarFleet[primeId] || []).filter(a => a.status !== "removed");
    const activeFleet = fleet.map(a => a.name);
    setDeleteConfirm({
      primeId,
      primeName,
      activeFleet,
      canDelete: activeFleet.length === 0,
    });
  };

  const confirmDeletePrime = async () => {
    if (!deleteConfirm || !deleteConfirm.canDelete) return;
    setDeletingPrime(deleteConfirm.primeId);
    setDeleteConfirm(null);
    const res = await api<{ success: boolean }>(`/api/primes/${deleteConfirm.primeId}/teardown`, {
      method: "POST",
    });
    if (res?.success) {
      dialog.toast({ message: `Prime "${deleteConfirm.primeName}" is being deleted…`, variant: "success", duration: 5000 });
      if (selectedPrimeId === deleteConfirm.primeId) setSelectedPrimeId(null);
      refreshPrimes();
    } else {
      dialog.toast({ message: "Failed to delete Prime.", variant: "error" });
    }
    setDeletingPrime(null);
  };

  /* ---- Confirm agent setup (clear actionRequired) ---- */
  const handleConfirmSetup = async (primeId: string, agentName: string) => {
    setActionModal(null);
    await api(`/api/primes/${primeId}/fleet/confirm-setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agentName }),
    });
    refreshPrimes();
  };

  /* ---- Loading ---- */
  if (loading) return <LoadingScreen />;

  /* ---- Onboarding (no primes) ---- */
  if (primes.length === 0) {
    return <OnboardingFlow setup={setup} onDeployed={refreshPrimes} />;
  }

  /* ==================================================
     Main Home View — Vertical Prime List
     ================================================== */

  return (
    <div className={styles.homeShell} id="home-page">
      {/* ---- Top Row: title + Deploy Prime ---- */}
      <div className={styles.homeTopRow}>
        <div>
          <div className={styles.homeTopTitle}>Fleet Overview</div>
          <div className={styles.homeTopSub}>{primes.length} prime{primes.length !== 1 ? "s" : ""} · {Object.values(sidebarFleet).flat().filter(a => a.status !== "removed").length} agents</div>
        </div>
        <button
          id="deploy-prime-btn"
          className={styles.deployBtn}
          onClick={() => setShowDeploy(true)}
        >
          <span className={styles.deployBtnIcon}>+</span>
          Deploy Prime
        </button>
      </div>

      {/* ---- Scrollable Prime List ---- */}
      <div className={styles.primeList} ref={listRef}>
        {primes.map((p) => {
          const isSelected = p.id === selectedPrimeId;
          const fleet = (sidebarFleet[p.id] || []).filter((a) => a.status !== "removed");

          return (
            <PrimeChip
              key={p.id}
              ref={primeChipRef}
              prime={p}
              fleet={fleet}
              isSelected={isSelected}
              upgradingPrime={upgradingPrime}
              deletingPrime={deletingPrime}
              onSelect={selectPrime}
              onUpgrade={handleUpgradePrime}
              onDelete={handleDeletePrime}
              onChat={(primeId, name, status) => {
                setChatTarget({ type: "prime", primeId, entityName: name, entityStatus: status });
              }}
            >
              {isSelected && (
                <FleetVisualization
                  primeId={p.id}
                  agents={fleet}
                  lines={lines}
                  chatAgentName={chatTarget?.type === "agent" ? chatTarget.agentName : undefined}
                  upgradingAgent={upgradingAgent}
                  agentCardRefs={agentCardRefs}
                  onSelectAgentChat={selectAgentChat}
                  onUpgradeAgent={handleUpgradeAgent}
                  onHireClick={() => setShowHire(true)}
                  onActionModal={setActionModal}
                />
              )}
            </PrimeChip>
          );
        })}
      </div>

      {/* ---- Floating Chat Panel ---- */}
      {chatTarget && (
        <div className={styles.chatOverlay} style={{ width: chatWidth }} id="chat-overlay">
          <div className={styles.chatResizeHandle} onMouseDown={handleResizeDown} />
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
        <DeployPrimeModal
          onClose={() => setShowDeploy(false)}
          onDeploy={handleDeploy}
          deploying={deploying}
        />
      )}

      {/* ---- Hire Agent Modal ---- */}
      <HireModal
        primeId={selectedPrimeId || ""}
        agentEmailDomain={setup.agentEmailDomain}
        open={showHire}
        onClose={() => setShowHire(false)}
        onHired={refreshPrimes}
      />

      {/* ---- Action Required Modal ---- */}
      {actionModal && (
        <ActionRequiredModal
          agentName={actionModal.agentName}
          action={actionModal.action}
          onClose={() => setActionModal(null)}
          onConfirm={() => handleConfirmSetup(actionModal.primeId, actionModal.agentName)}
        />
      )}

      {/* ---- Delete Prime Confirmation Modal ---- */}
      {deleteConfirm && (
        <ConfirmDeleteModal
          primeName={deleteConfirm.primeName}
          activeFleet={deleteConfirm.activeFleet}
          canDelete={deleteConfirm.canDelete}
          onClose={() => setDeleteConfirm(null)}
          onConfirm={confirmDeletePrime}
        />
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
