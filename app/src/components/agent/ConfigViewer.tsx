"use client";

import { useState } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import { useIntrospect } from "@/hooks/useIntrospect";
import styles from "./ConfigViewer.module.css";

/* ---- Types ---- */
interface EarsConfig {
  mode: string;
  poll_interval_ms: number;
}

interface MouthConfig {
  mode: string;
}

interface DispatchConfig {
  max_concurrent_missions: number;
  max_mission_iterations: number;
  max_checkpoint_iterations: number;
}

interface PrimeConfig {
  ears?: EarsConfig;
  mouth?: MouthConfig;
  dispatch?: DispatchConfig;
  models?: Record<string, string>;
  [key: string]: unknown;
}

/** Prime dispatch/ears/mouth/model config viewer — read-only, via the brain_config introspect. */
export function ConfigViewer({ primeId }: { primeId: string }) {
  const { primes } = usePrime();
  const prime = primes.find((p) => p.id === primeId);
  const [expandedSection, setExpandedSection] = useState<string | null>("dispatch");

  const { data, loading, error, refresh } = useIntrospect<PrimeConfig>({
    primeId,
    agent: `prime-${primeId}`,
    type: "brain_config",
    autoFetch: true,
  });

  const toggleSection = (key: string) => {
    setExpandedSection((prev) => (prev === key ? null : key));
  };

  return (
    <div className={styles.configPage}>
      <div className={styles.configHeader}>
        <h1 className={styles.configTitle}>{prime?.name || primeId} — Configuration</h1>
        <button className={styles.refreshBtn} onClick={refresh} disabled={loading}>
          {loading ? "⏳" : "↻"} Refresh
        </button>
      </div>

      {error && (
        <div className={styles.errorBanner}>
          Failed to load configuration: {error}
          <button className={styles.retryBtn} onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {loading && !data && (
        <div className={styles.loadingState}>Loading configuration…</div>
      )}

      {data && (
        <div className={styles.sections}>
          {/* Dispatch Settings */}
          <div className={styles.section}>
            <button className={styles.sectionHeader} onClick={() => toggleSection("dispatch")}>
              <span className={styles.sectionIcon}>📡</span>
              <span className={styles.sectionTitle}>Dispatch Settings</span>
              <span className={`${styles.chevron} ${expandedSection === "dispatch" ? styles.chevronOpen : ""}`}>›</span>
            </button>
            {expandedSection === "dispatch" && (
              <div className={styles.sectionBody}>
                <div className={styles.configGrid}>
                  <span className={styles.configLabel}>Max Concurrent Missions</span>
                  <span className={styles.configValue}>{data.dispatch?.max_concurrent_missions ?? "—"}</span>
                  <span className={styles.configLabel}>Max Mission Iterations</span>
                  <span className={styles.configValue}>{data.dispatch?.max_mission_iterations ?? "—"}</span>
                  <span className={styles.configLabel}>Max Checkpoint Iterations</span>
                  <span className={styles.configValue}>{data.dispatch?.max_checkpoint_iterations ?? "—"}</span>
                </div>
              </div>
            )}
          </div>

          {/* Ears Config */}
          <div className={styles.section}>
            <button className={styles.sectionHeader} onClick={() => toggleSection("ears")}>
              <span className={styles.sectionIcon}>👂</span>
              <span className={styles.sectionTitle}>Ears (Input)</span>
              <span className={`${styles.chevron} ${expandedSection === "ears" ? styles.chevronOpen : ""}`}>›</span>
            </button>
            {expandedSection === "ears" && (
              <div className={styles.sectionBody}>
                <div className={styles.configGrid}>
                  <span className={styles.configLabel}>Mode</span>
                  <span className={styles.configValue}>{data.ears?.mode ?? "—"}</span>
                  <span className={styles.configLabel}>Poll Interval</span>
                  <span className={styles.configValue}>{data.ears?.poll_interval_ms ? `${data.ears.poll_interval_ms}ms` : "—"}</span>
                </div>
              </div>
            )}
          </div>

          {/* Mouth Config */}
          <div className={styles.section}>
            <button className={styles.sectionHeader} onClick={() => toggleSection("mouth")}>
              <span className={styles.sectionIcon}>📢</span>
              <span className={styles.sectionTitle}>Mouth (Output)</span>
              <span className={`${styles.chevron} ${expandedSection === "mouth" ? styles.chevronOpen : ""}`}>›</span>
            </button>
            {expandedSection === "mouth" && (
              <div className={styles.sectionBody}>
                <div className={styles.configGrid}>
                  <span className={styles.configLabel}>Mode</span>
                  <span className={styles.configValue}>{data.mouth?.mode ?? "—"}</span>
                </div>
              </div>
            )}
          </div>

          {/* Models Overview */}
          {data.models && Object.keys(data.models).length > 0 && (
            <div className={styles.section}>
              <button className={styles.sectionHeader} onClick={() => toggleSection("models")}>
                <span className={styles.sectionIcon}>🧠</span>
                <span className={styles.sectionTitle}>Model Assignments</span>
                <span className={`${styles.chevron} ${expandedSection === "models" ? styles.chevronOpen : ""}`}>›</span>
              </button>
              {expandedSection === "models" && (
                <div className={styles.sectionBody}>
                  <div className={styles.configGrid}>
                    {Object.entries(data.models).map(([slot, model]) => (
                      <div key={slot} className={styles.modelRow}>
                        <span className={styles.configLabel}>{slot}</span>
                        <span className={styles.configValueMono}>{String(model)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Raw Config (debug) */}
          <div className={styles.section}>
            <button className={styles.sectionHeader} onClick={() => toggleSection("raw")}>
              <span className={styles.sectionIcon}>🔧</span>
              <span className={styles.sectionTitle}>Raw Config</span>
              <span className={`${styles.chevron} ${expandedSection === "raw" ? styles.chevronOpen : ""}`}>›</span>
            </button>
            {expandedSection === "raw" && (
              <div className={styles.sectionBody}>
                <pre className={styles.rawJson}>{JSON.stringify(data, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
