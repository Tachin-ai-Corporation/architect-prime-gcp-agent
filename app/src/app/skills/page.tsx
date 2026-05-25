"use client";

import { Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import { useDialog } from "@/components/DialogProvider";

/* ---- Types ---- */
interface Tool {
  name: string;
  category: string;
  description: string;
  sizeBytes: number;
}

interface SkillPack {
  name: string;
  description: string;
  files: number;
}

interface SkillsResult {
  tools: Tool[];
  skillPacks: SkillPack[];
  binDir: string;
  skillsDir: string;
}

/* ---- Constants ---- */

const CATEGORY_LABELS: Record<string, { label: string; icon: string; order: number }> = {
  ears: { label: "Ears", icon: "👂", order: 1 },
  mouth: { label: "Mouth", icon: "🗣️", order: 2 },
  brain: { label: "Brain", icon: "🧠", order: 3 },
  cortex: { label: "Cortex", icon: "🔮", order: 4 },
  motor: { label: "Motor", icon: "⚡", order: 5 },
  memory: { label: "Memory", icon: "💾", order: 6 },
  config: { label: "Config", icon: "⚙️", order: 7 },
  custom: { label: "Custom", icon: "🧩", order: 8 },
};

export default function SkillsPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <SkillsPage />
    </Suspense>
  );
}

function SkillsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { primes, sidebarFleet } = usePrime();
  const dialog = useDialog();

  /* ---- URL params ---- */
  const paramPrime = searchParams.get("prime");
  const paramAgent = searchParams.get("agent");

  const selectedPrimeId = paramPrime && primes.find((p) => p.id === paramPrime)
    ? paramPrime
    : primes[0]?.id || null;

  const fleet = selectedPrimeId ? sidebarFleet[selectedPrimeId] || [] : [];

  /* ---- Agent selection: "prime" means the prime itself, otherwise a fleet agent name ---- */
  const [localAgent, setLocalAgent] = useState<string | null>(paramAgent || null);

  useEffect(() => {
    if (paramAgent) setLocalAgent(paramAgent);
  }, [paramAgent]);

  const selectedAgent = localAgent;
  const isPrimeSelected = selectedAgent === "prime";

  /* ---- Prime dropdown ---- */
  const [primeDropdownOpen, setPrimeDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setPrimeDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ---- Update URL params ---- */
  const updateParams = useCallback(
    (prime: string | null, agent: string | null) => {
      const params = new URLSearchParams();
      if (prime) params.set("prime", prime);
      if (agent) params.set("agent", agent);
      const qs = params.toString();
      router.replace(`/skills${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router]
  );

  /* ---- Agent skills state ---- */
  const [skills, setSkills] = useState<SkillsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradingFleet, setUpgradingFleet] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Fetch skills via Firestore introspect bus ---- */
  const fetchSkills = useCallback(async () => {
    if (!selectedPrimeId || !selectedAgent) return;

    setLoading(true);
    setError(null);
    setSkills(null);

    // For Prime, the VM hostname is "prime-{id}" (e.g. prime-chucknorris).
    // The introspect daemon uses hostname().replace(/^fleet-/, '') which does NOT strip "prime-",
    // so it polls at primes/{id}/fleet/prime-{id}/introspect.
    const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;

    // 1. Submit query
    const submitRes = await api<{ queryId: string; status: string }>(
      `/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/introspect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "skills" }),
      }
    );

    if (!submitRes?.queryId) {
      setError("Failed to submit introspection query. Is the agent online?");
      setLoading(false);
      return;
    }

    // 2. Poll for result
    const queryId = submitRes.queryId;
    let attempts = 0;
    const maxAttempts = 20; // ~20s max wait

    const poll = async () => {
      attempts++;
      const result = await api<{
        queryId: string;
        type: string;
        status: string;
        result: SkillsResult | null;
        error: string | null;
      }>(`/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/introspect?queryId=${queryId}`);

      if (result?.status === "complete" && result.result) {
        setSkills(result.result);
        setLoading(false);
        return;
      }

      if (result?.status === "error") {
        setError(result.error || "Introspection query failed");
        setLoading(false);
        return;
      }

      if (attempts >= maxAttempts) {
        setError("Timed out waiting for agent response. The introspect daemon may not be running yet — try upgrading CoreKit.");
        setLoading(false);
        return;
      }

      // Continue polling
      pollRef.current = setTimeout(poll, 1000);
    };

    // Start polling after 1s delay
    pollRef.current = setTimeout(poll, 1000);
  }, [selectedPrimeId, selectedAgent, isPrimeSelected]);

  /* ---- Fetch when agent changes ---- */
  useEffect(() => {
    if (selectedAgent) {
      fetchSkills();
    } else {
      setSkills(null);
      setError(null);
      setLoading(false);
    }
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [fetchSkills, selectedAgent]);

  /* ---- Upgrade CoreKit (works for both Prime and fleet) ---- */
  const handleUpgrade = async () => {
    if (!selectedPrimeId || !selectedAgent) return;
    setUpgrading(true);

    if (isPrimeSelected) {
      // Prime upgrade: queue upgrade_corekit command
      const res = await api<{ id: string }>(`/api/primes/${selectedPrimeId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "upgrade_corekit", args: { ref: "main" } }),
      });
      if (res?.id) {
        dialog.trackCommand(selectedPrimeId, res.id, `Upgrade ${selectedPrimeId} CoreKit`);
      } else {
        dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
      }
    } else {
      // Fleet upgrade: queue fleet_upgrade command
      const res = await api<{ id: string }>(`/api/primes/${selectedPrimeId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fleet_upgrade", args: { name: selectedAgent, ref: "main" } }),
      });
      if (res?.id) {
        dialog.trackCommand(selectedPrimeId, res.id, `Upgrade ${selectedAgent}`);
      } else {
        dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
      }
    }
    setUpgrading(false);
  };

  /* ---- Upgrade ALL fleet agents ---- */
  const handleUpgradeFleet = async () => {
    if (!selectedPrimeId) return;
    const activeAgents = fleet.filter((a) => a.status !== "removed");
    if (activeAgents.length === 0) {
      dialog.toast({ message: "No active fleet agents to upgrade.", variant: "error" });
      return;
    }

    const ok = await dialog.confirm({
      title: `Upgrade all ${activeAgents.length} fleet agents?`,
      message:
        `This will upgrade CoreKit on: ${activeAgents.map((a) => a.name).join(", ")}.\n\nEach agent will restart briefly during the upgrade.`,
      confirmText: "Upgrade All",
    });
    if (!ok) return;

    setUpgradingFleet(true);
    let successCount = 0;
    for (const agent of activeAgents) {
      const res = await api<{ id: string }>(`/api/primes/${selectedPrimeId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fleet_upgrade", args: { name: agent.name, ref: "main" } }),
      });
      if (res?.id) {
        dialog.trackCommand(selectedPrimeId, res.id, `Upgrade ${agent.name}`);
        successCount++;
      }
    }
    if (successCount === activeAgents.length) {
      dialog.toast({ message: `Upgrading ${successCount} fleet agents…`, variant: "success", duration: 4000 });
    } else {
      dialog.toast({ message: `Started ${successCount}/${activeAgents.length} upgrades.`, variant: "error" });
    }
    setUpgradingFleet(false);
  };

  /* ---- Group tools by category ---- */
  const groupedTools = skills?.tools
    ? Object.entries(
        skills.tools.reduce<Record<string, Tool[]>>((acc, tool) => {
          const cat = tool.category || "tool";
          if (!acc[cat]) acc[cat] = [];
          acc[cat].push(tool);
          return acc;
        }, {})
      ).sort(([a], [b]) => {
        const oa = CATEGORY_LABELS[a]?.order ?? 99;
        const ob = CATEGORY_LABELS[b]?.order ?? 99;
        return oa - ob;
      })
    : [];

  /* ---- Agent strip info (Prime + fleet) ---- */
  const agentInfo = useMemo(() => {
    const agents: { name: string; online: boolean; status: string; isPrime: boolean }[] = [];

    // Prime first
    const prime = primes.find((p) => p.id === selectedPrimeId);
    if (prime) {
      agents.push({
        name: "prime",
        online: prime.status === "online",
        status: prime.status,
        isPrime: true,
      });
    }

    // Fleet agents
    fleet
      .filter((a) => a.status !== "removed")
      .forEach((agent) => {
        agents.push({
          name: agent.name,
          online: agent.status === "online",
          status: agent.status,
          isPrime: false,
        });
      });

    return agents;
  }, [fleet, primes, selectedPrimeId]);

  /* ---- Handlers ---- */
  const handleSelectAgent = useCallback(
    (name: string) => {
      const next = localAgent === name ? null : name;
      setLocalAgent(next);
      setExpandedCategory(null);
      updateParams(selectedPrimeId, next);
    },
    [localAgent, selectedPrimeId, updateParams]
  );

  const handleSwitchPrime = useCallback(
    (primeId: string) => {
      setPrimeDropdownOpen(false);
      setLocalAgent(null);
      setSkills(null);
      setError(null);
      setExpandedCategory(null);
      updateParams(primeId, null);
    },
    [updateParams]
  );

  const prime = primes.find((p) => p.id === selectedPrimeId);
  const displayLabel = isPrimeSelected
    ? `${prime?.name || selectedPrimeId} (Prime)`
    : selectedAgent || null;

  return (
    <div className={styles.shell} id="skills-page">
      {/* ---- Page Header ---- */}
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>🔧 Skills</h1>

        {/* Prime selector */}
        {primes.length > 0 && (
          <div className={styles.primeSelector} ref={dropdownRef}>
            <button
              className={styles.primeSelectorBtn}
              onClick={() => setPrimeDropdownOpen((v) => !v)}
            >
              {prime?.name || selectedPrimeId || "Select Prime"}
              <span
                className={`${styles.primeSelectorChev} ${primeDropdownOpen ? styles.primeSelectorChevOpen : ""}`}
              >
                ▾
              </span>
            </button>
            {primeDropdownOpen && (
              <div className={styles.primeSelectorDropdown}>
                {primes.map((p) => (
                  <button
                    key={p.id}
                    className={`${styles.primeSelectorItem} ${p.id === selectedPrimeId ? styles.primeSelectorItemActive : ""}`}
                    onClick={() => handleSwitchPrime(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.pgSub}>
        {displayLabel
          ? `Showing skills for ${displayLabel}`
          : "Select Prime or a fleet agent to view their skills"}
      </div>

      {/* ---- Agent Strip (Prime + Fleet) ---- */}
      {agentInfo.length > 0 && (
        <div className={styles.agents}>
          {agentInfo.map((agent) => (
            <button
              key={agent.name}
              className={`${styles.ag} ${selectedAgent === agent.name ? styles.agSel : ""} ${agent.isPrime ? styles.agPrime : ""}`}
              onClick={() => handleSelectAgent(agent.name)}
            >
              <span
                className={`${styles.agDot} ${agent.online ? styles.agDotOn : styles.agDotIdle}`}
              />
              <div className={styles.agInfo}>
                <span className={styles.agName}>
                  {agent.isPrime ? (prime?.name || "Prime") : agent.name}
                </span>
                <span className={styles.agIdle}>
                  {agent.isPrime ? "prime" : agent.status}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className={styles.container}>
        {/* ======== NO SELECTION: prompt ======== */}
        {!selectedAgent && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>🔧</div>
            <div className={styles.emptyTitle}>Select an agent above</div>
            <div className={styles.emptySub}>
              Choose <strong>Prime</strong> or a fleet agent to view installed tools, skill packs, and upgrade CoreKit
            </div>
          </div>
        )}

        {/* ======== AGENT SELECTED: Skills view ======== */}
        {selectedAgent && (
          <>
            <header className={styles.header}>
              <div>
                <h2 className={styles.title}>
                  Skills — {displayLabel}
                </h2>
                {skills && (
                  <p className={styles.subtitle}>
                    {skills.tools.length} tools · {skills.skillPacks.length} skill packs · Live from VM
                  </p>
                )}
                {loading && <p className={styles.subtitle}>Querying agent VM…</p>}
              </div>
              <div className={styles.headerActions}>
                <button
                  className={styles.upgradeBtn}
                  onClick={handleUpgrade}
                  disabled={upgrading}
                  id={isPrimeSelected ? "prime-upgrade-corekit-btn" : "agent-upgrade-corekit-btn"}
                >
                  {upgrading ? "Upgrading…" : "⬆ Upgrade CoreKit"}
                </button>
                {isPrimeSelected && (
                  <button
                    className={styles.upgradeFleetBtn}
                    onClick={handleUpgradeFleet}
                    disabled={upgradingFleet || fleet.filter((a) => a.status !== "removed").length === 0}
                    id="upgrade-fleet-btn"
                  >
                    {upgradingFleet ? "Upgrading…" : `⬆ Upgrade Fleet (${fleet.filter((a) => a.status !== "removed").length})`}
                  </button>
                )}
              </div>
            </header>

            {/* ---- Loading state ---- */}
            {loading && (
              <div className={styles.loadingState}>
                <span className={styles.spinner} />
                <span>Waiting for agent introspection response…</span>
              </div>
            )}

            {/* ---- Error state ---- */}
            {error && (
              <div className={styles.errorState}>
                <span>⚠️ {error}</span>
                <button className={styles.retryBtn} onClick={fetchSkills}>Retry</button>
              </div>
            )}

            {/* ---- Tool Categories ---- */}
            {skills && groupedTools.map(([category, tools]) => {
              const meta = CATEGORY_LABELS[category] || { label: category, icon: "📦", order: 99 };
              const isExpanded = expandedCategory === category;

              return (
                <section key={category} className={styles.categorySection}>
                  <button
                    className={styles.categoryHeader}
                    onClick={() => setExpandedCategory(isExpanded ? null : category)}
                    id={`cat-${category}`}
                  >
                    <span className={styles.categoryIcon}>{meta.icon}</span>
                    <span className={styles.categoryName}>{meta.label}</span>
                    <span className={styles.categoryCount}>{tools.length}</span>
                    <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`}>▸</span>
                  </button>
                  {isExpanded && (
                    <div className={styles.toolList}>
                      {tools.sort((a, b) => a.name.localeCompare(b.name)).map((tool) => (
                        <div key={tool.name} className={styles.toolRow}>
                          <code className={styles.toolName}>{tool.name}</code>
                          <span className={styles.toolDesc}>{tool.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}

            {/* ---- Skill Packs ---- */}
            {skills && skills.skillPacks.length > 0 && (
              <section className={styles.categorySection}>
                <button
                  className={styles.categoryHeader}
                  onClick={() => setExpandedCategory(expandedCategory === "_skills" ? null : "_skills")}
                  id="cat-skillpacks"
                >
                  <span className={styles.categoryIcon}>📚</span>
                  <span className={styles.categoryName}>Skill Packs</span>
                  <span className={styles.categoryCount}>{skills.skillPacks.length}</span>
                  <span className={`${styles.chevron} ${expandedCategory === "_skills" ? styles.chevronOpen : ""}`}>▸</span>
                </button>
                {expandedCategory === "_skills" && (
                  <div className={styles.toolList}>
                    {skills.skillPacks.map((pack) => (
                      <div key={pack.name} className={styles.toolRow}>
                        <code className={styles.toolName}>{pack.name}</code>
                        <span className={styles.toolDesc}>{pack.description || `${pack.files} files`}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {skills && (
              <div className={styles.note} id="agent-skills-note">
                <span className={styles.noteIcon}>ℹ️</span>
                <span>
                  Data read live from the agent VM filesystem.
                  Source: <code>{skills.binDir}</code>
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
