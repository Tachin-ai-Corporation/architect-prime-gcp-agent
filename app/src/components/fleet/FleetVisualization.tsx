"use client";

import { useRouter } from "next/navigation";

/**
 * A stable pseudo-random value in [0,1) derived from a string.
 *
 * Used for animation jitter that must not change between renders. FNV-1a: small,
 * dependency-free, and spreads short similar keys (agent ids differing by one
 * character) well enough that adjacent lines do not pulse in lockstep.
 */
function jitter(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000) / 1000;
}
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import styles from "./FleetVisualization.module.css";
import type { FleetAgent, DeployStep } from "@/lib/types";

/* ---- SVG connection line data ---- */
export interface ConnectionLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  id: string;
}

interface ActionModalData {
  primeId: string;
  agentName: string;
  action: { title: string; instructions: string[] };
}

interface FleetVisualizationProps {
  primeId: string;
  agents: FleetAgent[];
  chatAgentName?: string;
  upgradingAgent: string | null;
  onSelectAgentChat: (primeId: string, agent: FleetAgent) => void;
  onUpgradeAgent: (primeId: string, agentName: string, e: React.MouseEvent) => void;
  onHireClick: () => void;
  onActionModal: (data: ActionModalData) => void;
}

/* ---- Status class helper ---- */
function statusClass(status: string) {
  switch (status) {
    case "online": return styles.statusOnline;
    case "deploying": return styles.statusDeploying;
    case "error": return styles.statusError;
    default: return styles.statusOffline;
  }
}

/* ---- Deploy progress helper ---- */
function getDeployProgress(steps: DeployStep[] | undefined) {
  if (!steps || steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const active = steps.find((s) => s.status === "active");
  const lastDone = [...steps].reverse().find((s) => s.status === "done");
  const progress = Math.round((done / steps.length) * 100);
  return { progress, done, total: steps.length, failed, activeStep: active, lastDoneStep: lastDone };
}

export function FleetVisualization({
  primeId,
  agents,
  chatAgentName,
  upgradingAgent,
  onSelectAgentChat,
  onUpgradeAgent,
  onHireClick,
  onActionModal,
}: FleetVisualizationProps) {
  const [lines, setLines] = useState<ConnectionLine[]>([]);
  const localAgentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const computeLines = useCallback(() => {
    const primeEl = document.getElementById(`prime-chip-${primeId}`);
    if (!primeEl) { setLines([]); return; }

    const rowEl = primeEl.parentElement;
    if (!rowEl) { setLines([]); return; }

    const rowRect = rowEl.getBoundingClientRect();
    const primeRect = primeEl.getBoundingClientRect();
    const x1 = primeRect.left + primeRect.width / 2 - rowRect.left;
    const y1 = primeRect.bottom - rowRect.top;

    const newLines: ConnectionLine[] = [];
    localAgentCardRefs.current.forEach((el, name) => {
      const agentRect = el.getBoundingClientRect();
      const x2 = agentRect.left + agentRect.width / 2 - rowRect.left;
      const y2 = agentRect.top - rowRect.top;
      newLines.push({ x1, y1, x2, y2, id: name });
    });
    setLines(newLines);
  }, [primeId]);

  useLayoutEffect(() => {
    const timer = setTimeout(computeLines, 120);
    return () => clearTimeout(timer);
  }, [computeLines, agents]);

  useEffect(() => {
    const primeEl = document.getElementById(`prime-chip-${primeId}`);
    if (!primeEl) return;
    const container = primeEl.parentElement;
    if (!container) return;
    const observer = new ResizeObserver(() => computeLines());
    observer.observe(container);
    return () => observer.disconnect();
  }, [computeLines, primeId]);
  const router = useRouter();

  return (
    <>
      {/* SVG Connection Lines */}
      {lines.length > 0 && (
        <svg className={styles.connectionLayer} aria-hidden="true">
          <defs>
            <linearGradient id="lineGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(31,154,155,0.35)" />
              <stop offset="100%" stopColor="rgba(31,154,155,0.08)" />
            </linearGradient>
          </defs>
          {lines.map((line) => {
            const pathD = `M ${line.x1} ${line.y1} Q ${(line.x1 + line.x2) / 2} ${line.y1 + 30} ${line.x2} ${line.y2}`;
            // Jitter derived from the line id rather than Math.random().
            //
            // Random during render is impure: React may render a component more
            // than once for the same state, and each pass produced different
            // animation timings — so the dots re-staggered on every unrelated
            // re-render instead of pulsing steadily. Deriving from the id gives
            // each line its own stable offset and keeps render a pure function
            // of props, which is what the animation actually wanted.
            const j = jitter(line.id);
            return (
              <g key={line.id}>
                <path d={pathD} stroke="url(#lineGrad)" strokeWidth="1.5" fill="none" opacity="0.7" />
                <circle r="2.5" className={styles.pulseDot}>
                  <animateMotion dur={`${2 + j * 1.5}s`} repeatCount="indefinite" path={pathD} />
                </circle>
                <circle r="1.5" className={styles.pulseDot} opacity="0.4">
                  <animateMotion dur={`${2.5 + j * 1.5}s`} repeatCount="indefinite" path={pathD} begin={`${1 + jitter(`${line.id}:begin`)}s`} />
                </circle>
              </g>
            );
          })}
        </svg>
      )}

      <div className={styles.agentSection}>
        <div className={styles.agentGrid} id="agent-grid">
          {agents.map((agent, i) => {
            const dp = getDeployProgress(agent.deploySteps);
            const isDeploying = agent.status === "deploying" && dp;
            const isChatTarget = chatAgentName === agent.name;

            return (
              <div
                key={agent.name}
                ref={(el) => {
                  if (el) localAgentCardRefs.current.set(agent.name, el);
                  else localAgentCardRefs.current.delete(agent.name);
                }}
                className={`${styles.agentCard} ${agent.status === "online" ? styles.agentCardOnline : ""} ${isChatTarget ? styles.agentCardActive : ""}`}
                style={{ animationDelay: `${i * 80}ms` }}
                id={`agent-card-${agent.name}`}
                onClick={() => router.push(`/p/${primeId}/a/${agent.name}`)}
                data-proximity
              >
                <div className={styles.agentHeader}>
                  <div className={styles.agentAvatar}>
                    {agent.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className={styles.agentName}>{agent.name}</div>
                    <div className={styles.agentMeta}>
                      <span className={styles.specialtyBadge}>{agent.specialty}</span>
                      <span className={`${styles.statusDot} ${statusClass(agent.status)}`} />
                      <span>{agent.status}</span>
                      {agent.actionRequired && (
                        <button
                          className={styles.actionBadge}
                          onClick={(e) => {
                            e.stopPropagation();
                            onActionModal({
                              primeId,
                              agentName: agent.name,
                              action: agent.actionRequired!,
                            });
                          }}
                          title="Action required"
                        >
                          ⚠
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Deploy progress */}
                {isDeploying && dp && (
                  <div className={styles.deploySection}>
                    <div className={styles.deployBar}>
                      <div
                        className={`${styles.deployBarFill} ${dp.failed > 0 ? styles.deployBarFailed : ""}`}
                        style={{ width: `${dp.progress}%` }}
                      />
                    </div>
                    <div className={styles.deployInfo}>
                      <span className={styles.deployPct}>{dp.progress}%</span>
                      <span className={styles.deployStep}>
                        {dp.activeStep
                          ? `⏳ ${dp.activeStep.label}`
                          : dp.lastDoneStep
                          ? `✅ ${dp.lastDoneStep.label}`
                          : `${dp.done}/${dp.total}`}
                      </span>
                    </div>
                  </div>
                )}

                {/* Chat + Upgrade footer */}
                {agent.status === "online" && (
                  <div className={styles.agentFooter}>
                    <button
                      className={styles.agentChatBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectAgentChat(primeId, agent);
                      }}
                      title={`Chat with ${agent.name}`}
                      id={`chat-agent-${agent.name}`}
                    >
                      💬
                    </button>
                    <button
                      className={styles.agentUpgradeBtn}
                      onClick={(e) => onUpgradeAgent(primeId, agent.name, e)}
                      disabled={upgradingAgent === agent.name}
                      title={`Upgrade ${agent.name} CoreKit`}
                      id={`upgrade-agent-${agent.name}`}
                    >
                      {upgradingAgent === agent.name ? "⏳" : "⬆ Upgrade"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* +Hire card */}
          <div
            className={styles.hireCard}
            onClick={onHireClick}
            id="hire-agent-btn"
            data-proximity
          >
            <span className={styles.hireCardIcon}>+</span>
            <span className={styles.hireCardText}>Hire</span>
          </div>
        </div>
      </div>
    </>
  );
}
