"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { api } from "@/lib/api";

/* ---- Types ---- */
interface SkillKit {
  id: string;
  name: string;
  description: string;
  type: "base" | "role" | "job";
  tools: number;
  icon?: string;
}

type FilterType = "all" | "base" | "role" | "job";

const FILTER_LABELS: { id: FilterType; label: string }[] = [
  { id: "all", label: "All Kits" },
  { id: "base", label: "Base" },
  { id: "role", label: "Roles" },
  { id: "job", label: "Jobs" },
];

const KIT_ICONS: Record<string, string> = {
  base: "🏗️",
  "role-fleet": "🚀",
  "role-prime": "👑",
  "job-devops": "🔧",
  "job-engineer": "💻",
  "job-pm": "📋",
  "job-qa": "🧪",
  "job-security": "🛡️",
  "job-finance": "💰",
  "job-assistant": "🤖",
  "job-data": "📊",
};

export default function SkillsPage() {
  const [kits, setKits] = useState<SkillKit[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");

  useEffect(() => {
    (async () => {
      const data = await api<{ kits: SkillKit[] }>("/api/skills");
      if (data?.kits) setKits(data.kits);
      setLoading(false);
    })();
  }, []);

  const filteredKits = useMemo(() => {
    if (filter === "all") return kits;
    return kits.filter((k) => k.type === filter);
  }, [kits, filter]);

  const getTypeClass = (type: string) => {
    switch (type) {
      case "base":
        return styles.kitTypeBase;
      case "role":
        return styles.kitTypeRole;
      case "job":
        return styles.kitTypeJob;
      default:
        return "";
    }
  };

  return (
    <div className={styles.skillsShell} id="skills-page">
      <div className={styles.skillsContainer}>
        {/* ---- Header ---- */}
        <header className={styles.skillsHeader}>
          <span className={styles.skillsHeaderIcon}>🧰</span>
          <div>
            <h1 className={styles.skillsTitle}>Skill Kits</h1>
            <div className={styles.skillsSubtitle}>
              CoreKit tool registry · {kits.length} kit{kits.length !== 1 ? "s" : ""} available
            </div>
          </div>
          <Link href="/" className={styles.skillsBack} id="skills-back-btn">
            ← Home
          </Link>
        </header>

        {/* ---- Filters ---- */}
        <nav className={styles.typeFilters} id="skills-filters">
          {FILTER_LABELS.map((f) => (
            <button
              key={f.id}
              id={`skills-filter-${f.id}`}
              className={`${styles.typeFilter} ${filter === f.id ? styles.typeFilterActive : ""}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id !== "all" && (
                <span style={{ opacity: 0.6 }}>
                  ({kits.filter((k) => (f.id === "all" ? true : k.type === f.id)).length})
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* ---- Loading ---- */}
        {loading && <div className={styles.skillsLoading}>Loading skill kits…</div>}

        {/* ---- Grid ---- */}
        {!loading && (
          <div className={styles.kitGrid} id="skills-grid">
            {filteredKits.map((kit) => (
              <article key={kit.id} className={styles.kitCard} id={`skill-card-${kit.id}`}>
                <div className={styles.kitCardHeader}>
                  <span className={styles.kitIcon}>{KIT_ICONS[kit.id] || kit.icon || "📦"}</span>
                  <span className={styles.kitBadge}>Available</span>
                </div>
                <div className={styles.kitName}>{kit.name}</div>
                <div className={styles.kitDesc}>{kit.description}</div>
                <div className={styles.kitMeta}>
                  <span className={`${styles.kitType} ${getTypeClass(kit.type)}`}>{kit.type}</span>
                  <span className={styles.kitToolCount}>{kit.tools} scripts</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
