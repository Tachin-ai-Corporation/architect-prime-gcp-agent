"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import styles from "./page.module.css";
import { api } from "@/lib/api";
import { useDialog } from "@/components/DialogProvider";

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

export default function AgentSkills() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const dialog = useDialog();
  const [skills, setSkills] = useState<SkillsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Fetch skills via Firestore bus ---- */
  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);

    // 1. Submit query
    const submitRes = await api<{ queryId: string; status: string }>(
      `/api/primes/${id}/fleet/${agent}/introspect`,
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
      }>(`/api/primes/${id}/fleet/${agent}/introspect?queryId=${queryId}`);

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
  }, [id, agent]);

  useEffect(() => {
    fetchSkills();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [fetchSkills]);

  /* ---- Upgrade CoreKit ---- */
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

  return (
    <div className={styles.shell} id="agent-skills">
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>🔧 Skills — {agent}</h1>
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
      </div>
    </div>
  );
}
