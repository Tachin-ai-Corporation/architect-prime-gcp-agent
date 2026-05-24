"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { api } from "@/lib/api";
import type { WorkEnvelope } from "@/lib/types";

/* ---- TreeNode: WorkEnvelope + recursive children ---- */
export interface TreeNode extends Omit<WorkEnvelope, 'children'> {
  childIds: string[];
  children: TreeNode[];
}

/* ---- Active status set (roots that go into "current") ---- */
const ACTIVE_STATUSES = new Set<string>(["active", "waiting", "needs_input"]);
const DONE_STATUSES = new Set<string>(["complete", "failed", "cancelled"]);

/* ---- Return shape ---- */
export interface UseWorkEnvelopesResult {
  current: TreeNode[];
  queue: TreeNode[];
  previous: TreeNode[];
  allEnvelopes: WorkEnvelope[];
  /** @deprecated Use current/queue/previous instead */
  envelopes: WorkEnvelope[];
  loading: boolean;
}

/**
 * Builds a parent→children map from flat envelopes and returns root TreeNodes.
 */
function buildTrees(envelopes: WorkEnvelope[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();

  // First pass: create TreeNode wrappers
  for (const e of envelopes) {
    nodeMap.set(e.id, { ...e, childIds: e.children || [], children: [] });
  }

  const roots: TreeNode[] = [];

  // Second pass: link children to parents
  for (const e of envelopes) {
    const node = nodeMap.get(e.id)!;
    if (!e.parent_id || !nodeMap.has(e.parent_id)) {
      roots.push(node);
    } else {
      nodeMap.get(e.parent_id)!.children.push(node);
    }
  }

  // Sort children chronologically within each parent
  for (const node of nodeMap.values()) {
    node.children.sort(
      (a, b) => (a.created_at || "").localeCompare(b.created_at || "")
    );
  }

  return roots;
}

/**
 * Collect all envelope IDs that belong to a tree rooted at `root`.
 */
function collectTreeIds(root: TreeNode, ids: Set<string>): void {
  ids.add(root.id);
  for (const child of root.children) {
    collectTreeIds(child, ids);
  }
}

/**
 * Helper to match an envelope's owner (which might be an email like devops-agent-stan@domain)
 * to a short agent name (like "stan").
 */
export function matchAgent(owner: string | undefined | null, agentName: string): boolean {
  if (!owner) return false;
  const ownerLower = owner.toLowerCase();
  const agentLower = agentName.toLowerCase();
  if (ownerLower === agentLower) return true;
  const emailPrefix = ownerLower.split("@")[0];
  const segments = emailPrefix.split(/[-_.]/);
  return segments.includes(agentLower);
}

/**
 * Hook that fetches work envelopes and buckets them into current / queue / previous trees.
 * Supports optional agent name filtering.
 */
export function useWorkEnvelopes(
  primeId: string | null,
  agentFilter?: string | null
): UseWorkEnvelopesResult {
  const [envelopes, setEnvelopes] = useState<WorkEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!primeId) {
      setEnvelopes([]);
      setLoading(false);
      return;
    }

    const fetchWork = async () => {
      const data = await api<{ envelopes: WorkEnvelope[] }>(
        `/api/primes/${primeId}/work`
      );
      if (data?.envelopes) {
        setEnvelopes(data.envelopes);
      }
      setLoading(false);
    };

    setLoading(true);
    fetchWork();

    // Poll every 5s
    pollRef.current = setInterval(fetchWork, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [primeId]);

  const { current, queue, previous, allEnvelopes } = useMemo(() => {
    // Optional agent filter — keep only envelopes where owner matches
    let filtered = envelopes;
    if (agentFilter) {
      filtered = envelopes.filter((e) => matchAgent(e.owner, agentFilter));
    }

    // Build full trees from filtered envelopes
    const trees = buildTrees(filtered);

    // Bucket root-level trees by the root's status
    const currentTrees: TreeNode[] = [];
    const queueTrees: TreeNode[] = [];
    const previousTrees: TreeNode[] = [];

    for (const root of trees) {
      // Only M-type (or R-type) roots should be top-level buckets.
      // C/T without a known parent also land here.
      if (ACTIVE_STATUSES.has(root.status)) {
        currentTrees.push(root);
      } else if (root.status === "pending") {
        queueTrees.push(root);
      } else if (DONE_STATUSES.has(root.status)) {
        previousTrees.push(root);
      } else {
        // Blocked, archived, etc → previous
        previousTrees.push(root);
      }
    }

    // Sort previous by completed_at descending (most recent first)
    previousTrees.sort(
      (a, b) =>
        (b.completed_at || b.updated_at || "").localeCompare(
          a.completed_at || a.updated_at || ""
        )
    );

    return {
      current: currentTrees,
      queue: queueTrees,
      previous: previousTrees,
      allEnvelopes: filtered,
      envelopes: filtered,
    };
  }, [envelopes, agentFilter]);

  return { current, queue, previous, allEnvelopes, envelopes: allEnvelopes, loading };
}
