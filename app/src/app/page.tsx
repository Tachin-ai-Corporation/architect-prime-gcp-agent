"use client";

import { useState } from "react";
import Image from "next/image";
import styles from "./page.module.css";
import { DialogProvider, useDialog } from "@/components/DialogProvider";
import { DWDGuide } from "@/components/settings/IntegrationTab";
import { usePrime } from "@/contexts/PrimeContext";
import { NavCard } from "@/components/NavCard";
import { api } from "@/lib/api";
import type { PrimeInstance, SetupState } from "@/lib/types";

function HomeInner() {
  const dialog = useDialog();
  const { primes, setup, loading, versionInfo, refreshPrimes } = usePrime();

  const [showDeploy, setShowDeploy] = useState(false);
  const [newPrimeName, setNewPrimeName] = useState("");
  const [newPrimeZone, setNewPrimeZone] = useState("us-central1-a");
  const [deploying, setDeploying] = useState(false);
  const [copied, setCopied] = useState("");

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
      // Trigger VM provisioning
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
            {/* Step 1: Deploy */}
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

            {/* Step 2: DWD */}
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

            {/* Step 3 */}
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

  /* ---- Home Grid (primes exist) ---- */
  return (
    <div className={styles.homeShell} id="home-page">
      <header className={styles.homeHeader}>
        <Image src="/architect-prime-logo.png" alt="Architect Prime" width={44} height={44} className={styles.homeLogo} />
        <div>
          <h1 className={styles.homeTitle}>Architect Prime</h1>
          <div className={styles.homeSubtitle}>
            {primes.length} instance{primes.length !== 1 ? "s" : ""}
            {versionInfo && ` · ${versionInfo.deployedVersion}`}
          </div>
        </div>
      </header>

      <div className={styles.primeGrid} id="prime-grid">
        {primes.map((p) => (
          <NavCard
            key={p.id}
            id={`prime-card-${p.id}`}
            icon="●"
            title={p.name}
            description={`${p.fleetCount} agent${p.fleetCount !== 1 ? "s" : ""} · ${p.status}`}
            variant="accent"
            href={`/p/${p.id}`}
          />
        ))}

        <NavCard
          id="deploy-prime-card"
          icon="+"
          title="Deploy Prime"
          description="Launch a new Prime instance"
          variant="action"
          onClick={() => setShowDeploy(true)}
        />

        <NavCard
          id="settings-card"
          icon="⚙"
          title="Dashboard Settings"
          description="DWD, integrations, system info"
          variant="default"
          href="/settings"
        />
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
