"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import type { WorkEnvelope } from "@/lib/types";
import { ACTIVE_STATUSES } from "@/lib/types";

/* ---- TreeNode: WorkEnvelope + recursive children ---- */
export interface TreeNode extends Omit<WorkEnvelope, 'children'> {
  childIds: string[];
  children: TreeNode[];
}

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
  /** Lazy-load the full tree for a completed mission */
  loadTree: (workId: string) => Promise<void>;
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

  // Would linking `childId` under `parentId` close a cycle? Walk up the parent_id
  // chain from the prospective parent; reaching the child (or revisiting any node)
  // means the link is cyclic. Malformed parent_id graphs do occur in practice — a
  // mission's churn / ATTACH can point an envelope back at an ancestor — and without
  // this guard the recursive tree render (WorkTree / hasActiveDescendant) would
  // infinite-loop and crash the tab. Guarding here keeps the built children graph a
  // strict forest, so every downstream consumer is automatically cycle-safe.
  const wouldCycle = (childId: string, parentId: string): boolean => {
    let cur: string | null | undefined = parentId;
    const seen = new Set<string>();
    while (cur && nodeMap.has(cur)) {
      if (cur === childId || seen.has(cur)) return true;
      seen.add(cur);
      cur = nodeMap.get(cur)!.parent_id;
    }
    return false;
  };

  const roots: TreeNode[] = [];

  // Second pass: link children to parents (self-links and cycles fall back to root)
  for (const e of envelopes) {
    const node = nodeMap.get(e.id)!;
    const parentId = e.parent_id;
    if (!parentId || !nodeMap.has(parentId) || parentId === e.id || wouldCycle(e.id, parentId)) {
      roots.push(node);
    } else {
      nodeMap.get(parentId)!.children.push(node);
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

export function matchAgent(owner: string | undefined | null, agentName: string): boolean {
  if (!owner) return false;
  const ownerLower = owner.toLowerCase();
  const agentLower = agentName.toLowerCase();
  if (ownerLower === agentLower) return true;
  const emailPrefix = ownerLower.split("@")[0];
  if (emailPrefix === agentLower) return true;

  // Prime variations matching:
  // "prime" matches "prime-*" or "prime"
  if (ownerLower === "prime" && (agentLower === "prime" || agentLower.startsWith("prime-"))) {
    return true;
  }
  if ((agentLower === "prime" || agentLower.startsWith("prime-")) && (ownerLower === "prime" || emailPrefix === "prime")) {
    return true;
  }

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
  const loadedTreesRef = useRef<Set<string>>(new Set());
  // Descendants pulled in by loadTree (lazy subtree expansion). The /work poll returns
  // completed missions root-only, so without retaining these across a poll the expanded
  // checkpoints/tasks get wiped from under an open row. Terminal history is immutable, so
  // retaining them is always safe; the fresh /work payload wins on any id collision.
  const loadedEnvelopesRef = useRef<Map<string, WorkEnvelope>>(new Map());

  useEffect(() => {
    if (!primeId) {
      void (async () => {
        setEnvelopes([]);
        setLoading(false);
      })();
      return;
    }

    // New prime → drop lazily-loaded subtrees from the previous one so the merge below
    // can't leak them across the switch (they'd be absent from the new prime's payload
    // and therefore retained).
    loadedTreesRef.current = new Set();
    loadedEnvelopesRef.current = new Map();

    let cancelled = false;
    const fetchWork = async () => {
      const data = await api<{ envelopes: WorkEnvelope[] }>(
        `/api/primes/${primeId}/work`
      );
      if (cancelled) return;
      if (data?.envelopes) {
        // Merge, don't replace. The shallow /work payload omits descendants of completed
        // missions, but the user may have lazily expanded them via loadTree. Keep the fresh
        // roots (they win on id collision) and re-attach any loaded descendants the payload
        // dropped, so an open checkpoint/task tree survives the poll + tab-refocus refetch.
        const freshIds = new Set(data.envelopes.map((e) => e.id));
        const retained = [...loadedEnvelopesRef.current.values()].filter(
          (e) => !freshIds.has(e.id)
        );
        setEnvelopes(retained.length > 0 ? [...data.envelopes, ...retained] : data.envelopes);
      }
      setLoading(false);
    };

    // Wrapped so these updates are not in the effect body; same tick, same order.
    void (async () => {
      setLoading(true);
      await fetchWork();
    })();

    // Refresh on an interval, but skip while the tab is hidden. The previous fixed
    // 5s poll re-fetched the whole work set and rebuilt every tree forever — even on
    // a backgrounded tab — the kind of steady churn that pressures memory on a long-
    // open, heavy page. Poll less often, only when visible, and refresh immediately
    // when the tab regains focus so it never looks stale.
    const REFRESH_MS = 15000;
    const tick = () => { if (!document.hidden) fetchWork(); };
    pollRef.current = setInterval(tick, REFRESH_MS);
    const onVisible = () => { if (!document.hidden) fetchWork(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", onVisible);
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

    const hasActiveDescendant = (node: TreeNode): boolean => {
      for (const child of node.children) {
        if (ACTIVE_STATUSES.has(child.status) || child.status === "pending") {
          return true;
        }
        if (hasActiveDescendant(child)) {
          return true;
        }
      }
      return false;
    };

    for (const root of trees) {
      // Only M-type (or R-type) roots should be top-level buckets.
      // C/T without a known parent also land here.
      if (ACTIVE_STATUSES.has(root.status) && root.status !== "queued") {
        currentTrees.push(root);
      } else if (root.type === "R" && hasActiveDescendant(root)) {
        currentTrees.push(root);
      } else if (root.status === "queued" || root.status === "pending" || root.status === "planned") {
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

  const loadTree = useCallback(async (workId: string) => {
    if (!primeId || loadedTreesRef.current.has(workId)) return;
    loadedTreesRef.current.add(workId);
    try {
      const data = await api<{ envelopes: WorkEnvelope[] }>(
        `/api/primes/${primeId}/work/${workId}/tree`
      );
      if (data?.envelopes?.length) {
        // Remember every envelope from this subtree so a later /work poll (completed roots
        // only) can't wipe the expanded descendants — see the merge in fetchWork.
        for (const e of data.envelopes) {
          loadedEnvelopesRef.current.set(e.id, e);
        }
        setEnvelopes(prev => {
          const existingIds = new Set(prev.map(e => e.id));
          const newOnes = data.envelopes.filter(e => !existingIds.has(e.id));
          return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
        });
      }
    } catch (err) {
      console.error(`[useWorkEnvelopes] loadTree error:`, err);
      loadedTreesRef.current.delete(workId); // allow retry
    }
  }, [primeId]);

  return { current, queue, previous, allEnvelopes, envelopes: allEnvelopes, loading, loadTree };
}
