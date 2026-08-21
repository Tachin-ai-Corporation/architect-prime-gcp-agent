"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { DialogProvider, useDialog } from "@/components/DialogProvider";
import { LoadingScreen, OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { PrimeChip } from "@/components/primes/PrimeGrid";
import { FleetVisualization } from "@/components/fleet/FleetVisualization";
import { FleetStudioPanel } from "@/components/fleet/FleetStudioPanel";
import { HireModal } from "@/components/fleet/HireModal";
import { DeployPrimeModal } from "@/components/primes/DeployPrimeModal";
import { ConfirmDeleteModal } from "@/components/primes/ConfirmDeleteModal";
import { ActionRequiredModal } from "@/components/fleet/ActionRequiredModal";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import type { PrimeInstance } from "@/lib/types";

function HomeInner() {
  const dialog = useDialog();
  const router = useRouter();
  const { primes, setup, sidebarFleet, loading, refreshPrimes } = usePrime();

  /* ---- State ---- */
  const [selectedPrimeId, setSelectedPrimeId] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [deploying, setDeploying] = useState(false);
  // Which prime a Hire click was made on. Previously the modal read
  // `selectedPrimeId`, which on this page is whatever the auto-select picked —
  // selecting a card navigates to /p/<id>, so it never reflects a Hire click.
  const [hireTarget, setHireTarget] = useState<string | null>(null);
  const [upgradingPrime, setUpgradingPrime] = useState<string | null>(null);
  const [upgradingAgent, setUpgradingAgent] = useState<string | null>(null);
  const [deletingPrime, setDeletingPrime] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    primeId: string; primeName: string; activeFleet: string[]; canDelete: boolean;
  } | null>(null);
  const [actionModal, setActionModal] = useState<{
    primeId: string; agentName: string; action: { title: string; instructions: string[] };
  } | null>(null);
  /* ---- Refs ---- */
  const listRef = useRef<HTMLDivElement>(null);
  const proximityRaf = useRef<number>(0);

  /* ---- Auto-select first prime ---- */
  //
  // Derived during render rather than written back from an effect. The effect
  // version set state on the render after `primes` arrived, so there was always
  // one frame with nothing selected, and the rule flagged the cascading render
  // it caused. This produces the same selection with no extra render and no
  // state to fall out of sync.
  const effectivePrimeId = selectedPrimeId ?? primes[0]?.id ?? null;

  /* ---- Proximity glow effect ---- */
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    // Respect reduced-motion: the proximity glow is a per-frame mouse tracker.
    if (typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
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

  /* ---- Select Prime ---- */
  const selectPrime = useCallback((prime: PrimeInstance) => {
    setSelectedPrimeId((prev) => (prev === prime.id ? null : prime.id));
    router.push(`/p/${prime.id}`);
  }, [router]);

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
      body: JSON.stringify({
        type: "upgrade_corekit",
        args: {
          ref: "main",
          owner: setup.githubOwner || "",
          repo: setup.githubRepo || ""
        }
      }),
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
      body: JSON.stringify({
        type: "fleet_upgrade",
        args: {
          name: agentName,
          ref: "main",
          owner: setup.githubOwner || "",
          repo: setup.githubRepo || ""
        }
      }),
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
          const isSelected = p.id === effectivePrimeId;
          const fleet = (sidebarFleet[p.id] || []).filter((a) => a.status !== "removed");

          return (
            <PrimeChip
              key={p.id}
              prime={p}
              fleet={fleet}
              isSelected={isSelected}
              upgradingPrime={upgradingPrime}
              deletingPrime={deletingPrime}
              onSelect={selectPrime}
              onUpgrade={handleUpgradePrime}
              onDelete={handleDeletePrime}
              onChat={(primeId) => {
                router.push(`/p/${primeId}#chat`);
              }}
            >
              <FleetVisualization
                primeId={p.id}
                agents={fleet}
                upgradingAgent={upgradingAgent}
                onUpgradeAgent={handleUpgradeAgent}
                onHireClick={() => setHireTarget(p.id)}
                onActionModal={setActionModal}
              />
            </PrimeChip>
          );
        })}

        {/* ---- Fleet observability — absorbed Fleet Studio (what each agent runs + releases/drift) ---- */}
        {effectivePrimeId && (
          <div id="fleet-observability" style={{ marginTop: "var(--space-7)" }}>
            <FleetStudioPanel primeId={effectivePrimeId} />
          </div>
        )}
      </div>

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
        primeId={hireTarget || ""}
        agentEmailDomain={setup.agentEmailDomain}
        open={!!hireTarget}
        onClose={() => setHireTarget(null)}
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
