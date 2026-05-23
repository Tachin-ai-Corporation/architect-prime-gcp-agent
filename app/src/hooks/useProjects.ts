"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  orderBy,
  where,
  onSnapshot,
} from "firebase/firestore";
import type { Project } from "@/lib/types";

interface UseProjectsResult {
  projects: Project[];
  loading: boolean;
}

/**
 * Real-time Firestore listener for projects.
 * Uses client-side Firebase SDK with onSnapshot for instant updates.
 * Only returns active projects by default.
 */
export function useProjects(
  primeId: string | null,
  includeArchived = false
): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!primeId) {
      setProjects([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const col = collection(db, "primes", primeId, "projects");
    const constraints = includeArchived
      ? [orderBy("created_at", "desc")]
      : [where("status", "==", "active"), orderBy("created_at", "desc")];

    const q = query(col, ...constraints);

    const unsub = onSnapshot(
      q,
      (snap) => {
        const docs = snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Project[];
        setProjects(docs);
        setLoading(false);
      },
      (err) => {
        console.error("[useProjects] snapshot error:", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [primeId, includeArchived]);

  return { projects, loading };
}
