"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { api } from "@/lib/api";
import type { WorkEnvelope } from "@/lib/types";

export interface WorkTreeNode {
  envelope: WorkEnvelope;
  children: WorkTreeNode[];
}

interface UseWorkEnvelopesResult {
  envelopes: WorkEnvelope[];
  tree: WorkTreeNode[];
  loading: boolean;
  error: string | null;
}

/**
 * Hook that polls the server-side work API for envelope data.
 * Uses Admin SDK on the server — no client-side Firebase auth needed.
 * Polls every 5s for near-real-time updates.
 */
export function useWorkEnvelopes(primeId: string | null): UseWorkEnvelopesResult {
  const [envelopes, setEnvelopes] = useState<WorkEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        setError(null);
      }
      setLoading(false);
    };

    // Initial fetch
    setLoading(true);
    setError(null);
    fetchWork();

    // Poll every 5s
    pollRef.current = setInterval(fetchWork, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [primeId]);

  // Build tree structure from flat list
  const tree = useMemo(() => {
    const nodeMap = new Map<string, WorkTreeNode>();
    for (const e of envelopes) {
      nodeMap.set(e.id, { envelope: e, children: [] });
    }

    const roots: WorkTreeNode[] = [];
    for (const e of envelopes) {
      const node = nodeMap.get(e.id)!;
      if (!e.parent_id || !nodeMap.has(e.parent_id)) {
        roots.push(node);
      } else {
        nodeMap.get(e.parent_id)!.children.push(node);
      }
    }

    // Sort children by created_at ascending (chronological within a parent)
    for (const node of nodeMap.values()) {
      node.children.sort(
        (a, b) => (a.envelope.created_at || "").localeCompare(b.envelope.created_at || "")
      );
    }

    return roots;
  }, [envelopes]);

  return { envelopes, tree, loading, error };
}
