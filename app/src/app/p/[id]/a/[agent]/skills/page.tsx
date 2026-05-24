"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { useDialog } from "@/components/DialogProvider";
import type { AgentDetail } from "@/lib/types";

interface SkillKit {
  id: string;
  name: string;
  description: string;
  type: "base" | "role" | "job";
  tools: number;
}

const KIT_ICONS: Record<string, string> = {
  base: "📦",
  "role-fleet": "🤝",
  "role-prime": "👑",
  "job-devops": "🔧",
  "job-engineer": "💻",
  "job-pm": "📊",
  "job-qa": "🧪",
  "job-security": "🔐",
  "job-finance": "💰",
  "job-assistant": "🤖",
  "job-data": "📈",
};

/* Map agent specialty to job kit id */
function specialtyToJobKit(specialty: string | undefined): string {
  if (!specialty) return "";
  const map: Record<string, string> = {
    devops: "job-devops",
    engineer: "job-engineer",
    pm: "job-pm",
    qa: "job-qa",
    security: "job-security",
    finance: "job-finance",
    assistant: "job-assistant",
    data: "job-data",
  };
  return map[specialty] || `job-${specialty}`;
}

export default function AgentSkills() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const dialog = useDialog();
  const [allKits, setAllKits] = useState<SkillKit[]>([]);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [expandedKit, setExpandedKit] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const [kitsRes, detailRes] = await Promise.all([
      api<{ kits: SkillKit[] }>("/api/skills"),
      api<AgentDetail>(`/api/primes/${id}/fleet/${agent}/logs`),
    ]);
    if (kitsRes?.kits) setAllKits(kitsRes.kits);
    if (detailRes) setDetail(detailRes);
    setLoading(false);
  }, [id, agent]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /* Determine which kits are installed for this agent */
  const installedKitIds = new Set<string>();
  installedKitIds.add("base"); // always installed
  installedKitIds.add("role-fleet"); // fleet agents always have fleet overlay
  const jobKit = specialtyToJobKit(detail?.specialty);
  if (jobKit) installedKitIds.add(jobKit);

  const installedKits = allKits.filter((k) => installedKitIds.has(k.id));
  const availableKits = allKits.filter((k) => !installedKitIds.has(k.id));

  /* Upgrade CoreKit */
  const handleUpgrade = async () => {
    setUpgrading(true);
    const res = await api<{ id: string }>(`/api/primes/${id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fleet_upgrade", args: { name: agent, ref: "main" } }),
    });
    if (res?.id) {
      dialog.trackCommand(id, res.id, `Upgrade ${agent}`);
    } else {
      dialog.toast({ message: "Failed to start upgrade.", variant: "error" });
    }
    setUpgrading(false);
  };

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.container}>
          <div className={styles.loadingState}>Loading skill kits…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell} id="agent-skills">
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>🔧 Skills — {agent}</h1>
            <p className={styles.subtitle}>
              {detail?.specialty || "fleet"} agent · {installedKits.length} kits installed · {installedKits.reduce((sum, k) => sum + k.tools, 0)} tools
            </p>
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

        {/* ---- Installed Kits ---- */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Installed Kits
            <span className={styles.sectionBadge}>{installedKits.length}</span>
          </h2>
          <div className={styles.kitList} id="agent-skills-installed">
            {installedKits.map((kit) => {
              const isExpanded = expandedKit === kit.id;
              return (
                <button
                  key={kit.id}
                  className={`${styles.kitCard} ${isExpanded ? styles.kitCardExpanded : ""}`}
                  onClick={() => setExpandedKit(isExpanded ? null : kit.id)}
                  id={`skill-${kit.id}`}
                >
                  <div className={styles.kitHeader}>
                    <span className={styles.kitIcon}>{KIT_ICONS[kit.id] || "📦"}</span>
                    <div className={styles.kitInfo}>
                      <span className={styles.kitName}>{kit.name}</span>
                      <span className={styles.kitType}>
                        {kit.type === "base" ? "Foundation" : kit.type === "role" ? "Role Layer" : "Specialty"}
                      </span>
                    </div>
                    <span className={styles.kitToolCount}>{kit.tools} tools</span>
                    <span className={`${styles.kitChevron} ${isExpanded ? styles.kitChevronOpen : ""}`}>▸</span>
                  </div>
                  {isExpanded && (
                    <div className={styles.kitDetail}>
                      <p className={styles.kitDesc}>{kit.description}</p>
                      <div className={styles.kitMeta}>
                        <span className={styles.kitMetaItem}>📦 ID: <code>{kit.id}</code></span>
                        <span className={styles.kitMetaItem}>🔧 {kit.tools} scripts/tools</span>
                        <span className={`${styles.kitMetaItem} ${styles.kitInstalled}`}>✓ Installed</span>
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* ---- Available Kits ---- */}
        {availableKits.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Available Kits
              <span className={styles.sectionBadge}>{availableKits.length}</span>
            </h2>
            <div className={styles.kitList} id="agent-skills-available">
              {availableKits.map((kit) => {
                const isExpanded = expandedKit === kit.id;
                return (
                  <button
                    key={kit.id}
                    className={`${styles.kitCard} ${styles.kitCardAvailable} ${isExpanded ? styles.kitCardExpanded : ""}`}
                    onClick={() => setExpandedKit(isExpanded ? null : kit.id)}
                    id={`skill-avail-${kit.id}`}
                  >
                    <div className={styles.kitHeader}>
                      <span className={styles.kitIcon} style={{ opacity: 0.5 }}>{KIT_ICONS[kit.id] || "📦"}</span>
                      <div className={styles.kitInfo}>
                        <span className={styles.kitName}>{kit.name}</span>
                        <span className={styles.kitType}>
                          {kit.type === "base" ? "Foundation" : kit.type === "role" ? "Role Layer" : "Specialty"}
                        </span>
                      </div>
                      <span className={styles.kitToolCount} style={{ opacity: 0.5 }}>{kit.tools} tools</span>
                      <span className={`${styles.kitChevron} ${isExpanded ? styles.kitChevronOpen : ""}`}>▸</span>
                    </div>
                    {isExpanded && (
                      <div className={styles.kitDetail}>
                        <p className={styles.kitDesc}>{kit.description}</p>
                        <div className={styles.kitMeta}>
                          <span className={styles.kitMetaItem}>📦 ID: <code>{kit.id}</code></span>
                          <span className={styles.kitMetaItem}>🔧 {kit.tools} scripts/tools</span>
                          <span className={styles.kitNotInstalled}>Not installed — change specialty to use</span>
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <div className={styles.note} id="agent-skills-note">
          <span className={styles.noteIcon}>ℹ️</span>
          <span>
            Kits are assigned automatically based on role and specialty.
            Upgrade CoreKit to pull the latest tools from the repo.
          </span>
        </div>
      </div>
    </div>
  );
}
