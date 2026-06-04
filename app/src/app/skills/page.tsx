"use client";

import { Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { useFleetSelection, FleetSelector, FleetEmptyPrompt } from "@/components/FleetSelector";
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

interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  origin: "core" | "specialty" | "learned";
  category: string;
  agent_part: string;
  when_to_use: string;
}

interface SkillInstall {
  id: string;
  installed_at: string;
  installed_by: string;
  origin: string;
  version: string;
  status: string;
}

interface SkillProposal {
  id: string;
  skill_id: string;
  name: string;
  description: string;
  agent_part: string;
  category: string;
  origin: string;
  type: "new" | "improvement";
  status: "proposed" | "approved" | "rejected";
  proposed_by: string;
  proposed_at: string;
  discovery_context: string;
  skill_md: string;
  skill_json: SkillManifest;
  // For improvements
  target_skill_id?: string;
  diff_summary?: string;
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

const PART_ICONS: Record<string, string> = {
  motor: "⚡",
  cerebellum: "🔬",
  "temporal-research": "🔍",
  cortex: "🧠",
  prefrontal: "📋",
};

const PART_LABELS: Record<string, string> = {
  motor: "Motor",
  cerebellum: "Cerebellum",
  "temporal-research": "Research",
  cortex: "Cortex",
  prefrontal: "Prefrontal",
};

const LIBRARY_CATEGORY_LABELS: Record<string, { label: string; icon: string; order: number }> = {
  workspace: { label: "Workspace", icon: "📎", order: 1 },
  fleet: { label: "Fleet", icon: "🚀", order: 2 },
  search: { label: "Search", icon: "🔍", order: 3 },
  memory: { label: "Memory", icon: "💾", order: 4 },
  system: { label: "System", icon: "⚙️", order: 5 },
  other: { label: "Other", icon: "📦", order: 99 },
};

type TabKey = "installed" | "library" | "proposals";

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
  const sel = useFleetSelection();
  const { selectedPrimeId, selectedAgent, isPrimeSelected, fleet, prime, primes } = sel;
  const dialog = useDialog();

  /* ---- Tab state ---- */
  const paramTab = searchParams.get("tab") as TabKey | null;
  const [activeTab, setActiveTab] = useState<TabKey>(paramTab || "installed");

  useEffect(() => {
    if (paramTab) setActiveTab(paramTab);
    else if (selectedAgent) setActiveTab("installed");
  }, [paramTab, selectedAgent]);

  /* ---- Reset tab when agent changes via FleetSelector ---- */
  useEffect(() => {
    if (selectedAgent) {
      setActiveTab("installed");
    }
  }, [selectedAgent]);

  /* ---- Tab URL update (preserves selection params) ---- */
  const handleTabChange = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab);
      const params = new URLSearchParams(searchParams.toString());
      if (tab && tab !== "installed") params.set("tab", tab);
      else params.delete("tab");
      const qs = params.toString();
      router.replace(`/skills${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, searchParams]
  );

  /* ---- VM Introspection (Installed tab) ---- */
  const [skills, setSkills] = useState<SkillsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradingFleet, setUpgradingFleet] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Per-agent custom skills (Firestore) ---- */
  const [customSkills, setCustomSkills] = useState<SkillInstall[]>([]);

  /* ---- Skill catalog (Library tab) ---- */
  const [catalog, setCatalog] = useState<SkillManifest[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");

  /* ---- Proposals (Proposals tab) ---- */
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [previewProposal, setPreviewProposal] = useState<SkillProposal | null>(null);

  /* ---- Library collapsible state ---- */
  const [collapsedLibGroups, setCollapsedLibGroups] = useState<Set<string>>(
    new Set(Object.keys(LIBRARY_CATEGORY_LABELS))
  );

  /* ---- Fetch skills via Firestore introspect bus ---- */
  const fetchSkills = useCallback(async () => {
    if (!selectedPrimeId || !selectedAgent) return;

    setLoading(true);
    setError(null);
    setSkills(null);

    const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;

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

    const queryId = submitRes.queryId;
    let attempts = 0;
    const maxAttempts = 20;

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

      pollRef.current = setTimeout(poll, 1000);
    };

    pollRef.current = setTimeout(poll, 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPrimeId, selectedAgent, isPrimeSelected]);

  /* ---- Fetch per-agent custom skills from Firestore ---- */
  const fetchCustomSkills = useCallback(async () => {
    if (!selectedPrimeId || !selectedAgent) return;
    const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;
    const res = await api<{ skills: SkillInstall[] }>(
      `/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/skills`
    );
    if (res?.skills) setCustomSkills(res.skills);
  }, [selectedPrimeId, selectedAgent, isPrimeSelected]);

  /* ---- Fetch skill catalog ---- */
  const fetchCatalog = useCallback(async () => {
    setCatalogLoading(true);
    const res = await api<{ skills: SkillManifest[] }>("/api/skills");
    if (res?.skills) setCatalog(res.skills);
    setCatalogLoading(false);
  }, []);

  /* ---- Fetch proposals ---- */
  const fetchProposals = useCallback(async () => {
    if (!selectedPrimeId) return;
    setProposalsLoading(true);
    const res = await api<{ proposals: SkillProposal[] }>(
      `/api/primes/${selectedPrimeId}/skill-proposals`
    );
    if (res?.proposals) setProposals(res.proposals);
    setProposalsLoading(false);
  }, [selectedPrimeId]);

  /* ---- Effects ---- */
  // Fetch introspection data when agent is selected (any tab)
  useEffect(() => {
    if (selectedAgent) {
      fetchSkills();
      fetchCustomSkills();
    } else {
      setSkills(null);
      setError(null);
      setLoading(false);
      setCustomSkills([]);
    }
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [fetchSkills, fetchCustomSkills, selectedAgent]);

  useEffect(() => {
    if (activeTab === "library") {
      fetchCatalog();
    }
  }, [activeTab, fetchCatalog]);

  useEffect(() => {
    if (activeTab === "proposals") fetchProposals();
  }, [activeTab, fetchProposals]);

  /* ---- Install / Uninstall handlers ---- */
  const handleInstallSkill = async (skillId: string, origin: string, version: string) => {
    if (!selectedPrimeId || !selectedAgent) return;
    const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;
    await api(`/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId, origin, version }),
    });
    dialog.toast({ message: `Queued ${skillId} for install. Run CoreKit upgrade to apply.`, variant: "success" });
    fetchCustomSkills();
  };

  const handleUninstallSkill = async (skillId: string) => {
    if (!selectedPrimeId || !selectedAgent) return;
    const introspectAgent = isPrimeSelected ? `prime-${selectedPrimeId}` : selectedAgent;
    await api(`/api/primes/${selectedPrimeId}/fleet/${introspectAgent}/skills?skillId=${skillId}`, {
      method: "DELETE",
    });
    dialog.toast({ message: `Removed ${skillId}. Run CoreKit upgrade to apply.`, variant: "success" });
    fetchCustomSkills();
  };

  /* ---- Proposal action handlers ---- */
  const handleProposalAction = async (proposalId: string, action: "approve" | "reject") => {
    if (!selectedPrimeId) return;
    await api(`/api/primes/${selectedPrimeId}/skill-proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId, action }),
    });
    dialog.toast({
      message: action === "approve" ? "Skill approved! Available in Library." : "Proposal rejected.",
      variant: action === "approve" ? "success" : "error",
    });
    fetchProposals();
  };

  /* ---- Upgrade CoreKit ---- */
  const handleUpgrade = async () => {
    if (!selectedPrimeId || !selectedAgent) return;
    setUpgrading(true);

    if (isPrimeSelected) {
      const res = await api<{ id: string }>(`/api/primes/${selectedPrimeId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "upgrade_corekit", args: { ref: "main" } }),
      });
      if (res?.id) {
        dialog.toast({ message: `Upgrading ${selectedPrimeId} CoreKit…`, variant: "success" });
      } else {
        dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
      }
    } else {
      const res = await api<{ id: string }>(`/api/primes/${selectedPrimeId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fleet_upgrade", args: { name: selectedAgent, ref: "main" } }),
      });
      if (res?.id) {
        dialog.toast({ message: `Upgrading ${selectedAgent}…`, variant: "success" });
      } else {
        dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
      }
    }
    setUpgrading(false);
  };

  /* ---- Upgrade ALL fleet agents ---- */
  const handleUpgradeFleet = async () => {
    if (!selectedPrimeId) return;
    const activeAgents = fleet;
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

  /* ---- Library: group by category, filter by search ---- */
  const filteredCatalog = useMemo(() => {
    const q = librarySearch.toLowerCase().trim();
    const filtered = q
      ? catalog.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.agent_part.toLowerCase().includes(q) ||
            s.category.toLowerCase().includes(q)
        )
      : catalog;

    const groups: Record<string, SkillManifest[]> = {};
    for (const s of filtered) {
      const cat = s.category || "other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(s);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      const oa = LIBRARY_CATEGORY_LABELS[a]?.order ?? 99;
      const ob = LIBRARY_CATEGORY_LABELS[b]?.order ?? 99;
      return oa - ob;
    });
  }, [catalog, librarySearch]);

  /* ---- Compute installed skill IDs (VM introspection + Firestore custom) ---- */
  const allInstalledSkillIds = useMemo(() => {
    const ids = new Set(customSkills.map((s) => s.id));
    // Also include skills detected from VM introspection (skill packs)
    if (skills?.skillPacks) {
      for (const pack of skills.skillPacks) {
        ids.add(pack.name);
      }
    }
    return ids;
  }, [customSkills, skills]);

  /* ---- Count skills per brain-agent type from catalog ---- */
  const perAgentPartCounts = useMemo(() => {
    const counts: Record<string, { total: number; installed: number }> = {};
    for (const s of catalog) {
      const part = s.agent_part || "motor";
      if (!counts[part]) counts[part] = { total: 0, installed: 0 };
      counts[part].total++;
      if (allInstalledSkillIds.has(s.id)) counts[part].installed++;
    }
    return counts;
  }, [catalog, allInstalledSkillIds]);



  /* ---- Pending proposals count ---- */
  const pendingCount = proposals.filter((p) => p.status === "proposed").length;

  const displayLabel = isPrimeSelected
    ? `${prime?.name || selectedPrimeId} (Prime)`
    : selectedAgent || null;

  return (
    <div className={styles.shell} id="skills-page">
      {/* ---- Page Header ---- */}
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>🔧 Skills</h1>
      </div>

      {/* ---- Fleet Selector (Prime + Agent chips) ---- */}
      <FleetSelector mode="agent" selection={sel} />

      {/* ---- Empty state when no prime selected ---- */}
      {!selectedPrimeId && (
        <FleetEmptyPrompt
          icon="🔧"
          title="Select a prime above"
          subtitle="Choose a prime and an agent to view their skills"
        />
      )}

      {selectedPrimeId && (
        <>

      {/* ---- Tab Bar ---- */}
      <div className={styles.tabBar} id="skills-tab-bar">
        <button
          className={`${styles.tab} ${activeTab === "installed" ? styles.tabActive : ""}`}
          onClick={() => handleTabChange("installed")}
          disabled={!selectedAgent}
          id="tab-installed"
        >
          Installed
        </button>
        <button
          className={`${styles.tab} ${activeTab === "library" ? styles.tabActive : ""}`}
          onClick={() => handleTabChange("library")}
          id="tab-library"
        >
          Library
        </button>
        <button
          className={`${styles.tab} ${activeTab === "proposals" ? styles.tabActive : ""}`}
          onClick={() => handleTabChange("proposals")}
          id="tab-proposals"
        >
          Proposals
          {pendingCount > 0 && (
            <span className={styles.tabBadge}>{pendingCount}</span>
          )}
        </button>
      </div>

      <div className={styles.container}>
        {/* ======== TAB: INSTALLED ======== */}
        {activeTab === "installed" && (
          <>
            {!selectedAgent && (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>🔧</div>
                <div className={styles.emptyTitle}>Select an agent above</div>
                <div className={styles.emptySub}>
                  Choose <strong>Prime</strong> or a fleet agent to view installed tools, skill packs, and upgrade CoreKit
                </div>
              </div>
            )}

            {selectedAgent && (
              <>
                <header className={styles.header}>
                  <div>
                    <h2 className={styles.title}>
                      Installed — {displayLabel}
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
                        disabled={upgradingFleet || fleet.length === 0}
                        id="upgrade-fleet-btn"
                      >
                        {upgradingFleet ? "Upgrading…" : `⬆ Upgrade Fleet (${fleet.length})`}
                      </button>
                    )}
                  </div>
                </header>

                {/* Loading / Error */}
                {loading && (
                  <div className={styles.loadingState}>
                    <span className={styles.spinner} />
                    <span>Waiting for agent introspection response…</span>
                  </div>
                )}

                {error && (
                  <div className={styles.errorState}>
                    <span>⚠️ {error}</span>
                    <button className={styles.retryBtn} onClick={fetchSkills}>Retry</button>
                  </div>
                )}

                {/* Tool Categories (from VM introspection) */}
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

                {/* Skill Packs */}
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

                {/* Custom skills (from Firestore) */}
                {customSkills.length > 0 && (
                  <section className={styles.categorySection}>
                    <button
                      className={styles.categoryHeader}
                      onClick={() => setExpandedCategory(expandedCategory === "_custom" ? null : "_custom")}
                      id="cat-custom-skills"
                    >
                      <span className={styles.categoryIcon}>🧩</span>
                      <span className={styles.categoryName}>Custom Skills</span>
                      <span className={styles.categoryCount}>{customSkills.length}</span>
                      <span className={`${styles.chevron} ${expandedCategory === "_custom" ? styles.chevronOpen : ""}`}>▸</span>
                    </button>
                    {expandedCategory === "_custom" && (
                      <div className={styles.toolList}>
                        {customSkills.map((sk) => (
                          <div key={sk.id} className={styles.customSkillRow}>
                            <div className={styles.customSkillInfo}>
                              <code className={styles.toolName}>{sk.id}</code>
                              <span className={styles.customSkillMeta}>
                                {sk.origin} · v{sk.version} · {sk.status === "pending_install" ? "⏳ pending upgrade" : "✓ installed"}
                              </span>
                            </div>
                            <button
                              className={styles.uninstallBtn}
                              onClick={() => handleUninstallSkill(sk.id)}
                              title="Remove skill"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}

                {/* Add skill CTA */}
                {skills && (
                  <button
                    className={styles.addSkillBtn}
                    onClick={() => handleTabChange("library")}
                    id="add-skill-btn"
                  >
                    + Add Skill
                  </button>
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
          </>
        )}

        {/* ======== TAB: LIBRARY ======== */}
        {activeTab === "library" && (
          <>
            <header className={styles.header}>
              <div>
                <h2 className={styles.title}>Skill Library</h2>
                <p className={styles.subtitle}>
                  {catalog.length} skills available
                  {selectedAgent && ` · Installing for ${displayLabel}`}
                </p>
              </div>
            </header>

            {/* Search */}
            <div className={styles.librarySearch}>
              <input
                type="text"
                className={styles.searchInput}
                placeholder="Search skills…"
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
                id="library-search"
              />
            </div>

            {catalogLoading && (
              <div className={styles.loadingState}>
                <span className={styles.spinner} />
                <span>Loading skill catalog…</span>
              </div>
            )}

            {/* Brain agent type installed counts */}
            {selectedAgent && Object.keys(perAgentPartCounts).length > 0 && (
              <div className={styles.partCountStrip}>
                {Object.entries(perAgentPartCounts)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([part, counts]) => (
                    <div key={part} className={styles.partCountChip}>
                      <span>{PART_ICONS[part] || "📦"}</span>
                      <span className={styles.partCountLabel}>{PART_LABELS[part] || part}</span>
                      <span className={styles.partCountNum}>
                        {counts.installed}/{counts.total}
                      </span>
                    </div>
                  ))}
              </div>
            )}

            {/* Skills grouped by category (collapsible) */}
            {!catalogLoading && filteredCatalog.map(([cat, catSkills]) => {
              const meta = LIBRARY_CATEGORY_LABELS[cat] || { label: cat, icon: "📦", order: 99 };
              const isCollapsed = collapsedLibGroups.has(cat);
              return (
                <section key={cat} className={styles.libraryGroup}>
                  <button
                    className={styles.libraryGroupHeaderBtn}
                    onClick={() => {
                      setCollapsedLibGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(cat)) next.delete(cat);
                        else next.add(cat);
                        return next;
                      });
                    }}
                  >
                    <span className={styles.categoryIcon}>{meta.icon}</span>
                    <span className={styles.categoryName}>{meta.label}</span>
                    <span className={styles.categoryCount}>{catSkills.length}</span>
                    <span className={`${styles.chevron} ${isCollapsed ? "" : styles.chevronOpen}`}>▸</span>
                  </button>
                  {!isCollapsed && (
                    <div className={styles.libraryCards}>
                      {catSkills.map((skill) => {
                        const isInstalled = allInstalledSkillIds.has(skill.id);
                        return (
                          <div key={skill.id} className={`${styles.skillCard} ${isInstalled ? styles.skillCardInstalled : ""}`} id={`skill-${skill.id}`}>
                            <div className={styles.skillCardTop}>
                              <div className={styles.skillCardName}>{skill.name}</div>
                              <div className={styles.skillCardBadges}>
                                <span className={styles.partBadge} title={`Routes to ${skill.agent_part}`}>
                                  {PART_ICONS[skill.agent_part] || "📦"} {PART_LABELS[skill.agent_part] || skill.agent_part}
                                </span>
                                <span className={`${styles.originBadge} ${styles[`origin_${skill.origin}`] || ""}`}>
                                  {skill.origin}
                                </span>
                              </div>
                            </div>
                            <div className={styles.skillCardDesc}>{skill.description}</div>
                            <div className={styles.skillCardMeta}>
                              v{skill.version}
                            </div>
                            {selectedAgent && (
                              <div className={styles.skillCardActions}>
                                {isInstalled ? (
                                  <span className={styles.installedBadge}>✓ Installed</span>
                                ) : (
                                  <button
                                    className={styles.installBtn}
                                    onClick={() => handleInstallSkill(skill.id, skill.origin, skill.version)}
                                  >
                                    + Install
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}

            {!catalogLoading && catalog.length === 0 && (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>📚</div>
                <div className={styles.emptyTitle}>No skills found</div>
                <div className={styles.emptySub}>The skill catalog is empty or could not be loaded.</div>
              </div>
            )}
          </>
        )}

        {/* ======== TAB: PROPOSALS ======== */}
        {activeTab === "proposals" && (
          <>
            <header className={styles.header}>
              <div>
                <h2 className={styles.title}>Skill Proposals</h2>
                <p className={styles.subtitle}>
                  Skills discovered by Prime from fleet work patterns
                </p>
              </div>
            </header>

            {proposalsLoading && (
              <div className={styles.loadingState}>
                <span className={styles.spinner} />
                <span>Loading proposals…</span>
              </div>
            )}

            {!proposalsLoading && proposals.filter((p) => p.status === "proposed").length === 0 && (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>💡</div>
                <div className={styles.emptyTitle}>No pending proposals</div>
                <div className={styles.emptySub}>
                  Prime will analyze fleet work patterns and propose new skills here.
                  Check back after your agents have completed some missions.
                </div>
              </div>
            )}

            {proposals.filter((p) => p.status === "proposed").map((proposal) => (
              <div
                key={proposal.id}
                className={`${styles.proposalCard} ${proposal.type === "improvement" ? styles.proposalImprovement : styles.proposalNew}`}
                id={`proposal-${proposal.id}`}
              >
                <div className={styles.proposalHeader}>
                  <span className={styles.proposalType}>
                    {proposal.type === "improvement" ? "📈 IMPROVEMENT" : "🆕 NEW SKILL"}
                  </span>
                  <span className={styles.proposalDate}>
                    {new Date(proposal.proposed_at).toLocaleDateString()}
                  </span>
                </div>

                <div className={styles.proposalName}>
                  {proposal.type === "improvement"
                    ? `${proposal.target_skill_id} → v${proposal.skill_json?.version || "?"}`
                    : proposal.name}
                </div>

                <div className={styles.proposalDesc}>{proposal.description}</div>

                {proposal.discovery_context && (
                  <div className={styles.proposalContext}>
                    <span className={styles.proposalContextLabel}>Discovered from:</span>
                    {proposal.discovery_context}
                  </div>
                )}

                <div className={styles.proposalMeta}>
                  {PART_ICONS[proposal.agent_part] || "📦"} {proposal.agent_part} · {proposal.category} · by {proposal.proposed_by}
                </div>

                <div className={styles.proposalActions}>
                  <button
                    className={styles.previewBtn}
                    onClick={() => setPreviewProposal(previewProposal?.id === proposal.id ? null : proposal)}
                  >
                    {previewProposal?.id === proposal.id ? "Hide Preview" : (proposal.type === "improvement" ? "View Diff" : "Preview SKILL.md")}
                  </button>
                  <button
                    className={styles.approveBtn}
                    onClick={() => handleProposalAction(proposal.id, "approve")}
                  >
                    ✓ Approve
                  </button>
                  <button
                    className={styles.rejectBtn}
                    onClick={() => handleProposalAction(proposal.id, "reject")}
                  >
                    ✕ Reject
                  </button>
                </div>

                {previewProposal?.id === proposal.id && proposal.skill_md && (
                  <div className={styles.proposalPreview}>
                    <pre>{proposal.skill_md}</pre>
                  </div>
                )}
              </div>
            ))}

            {/* Show approved/rejected history */}
            {proposals.filter((p) => p.status !== "proposed").length > 0 && (
              <details className={styles.proposalHistory}>
                <summary className={styles.proposalHistorySummary}>
                  Past decisions ({proposals.filter((p) => p.status !== "proposed").length})
                </summary>
                {proposals.filter((p) => p.status !== "proposed").map((p) => (
                  <div key={p.id} className={styles.proposalHistoryItem}>
                    <span className={p.status === "approved" ? styles.statusApproved : styles.statusRejected}>
                      {p.status === "approved" ? "✓" : "✕"}
                    </span>
                    <span>{p.name || p.skill_id}</span>
                    <span className={styles.proposalDate}>
                      {new Date(p.proposed_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </details>
            )}
          </>
        )}
      </div>
      </>
      )}
    </div>
  );
}
