"use client";
import React, { useEffect, useState, useCallback } from "react";
import styles from "./MissionPresence.module.css";
import { api } from "../lib/api";

interface PresenceEnvelope {
  id: string;
  type: 'R' | 'M' | 'C' | 'T';
  parent_id: string | null;
  status: string;
  title?: string;
  instruction: string;
  created_at: string;
  updated_at: string;
  source_channel?: string;
  blocker?: string | null;
}

function deriveActivity(rootId: string, envelopes: PresenceEnvelope[]): PresenceEnvelope | null {
  // Filter active descendant envelopes
  const activeEnvelopes = envelopes.filter(
    (e) => e.status !== "complete" && e.status !== "failed" && e.status !== "cancelled" && e.status !== "archived" && e.status !== "rejected"
  );
  
  // Build parent-to-children mapping of active envelopes
  const parentToChildren = new Map<string, PresenceEnvelope[]>();
  for (const e of activeEnvelopes) {
    if (e.parent_id) {
      if (!parentToChildren.has(e.parent_id)) {
        parentToChildren.set(e.parent_id, []);
      }
      parentToChildren.get(e.parent_id)!.push(e);
    }
  }

  let deepestNode: PresenceEnvelope | null = null;
  let maxDepth = -1;

  function traverse(node: PresenceEnvelope, depth: number) {
    if (depth > maxDepth) {
      maxDepth = depth;
      deepestNode = node;
    } else if (depth === maxDepth && deepestNode) {
      // Tie breaker: prefer the one created/updated latest
      const nodeTime = node.updated_at || node.created_at || "";
      const deepestTime = deepestNode.updated_at || deepestNode.created_at || "";
      if (nodeTime.localeCompare(deepestTime) > 0) {
        deepestNode = node;
      }
    }

    const children = parentToChildren.get(node.id) || [];
    for (const child of children) {
      traverse(child, depth + 1);
    }
  }

  const rootNode = envelopes.find((e) => e.id === rootId);
  if (rootNode) {
    traverse(rootNode, 0);
  }

  // Only return if it is a descendant (depth > 0)
  const finalNode = deepestNode as PresenceEnvelope | null;
  return finalNode && finalNode.id !== rootId ? finalNode : null;
}

export function MissionPresence({ primeId }: { primeId: string }) {
  const [missions, setMissions] = useState<PresenceEnvelope[]>([]);
  const [allEnvelopes, setAllEnvelopes] = useState<PresenceEnvelope[]>([]);

  const load = useCallback(() => {
    if (!primeId) return;
    api<{ envelopes: PresenceEnvelope[] }>(`/api/primes/${primeId}/work`).then(
      (res) => {
        if (res && res.envelopes) {
          setAllEnvelopes(res.envelopes);
          // Active root missions (type M)
          // F6: The presence strip exists solely for real-time human interaction on the dashboard;
          // scheduling loops and automated chat channels must never pollute it.
          const activeMissions = res.envelopes.filter(
            (e) => e.type === "M" &&
                   e.status !== "complete" && e.status !== "failed" && e.status !== "cancelled" && e.status !== "archived" && e.status !== "rejected" &&
                   e.source_channel !== "schedule" && e.source_channel !== "gchat"
          );
          setMissions(activeMissions);
        }
      }
    ).catch((err) => {
      console.error("[MissionPresence] Error loading work envelopes:", err);
    });
  }, [primeId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (missions.length === 0) return null;

  return (
    <div className={styles.strip}>
      {missions.map((m) => {
        const attention = m.status === "needs_input" || m.status === "blocked";
        const activity = deriveActivity(m.id, allEnvelopes);
        
        // Build subrow text: either the blocker explanation (when attention is active)
        // or descendant traversal activity.
        let sublineText = "";
        if (attention) {
          const rawBlocker = m.blocker || "";
          sublineText = rawBlocker.length > 120 ? rawBlocker.slice(0, 117) + "..." : rawBlocker;
        } else if (activity) {
          const rawText = activity.title || activity.instruction || activity.id;
          sublineText = `→ ${rawText.length > 120 ? rawText.slice(0, 117) + "..." : rawText}`;
        }

        return (
          <div key={m.id} className={`${styles.item} ${attention ? styles.attention : ""}`}>
            <div className={styles.mainRow}>
              {!attention && <span className={styles.spinner} aria-hidden />}
              {attention && <span className={styles.alertDot} aria-hidden>!</span>}
              <span className={styles.title}>{m.title || m.id}</span>
              <span className={styles.status}>{m.status.replace("_", " ")}</span>
            </div>
            {sublineText && (
              <div className={styles.subRow}>
                {sublineText}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
