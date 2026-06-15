"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import styles from "./page.module.css";

/* ---- Types ---- */
interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  origin: "core" | "specialty" | "learned";
  category: string;
  agent_part: string | string[];
  scripts?: string[];
  requires?: Record<string, string>;
  when_to_use: string;
}

interface AgentType {
  id: string;
  title: string;
  specialty: string;
  skills: string[];
  glyph?: string;
}

/* ---- Brain function metadata ---- */
const BRAIN_PARTS: Record<string, { label: string; icon: string; desc: string; order: number }> = {
  motor:              { label: "Motor",    icon: "⚡", desc: "Execution — runs tools and scripts",  order: 1 },
  cortex:             { label: "Cortex",   icon: "🧠", desc: "Decision — classifies and dispatches", order: 2 },
  prefrontal:         { label: "Prefrontal", icon: "📋", desc: "Planning — checkpoint decomposition", order: 3 },
  cerebellum:         { label: "Cerebellum", icon: "🔬", desc: "Refinement — output quality checks",  order: 4 },
  "temporal-research":{ label: "Research", icon: "🔍", desc: "Research — web search and retrieval",   order: 5 },
  "temporal-memory":  { label: "Memory",   icon: "💾", desc: "Memory — consolidation and recall",     order: 6 },
};


/* ---- Category badge colors ---- */
const CATEGORY_COLORS: Record<string, string> = {
  workspace: "var(--network-teal)", fleet: "var(--signal-aqua)",
  work: "var(--care-mint)", meta: "var(--text-secondary)",
  search: "#c4a7e7", memory: "#f5a97f",
  security: "#ed8796", introspection: "#7dc4e4",
};

type GroupMode = "brain" | "role";

export default function SkillsLibraryPage() {
  const [catalog, setCatalog] = useState<SkillManifest[]>([]);
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [groupMode, setGroupMode] = useState<GroupMode>("brain");
  const [selectedSkill, setSelectedSkill] = useState<SkillManifest | null>(null);

  /* ---- Fetch catalog ---- */
  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      if (data?.skills) setCatalog(data.skills);
      if (data?.agentTypes) setAgentTypes(data.agentTypes);
    } catch { /* noop */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  /* ---- Filter by search ---- */
  const filteredCatalog = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return catalog;
    return catalog.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.when_to_use?.toLowerCase().includes(q) ||
        (Array.isArray(s.agent_part) ? s.agent_part.join(" ") : s.agent_part).toLowerCase().includes(q)
    );
  }, [catalog, search]);

  /* ---- Build role→skill lookup ---- */
  const skillToRoles = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const at of agentTypes) {
      for (const sid of at.skills) {
        if (!map[sid]) map[sid] = [];
        map[sid].push(at.id);
      }
    }
    return map;
  }, [agentTypes]);

  /* ---- Group by brain function ---- */
  const groupedByPart = useMemo(() => {
    const groups: Record<string, SkillManifest[]> = {};
    for (const skill of filteredCatalog) {
      const parts = Array.isArray(skill.agent_part) ? skill.agent_part : [skill.agent_part || "motor"];
      for (const part of parts) {
        if (!groups[part]) groups[part] = [];
        groups[part].push(skill);
      }
    }
    return Object.entries(groups).sort(([a], [b]) => {
      return (BRAIN_PARTS[a]?.order ?? 99) - (BRAIN_PARTS[b]?.order ?? 99);
    });
  }, [filteredCatalog]);

  /* ---- Group by agent role ---- */
  const groupedByRole = useMemo(() => {
    // Build map: roleId → skills
    const groups: Record<string, SkillManifest[]> = {};
    const skillMap = new Map(filteredCatalog.map((s) => [s.id, s]));

    for (const at of agentTypes) {
      const roleSkills: SkillManifest[] = [];
      for (const sid of at.skills) {
        const skill = skillMap.get(sid);
        if (skill) roleSkills.push(skill);
      }
      if (roleSkills.length > 0) groups[at.id] = roleSkills;
    }

    // "Unassigned" — skills not in any role
    const assignedIds = new Set(agentTypes.flatMap((at) => at.skills));
    const unassigned = filteredCatalog.filter((s) => !assignedIds.has(s.id));
    if (unassigned.length > 0) groups["_unassigned"] = unassigned;

    // Sort: roles alphabetically, unassigned last
    return Object.entries(groups).sort(([a], [b]) => {
      if (a === "_unassigned") return 1;
      if (b === "_unassigned") return -1;
      const at = agentTypes.find((t) => t.id === a);
      const bt = agentTypes.find((t) => t.id === b);
      return (at?.title || a).localeCompare(bt?.title || b);
    });
  }, [filteredCatalog, agentTypes]);

  /* ---- Close popup on escape ---- */
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedSkill(null);
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, []);

  /* ---- Get role info for a skill ---- */
  const getRolesForSkill = (skillId: string): AgentType[] => {
    const roleIds = skillToRoles[skillId] || [];
    return roleIds.map((id) => agentTypes.find((at) => at.id === id)!).filter(Boolean);
  };

  const activeGroups = groupMode === "brain" ? groupedByPart : groupedByRole;

  return (
    <div className={styles.shell} id="skills-library-page">
      {/* ---- Header ---- */}
      <div className={styles.header}>
        <h1 className={styles.title}>📚 Skill Library</h1>
        <p className={styles.subtitle}>
          {catalog.length} skills · {agentTypes.length} agent roles · {Object.keys(BRAIN_PARTS).length} brain functions
        </p>
      </div>

      {/* ---- Controls: search + group toggle ---- */}
      <div className={styles.controls}>
        <div className={styles.searchBar}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search skills…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            id="skills-search"
          />
          {search && (
            <button className={styles.searchClear} onClick={() => setSearch("")}>✕</button>
          )}
        </div>

        <div className={styles.groupToggle} id="group-mode-toggle">
          <button
            className={`${styles.toggleBtn} ${groupMode === "brain" ? styles.toggleActive : ""}`}
            onClick={() => setGroupMode("brain")}
          >
            🧠 Brain Function
          </button>
          <button
            className={`${styles.toggleBtn} ${groupMode === "role" ? styles.toggleActive : ""}`}
            onClick={() => setGroupMode("role")}
          >
            👤 Agent Role
          </button>
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <span className={styles.pulse}>Loading skill catalog…</span>
        </div>
      )}

      {/* ---- Empty search ---- */}
      {!loading && filteredCatalog.length === 0 && search && (
        <div className={styles.emptySearch}>
          No skills matching &ldquo;{search}&rdquo;
        </div>
      )}

      {/* ---- Grouped sections ---- */}
      {!loading && activeGroups.map(([groupKey, skills]) => {
        let icon: string;
        let label: string;
        let desc: string;

        if (groupMode === "brain") {
          const meta = BRAIN_PARTS[groupKey] || { label: groupKey, icon: "📦", desc: "", order: 99 };
          icon = meta.icon;
          label = meta.label;
          desc = meta.desc;
        } else {
          if (groupKey === "_unassigned") {
            icon = "📦";
            label = "Shared / Unassigned";
            desc = "Available to all agent roles";
          } else {
            const at = agentTypes.find((t) => t.id === groupKey);
            icon = at?.glyph || "👤";
            label = at?.title || groupKey;
            desc = at?.specialty || "";
          }
        }

        return (
          <section key={groupKey} className={styles.partSection} id={`group-${groupKey}`}>
            <div className={styles.partHeader}>
              <span className={styles.partIcon}>{icon}</span>
              <div className={styles.partInfo}>
                <span className={styles.partName}>{label}</span>
                <span className={styles.partDesc}>{desc}</span>
              </div>
              <span className={styles.partCount}>{skills.length}</span>
            </div>

            <div className={styles.cardGrid}>
              {skills.map((skill) => (
                <button
                  key={skill.id}
                  className={styles.card}
                  onClick={() => setSelectedSkill(skill)}
                  id={`skill-${skill.id}`}
                >
                  <div className={styles.cardName}>{skill.name}</div>
                  <div className={styles.cardDesc}>{skill.description}</div>
                  <div className={styles.cardBadges}>
                    <span
                      className={styles.badge}
                      style={{ color: CATEGORY_COLORS[skill.category] || "var(--text-tertiary)" }}
                    >
                      {skill.category}
                    </span>
                    {skill.scripts && skill.scripts.length > 0 && (
                      <span className={styles.badgeTools}>
                        {skill.scripts.length} script{skill.scripts.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {/* ---- Skill Detail Popup ---- */}
      {selectedSkill && (
        <div className={styles.overlay} onClick={() => setSelectedSkill(null)}>
          <div className={styles.popup} onClick={(e) => e.stopPropagation()}>
            <button className={styles.popupClose} onClick={() => setSelectedSkill(null)}>✕</button>

            <div className={styles.popupHeader}>
              <h2 className={styles.popupTitle}>{selectedSkill.name}</h2>
              <div className={styles.popupMeta}>
                <span className={styles.popupBadge}>v{selectedSkill.version}</span>
                <span className={styles.popupBadge}>{selectedSkill.origin}</span>
                <span
                  className={styles.popupBadge}
                  style={{ color: CATEGORY_COLORS[selectedSkill.category] || "var(--text-tertiary)" }}
                >
                  {selectedSkill.category}
                </span>
              </div>
            </div>

            <div className={styles.popupBody}>
              <div className={styles.popupSection}>
                <div className={styles.popupLabel}>Description</div>
                <div className={styles.popupText}>{selectedSkill.description}</div>
              </div>

              <div className={styles.popupSection}>
                <div className={styles.popupLabel}>When to Use</div>
                <div className={styles.popupText}>{selectedSkill.when_to_use}</div>
              </div>

              <div className={styles.popupSection}>
                <div className={styles.popupLabel}>Brain Function</div>
                <div className={styles.popupParts}>
                  {(Array.isArray(selectedSkill.agent_part) ? selectedSkill.agent_part : [selectedSkill.agent_part]).map((part) => {
                    const meta = BRAIN_PARTS[part] || { label: part, icon: "📦", desc: "", order: 99 };
                    return (
                      <span key={part} className={styles.popupPartChip}>
                        {meta.icon} {meta.label}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Agent roles this skill is assigned to */}
              {(() => {
                const roles = getRolesForSkill(selectedSkill.id);
                if (roles.length === 0) return null;
                return (
                  <div className={styles.popupSection}>
                    <div className={styles.popupLabel}>Agent Roles</div>
                    <div className={styles.popupParts}>
                      {roles.map((role) => (
                        <span key={role.id} className={styles.popupRoleChip}>
                          {(agentTypes.find(t => t.id === role.id)?.glyph) || "👤"} {role.title}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {selectedSkill.scripts && selectedSkill.scripts.length > 0 && (
                <div className={styles.popupSection}>
                  <div className={styles.popupLabel}>Scripts</div>
                  <div className={styles.popupScripts}>
                    {selectedSkill.scripts.map((s) => (
                      <code key={s} className={styles.popupScript}>{s}</code>
                    ))}
                  </div>
                </div>
              )}

              {selectedSkill.requires && Object.keys(selectedSkill.requires).length > 0 && (
                <div className={styles.popupSection}>
                  <div className={styles.popupLabel}>Dependencies</div>
                  <div className={styles.popupScripts}>
                    {Object.entries(selectedSkill.requires).map(([pkg, ver]) => (
                      <code key={pkg} className={styles.popupScript}>{pkg}: {ver}</code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
