"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./ContractsViewer.module.css";

/* ---- Types ---- */

interface ContractsData {
  vertex?: {
    models?: Record<string, { organ?: string; model?: string; provider?: string }>;
    [key: string]: unknown;
  };
  gateway?: Record<string, unknown>;
  dispatch?: Record<string, unknown>;
  durability?: Record<string, unknown>;
  versioning?: Record<string, unknown>;
  utility?: Record<string, unknown>;
  [section: string]: unknown;
}

/* ---- Component ---- */

interface ContractsViewerProps {
  primeId: string;
}

function renderValue(value: unknown, depth: number = 0): React.ReactNode {
  if (value === null || value === undefined) return <span className={styles.null}>null</span>;
  if (typeof value === "boolean") return <span className={styles.bool}>{value ? "true" : "false"}</span>;
  if (typeof value === "number") return <span className={styles.num}>{value}</span>;
  if (typeof value === "string") return <span className={styles.str}>{value}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={styles.null}>[]</span>;
    return (
      <ul className={styles.list}>
        {value.map((item, i) => (
          <li key={i}>{renderValue(item, depth + 1)}</li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className={styles.null}>{"{}"}</span>;
    return (
      <div className={styles.nested}>
        {entries.map(([k, v]) => (
          <div key={k} className={styles.row}>
            <span className={styles.key}>{k}</span>
            <span className={styles.val}>{renderValue(v, depth + 1)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <span>{String(value)}</span>;
}

const SECTION_LABELS: Record<string, { label: string; icon: string; description: string }> = {
  vertex: { label: "Model Assignments", icon: "🧠", description: "LLM model configuration per cognitive organ" },
  gateway: { label: "Gateway Config", icon: "🌐", description: "Neural gateway ports, timeouts, and routing" },
  dispatch: { label: "Dispatch Config", icon: "⚙️", description: "Brain daemon orchestration parameters" },
  durability: { label: "Durability", icon: "💾", description: "Step ledger, crash recovery, claim management" },
  utility: { label: "Utility", icon: "🔧", description: "Schema enforcement, token limits, misc settings" },
  versioning: { label: "Versioning", icon: "📋", description: "Version format and tagging conventions" },
};

export function ContractsViewer({ primeId }: ContractsViewerProps) {
  const [data, setData] = useState<ContractsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["vertex", "dispatch"]));

  const fetchContracts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/contracts?primeId=${primeId}`);
      if (!res.ok) throw new Error(`Failed to load contracts: ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [primeId]);

  useEffect(() => {
    fetchContracts();
  }, [fetchContracts]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading contracts…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <span>⚠️ {error}</span>
          <button className={styles.retry} onClick={fetchContracts}>Retry</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const sections = Object.keys(data);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>contracts.json</h3>
        <span className={styles.subtitle}>Single source of truth — read-only</span>
      </div>

      {sections.map((section) => {
        const meta = SECTION_LABELS[section] || { label: section, icon: "📄", description: "" };
        const isExpanded = expandedSections.has(section);
        return (
          <div key={section} className={styles.section}>
            <button
              className={styles.sectionHeader}
              onClick={() => toggleSection(section)}
              aria-expanded={isExpanded}
            >
              <span className={styles.sectionIcon}>{meta.icon}</span>
              <span className={styles.sectionLabel}>{meta.label}</span>
              {meta.description && (
                <span className={styles.sectionDesc}>{meta.description}</span>
              )}
              <span className={styles.chevron}>{isExpanded ? "▾" : "▸"}</span>
            </button>
            {isExpanded && (
              <div className={styles.sectionBody}>
                {renderValue(data[section])}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
