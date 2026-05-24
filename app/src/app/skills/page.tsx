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
const PRIME_TOOLS = [
  { name: "fleet-deploy", desc: "Deploy a new fleet agent VM" },
  { name: "fleet-hire", desc: "Hire agent — create VM, bootstrap OpenClaw" },
  { name: "fleet-fire", desc: "Terminate and remove a fleet agent" },
  { name: "fleet-status", desc: "Check fleet agent health and status" },
  { name: "fleet-upgrade", desc: "Upgrade CoreKit on a fleet agent" },
  { name: "fleet-monitor", desc: "Monitor fleet deployment progress" },
  { name: "command-runner", desc: "Execute queued commands from dashboard" },
  { name: "discover-models", desc: "Scan Vertex AI for available models" },
  { name: "upgrade-corekit", desc: "Self-upgrade CoreKit from main branch" },
  { name: "validate-contracts", desc: "Verify contracts.json compliance" },
  { name: "render-config", desc: "Render config templates with contracts" },
];

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

  /* ---- Agent selection ---- */
  const [localAgent, setLocalAgent] = useState<string | null>(paramAgent || null);

  useEffect(() => {
    if (paramAgent) setLocalAgent(paramAgent);
  }, [paramAgent]);

  const selectedAgent = localAgent;

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

  /* ---- Agent skills state (only when agent selected) ---- */
  const [skills, setSkills] = useState<SkillsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Fetch agent skills via Firestore bus ---- */
  const fetchSkills = useCallback(async () => {
    if (!selectedPrimeId || !selectedAgent) return;

    setLoading(true);
    setError(null);
    setSkills(null);

    // 1. Submit query
    const submitRes = await api<{ queryId: string; status: string }>(
      `/api/primes/${selectedPrimeId}/fleet/${selectedAgent}/introspect`,
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
      }>(`/api/primes/${selectedPrimeId}/fleet/${selectedAgent}/introspect?queryId=${queryId}`);

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
  }, [selectedPrimeId, selectedAgent]);

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

  /* ---- Upgrade CoreKit ---- */
  const handleUpgrade = async () => {
    if (!selectedPrimeId || !selectedAgent) return;
    setUpgrading(true);
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
    setUpgrading(false);
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

  /* ---- Agent strip info ---- */
  const agentInfo = useMemo(() => {
    return fleet
      .filter((a) => a.status !== "removed")
      .map((agent) => ({
        name: agent.name,
        online: agent.status === "online",
        status: agent.status,
      }));
  }, [fleet]);

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
        {selectedAgent
          ? `Showing skills for ${selectedAgent}`
          : "Showing Prime infrastructure tools · Select an agent to view their skills"}
      </div>

      {/* ---- Agent Strip ---- */}
      {agentInfo.length > 0 && (
        <div className={styles.agents}>
          {agentInfo.map((agent) => (
            <button
              key={agent.name}
              className={`${styles.ag} ${selectedAgent === agent.name ? styles.agSel : ""}`}
              onClick={() => handleSelectAgent(agent.name)}
            >
              <span
                className={`${styles.agDot} ${agent.online ? styles.agDotOn : styles.agDotIdle}`}
              />
              <div className={styles.agInfo}>
                <span className={styles.agName}>{agent.name}</span>
                <span className={styles.agIdle}>{agent.status}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className={styles.container}>
        {/* ======== NO AGENT: Prime Skills ======== */}
        {!selectedAgent && (
          <>
            <header className={styles.header}>
              <div>
                <h2 className={styles.title}>Prime Skills</h2>
                <p className={styles.subtitle}>
                  {PRIME_TOOLS.length} tools · Infrastructure only · No workspace skills
                </p>
              </div>
            </header>

            <section className={styles.section}>
              <div className={styles.sectionTitle}>Fleet Management Tools</div>
              <div className={styles.primeToolList}>
                {PRIME_TOOLS.map((tool) => (
                  <div key={tool.name} className={styles.primeToolRow}>
                    <code className={styles.primeToolName}>{tool.name}</code>
                    <span className={styles.primeToolDesc}>{tool.desc}</span>
                  </div>
                ))}
              </div>
            </section>

            <div className={styles.note}>
              <span className={styles.noteIcon}>ℹ️</span>
              <span>
                Prime is infrastructure-only — fleet management, visibility, hire/fire.
                Workspace skills (Drive, Gmail, etc.) are only installed on fleet agents.
              </span>
            </div>
          </>
        )}

        {/* ======== AGENT SELECTED: Agent Skills ======== */}
        {selectedAgent && (
          <>
            <header className={styles.header}>
              <div>
                <h2 className={styles.title}>Skills — {selectedAgent}</h2>
                {skills && (
                  <p className={styles.subtitle}>
                    {skills.tools.length} tools · {skills.skillPacks.length} skill packs · Live from VM
                  </p>
                )}
                {loading && <p className={styles.subtitle}>Querying agent VM…</p>}
              </div>
              <button
                className={styles.upgradeBtn}
                onClick={handleUpgrade}
                disabled={upgrading}
                id="agent-upgrade-corekit-btn"
              >
                {upgrading ? "Upgrading…" : "⬆ Upgrade CoreKit"}
              </button>
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
