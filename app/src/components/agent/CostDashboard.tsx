"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./CostDashboard.module.css";

/* ---- Types ---- */

interface LlmUsageEntry {
  mission_id: string;
  organ: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  duration_ms: number;
  timestamp: string;
}

interface MissionCost {
  missionId: string;
  title: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalDurationMs: number;
  callCount: number;
  byOrgan: Record<string, { input: number; output: number; cached: number; calls: number }>;
}

/* ---- Component ---- */

interface CostDashboardProps {
  primeId: string;
  agentName?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

// Rough cost estimation (Gemini Flash pricing as baseline)
function estimateCost(input: number, output: number, cached: number): number {
  // Pricing per 1M tokens (approximate)
  const INPUT_RATE = 0.075;   // $0.075 per 1M input tokens (Flash)
  const OUTPUT_RATE = 0.30;   // $0.30 per 1M output tokens (Flash)
  const CACHED_RATE = 0.01875; // 75% discount on cached

  return (
    (input * INPUT_RATE / 1_000_000) +
    (output * OUTPUT_RATE / 1_000_000) +
    (cached * CACHED_RATE / 1_000_000)
  );
}

const ORGAN_COLORS: Record<string, string> = {
  cortex: "#9B59B6",
  prefrontal: "#1F9A9B",
  motor: "#E67E22",
  cerebellum: "#3BAA78",
  "temporal-research": "#3498DB",
  "temporal-memory": "#667788",
};

export function CostDashboard({ primeId, agentName }: CostDashboardProps) {
  const [missions, setMissions] = useState<MissionCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedMission, setExpandedMission] = useState<string | null>(null);

  const fetchCosts = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ primeId });
      if (agentName) params.set("agent", agentName);
      const res = await fetch(`/api/telemetry/costs?${params}`);
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = await res.json();
      setMissions(data.missions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [primeId, agentName]);

  useEffect(() => {
    fetchCosts();
  }, [fetchCosts]);

  if (loading) {
    return <div className={styles.empty}>Loading cost data…</div>;
  }

  if (error) {
    return (
      <div className={styles.empty}>
        <span>⚠️ {error}</span>
        <button className={styles.retry} onClick={fetchCosts}>Retry</button>
      </div>
    );
  }

  // Aggregate totals
  const totals = missions.reduce(
    (acc, m) => ({
      input: acc.input + m.totalInputTokens,
      output: acc.output + m.totalOutputTokens,
      cached: acc.cached + m.totalCachedTokens,
      calls: acc.calls + m.callCount,
      duration: acc.duration + m.totalDurationMs,
    }),
    { input: 0, output: 0, cached: 0, calls: 0, duration: 0 }
  );

  const totalCost = estimateCost(totals.input, totals.output, totals.cached);

  // Aggregate by organ across all missions
  const organTotals: Record<string, { input: number; output: number; cached: number; calls: number }> = {};
  for (const m of missions) {
    for (const [organ, data] of Object.entries(m.byOrgan)) {
      if (!organTotals[organ]) organTotals[organ] = { input: 0, output: 0, cached: 0, calls: 0 };
      organTotals[organ].input += data.input;
      organTotals[organ].output += data.output;
      organTotals[organ].cached += data.cached;
      organTotals[organ].calls += data.calls;
    }
  }

  return (
    <div className={styles.container}>
      {/* Summary cards */}
      <div className={styles.summary}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{formatTokens(totals.input + totals.output)}</span>
          <span className={styles.statLabel}>Total Tokens</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>${totalCost.toFixed(4)}</span>
          <span className={styles.statLabel}>Est. Cost</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{totals.calls}</span>
          <span className={styles.statLabel}>LLM Calls</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{missions.length}</span>
          <span className={styles.statLabel}>Missions</span>
        </div>
      </div>

      {/* Organ breakdown */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Cost by Organ</div>
        <div className={styles.organGrid}>
          {Object.entries(organTotals)
            .sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))
            .map(([organ, data]) => {
              const organCost = estimateCost(data.input, data.output, data.cached);
              const pct = totalCost > 0 ? (organCost / totalCost) * 100 : 0;
              return (
                <div key={organ} className={styles.organRow}>
                  <span
                    className={styles.organDot}
                    style={{ background: ORGAN_COLORS[organ] || "#667788" }}
                  />
                  <span className={styles.organName}>{organ}</span>
                  <span className={styles.organCalls}>{data.calls} calls</span>
                  <span className={styles.organTokens}>
                    {formatTokens(data.input)} in / {formatTokens(data.output)} out
                  </span>
                  <div className={styles.organBar}>
                    <div
                      className={styles.organBarFill}
                      style={{
                        width: `${pct}%`,
                        background: ORGAN_COLORS[organ] || "#667788",
                      }}
                    />
                  </div>
                  <span className={styles.organCost}>${organCost.toFixed(4)}</span>
                </div>
              );
            })}
        </div>
      </div>

      {/* Mission list */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Per-Mission Costs</div>
        {missions.length === 0 ? (
          <div className={styles.empty}>No telemetry data yet</div>
        ) : (
          missions.map((m) => {
            const mCost = estimateCost(m.totalInputTokens, m.totalOutputTokens, m.totalCachedTokens);
            const isExpanded = expandedMission === m.missionId;
            return (
              <div key={m.missionId} className={styles.missionCard}>
                <button
                  className={styles.missionHeader}
                  onClick={() => setExpandedMission(isExpanded ? null : m.missionId)}
                >
                  <span className={styles.missionTitle}>{m.title || m.missionId}</span>
                  <span className={styles.missionMeta}>
                    {m.callCount} calls · {formatTokens(m.totalInputTokens + m.totalOutputTokens)} tokens
                  </span>
                  <span className={styles.missionCost}>${mCost.toFixed(4)}</span>
                  <span className={styles.chevron}>{isExpanded ? "▾" : "▸"}</span>
                </button>
                {isExpanded && (
                  <div className={styles.missionBody}>
                    {Object.entries(m.byOrgan).map(([organ, data]) => (
                      <div key={organ} className={styles.organDetail}>
                        <span
                          className={styles.organDot}
                          style={{ background: ORGAN_COLORS[organ] || "#667788" }}
                        />
                        <span className={styles.organName}>{organ}</span>
                        <span className={styles.organTokens}>
                          {formatTokens(data.input)} in / {formatTokens(data.output)} out
                          {data.cached > 0 && ` (${formatTokens(data.cached)} cached)`}
                        </span>
                        <span className={styles.organCalls}>{data.calls} calls</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
