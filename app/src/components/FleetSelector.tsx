"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { usePrime } from "@/contexts/PrimeContext";
import styles from "./FleetSelector.module.css";

/* ================================================================
   useFleetSelection — shared selection state hook
   ================================================================ */

export function useFleetSelection() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { primes, sidebarFleet } = usePrime();

  const paramPrime = searchParams.get("prime");
  const paramAgent = searchParams.get("agent");

  /* No auto-select — selectedPrimeId is null until user clicks a prime chip */
  const selectedPrimeId =
    paramPrime && primes.find((p) => p.id === paramPrime) ? paramPrime : null;

  const fleet = selectedPrimeId
    ? (sidebarFleet[selectedPrimeId] || []).filter((a) => a.status !== "removed")
    : [];

  const prime = primes.find((p) => p.id === selectedPrimeId) || null;

  const [localAgent, setLocalAgent] = useState<string | null>(paramAgent || null);
  useEffect(() => {
    setLocalAgent(paramAgent || null);
  }, [paramAgent]);

  const selectedAgent = localAgent;
  const isPrimeSelected = selectedAgent === "prime";

  /* ---- URL update helper — preserves non-selection params ---- */
  const updateParams = useCallback(
    (primeId: string | null, agent: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (primeId) params.set("prime", primeId);
      else params.delete("prime");
      if (agent) params.set("agent", agent);
      else params.delete("agent");
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const selectPrime = useCallback(
    (primeId: string) => {
      setLocalAgent(null);
      updateParams(primeId, null);
    },
    [updateParams]
  );

  const selectAgent = useCallback(
    (agentName: string) => {
      const next = localAgent === agentName ? null : agentName;
      setLocalAgent(next);
      updateParams(selectedPrimeId, next);
    },
    [localAgent, selectedPrimeId, updateParams]
  );

  return {
    primes,
    fleet,
    prime,
    selectedPrimeId,
    selectedAgent,
    isPrimeSelected,
    selectPrime,
    selectAgent,
    updateParams,
  };
}

/* ================================================================
   FleetSelector — two-tier chip component
   ================================================================ */

interface FleetSelectorProps {
  /** 'prime' = tier-1 only; 'agent' = tier-1 + tier-2 fleet agents */
  mode: "prime" | "agent";
  /** Include "prime" as a selectable agent in tier 2 (for Brain/Skills VM introspection) */
  showPrimeAsAgent?: boolean;
  /** Selection state from useFleetSelection() */
  selection: ReturnType<typeof useFleetSelection>;
  /** Page-specific subfilters rendered below the chips */
  children?: React.ReactNode;
}

export function FleetSelector({
  mode,
  showPrimeAsAgent = false,
  selection,
  children,
}: FleetSelectorProps) {
  const {
    primes,
    fleet,
    prime,
    selectedPrimeId,
    selectedAgent,
    selectPrime,
    selectAgent,
  } = selection;

  /* ---- Build tier-2 agent list ---- */
  const agentInfo = useMemo(() => {
    if (!selectedPrimeId || mode === "prime") return [];
    const agents: {
      name: string;
      status: string;
      isPrime: boolean;
      subtitle: string;
    }[] = [];
    if (showPrimeAsAgent && prime) {
      agents.push({
        name: "prime",
        status: prime.status,
        isPrime: true,
        subtitle: "prime",
      });
    }
    fleet.forEach((agent) => {
      agents.push({
        name: agent.name,
        status: agent.status,
        isPrime: false,
        subtitle: agent.specialty || agent.status,
      });
    });
    return agents;
  }, [selectedPrimeId, mode, showPrimeAsAgent, prime, fleet]);

  return (
    <div className={styles.selectorWrap} id="fleet-selector">
      {/* ---- Tier 1: Prime Chips ---- */}
      <div className={styles.tier}>
        <div className={styles.chipRow}>
          {primes.map((p) => (
            <button
              key={p.id}
              className={`${styles.chip} ${styles.chipPrime} ${
                p.id === selectedPrimeId ? styles.chipSelected : ""
              }`}
              onClick={() => selectPrime(p.id)}
              id={`fleet-sel-prime-${p.id}`}
            >
              <span
                className={`${styles.dot} ${
                  p.status === "online" ? styles.dotOn : styles.dotIdle
                }`}
              />
              <div className={styles.chipInfo}>
                <span className={styles.chipName}>{p.name}</span>
                <span className={styles.chipSub}>prime</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ---- Tier 2: Agent Chips (when prime selected & mode=agent) ---- */}
      {agentInfo.length > 0 && (
        <div className={`${styles.tier} ${styles.tierAgents}`}>
          <div className={styles.chipRow}>
            {agentInfo.map((agent) => (
              <button
                key={agent.name}
                className={`${styles.chip} ${
                  selectedAgent === agent.name ? styles.chipSelected : ""
                } ${agent.isPrime ? styles.chipPrimeAgent : ""}`}
                onClick={() => selectAgent(agent.name)}
                id={`fleet-sel-agent-${agent.name}`}
              >
                <span
                  className={`${styles.dot} ${
                    agent.status === "online" ? styles.dotOn : styles.dotIdle
                  }`}
                />
                <div className={styles.chipInfo}>
                  <span className={styles.chipName}>
                    {agent.isPrime ? prime?.name || "Prime" : agent.name}
                  </span>
                  <span className={styles.chipSub}>{agent.subtitle}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---- Page-specific subfilters ---- */}
      {children}
    </div>
  );
}

/* ---- Empty state prompt (for pages to use when no selection) ---- */
export function FleetEmptyPrompt({
  icon = "◎",
  title = "Select a prime above",
  subtitle = "Choose a prime to view its data",
}: {
  icon?: string;
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className={styles.emptyPrompt}>
      <div className={styles.emptyIcon}>{icon}</div>
      <div className={styles.emptyTitle}>{title}</div>
      <div className={styles.emptySub}>{subtitle}</div>
    </div>
  );
}
