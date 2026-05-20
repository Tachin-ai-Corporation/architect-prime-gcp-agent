"use client";

import { useState, useEffect, useMemo } from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
} from "firebase/firestore";
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

export function useWorkEnvelopes(primeId: string | null): UseWorkEnvelopesResult {
  const [envelopes, setEnvelopes] = useState<WorkEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!primeId) {
      setEnvelopes([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Filter to last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = Timestamp.fromDate(sevenDaysAgo);

    const workRef = collection(db, "primes", primeId, "work");
    const q = query(
      workRef,
      where("created_at", ">=", cutoff.toDate().toISOString()),
      orderBy("created_at", "desc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const docs: WorkEnvelope[] = snapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            type: data.type || "T",
            parent_id: data.parent_id || null,
            owner: data.owner || "",
            status: data.status || "pending",
            intent: data.intent || "",
            instruction: data.instruction || "",
            accept_criteria: data.accept_criteria || "",
            context_summary: data.context_summary || null,
            output: data.output || null,
            error: data.error || null,
            children: data.children || [],
            source_channel: data.source_channel || "",
            source_meta: data.source_meta || {},
            created_at: data.created_at || "",
            started_at: data.started_at || null,
            completed_at: data.completed_at || null,
            updated_at: data.updated_at || "",
            iteration: data.iteration || 0,
          } as WorkEnvelope;
        });
        setEnvelopes(docs);
        setLoading(false);
      },
      (err) => {
        console.error("[useWorkEnvelopes] onSnapshot error:", err);
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [primeId]);

  // Build tree structure from flat list
  const tree = useMemo(() => {
    const byId = new Map<string, WorkEnvelope>();
    for (const e of envelopes) {
      byId.set(e.id, e);
    }

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

    // Sort children by created_at desc
    for (const node of nodeMap.values()) {
      node.children.sort(
        (a, b) => (b.envelope.created_at || "").localeCompare(a.envelope.created_at || "")
      );
    }

    return roots;
  }, [envelopes]);

  return { envelopes, tree, loading, error };
}
