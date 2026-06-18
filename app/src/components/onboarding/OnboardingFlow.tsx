"use client";

import { useState } from "react";
import Image from "next/image";
import styles from "./OnboardingFlow.module.css";
import { DWDGuide } from "@/components/settings/IntegrationTab";
import { useDialog } from "@/components/DialogProvider";
import { api } from "@/lib/api";
import type { SetupState } from "@/lib/types";

interface OnboardingFlowProps {
  setup: SetupState;
  onDeployed: () => void;
}

export function OnboardingFlow({ setup, onDeployed }: OnboardingFlowProps) {
  const dialog = useDialog();
  const [newPrimeName, setNewPrimeName] = useState("");
  const [newPrimeZone, setNewPrimeZone] = useState("us-central1-a");
  const [deploying, setDeploying] = useState(false);
  const [copied, setCopied] = useState("");

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

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
      onDeployed();
    }

    setDeploying(false);
    setNewPrimeName("");
  };

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

/* ---- Loading Screen ---- */
export function LoadingScreen() {
  return (
    <div className={styles.loading} id="home-loading">
      <div className={styles.loadingCard}>
        <Image src="/architect-prime-logo.png" alt="Architect Prime" width={48} height={48} className={styles.loadingLogo} />
        <div className={styles.loadingText}>Loading<span className={styles.loadingDots} /></div>
      </div>
    </div>
  );
}
