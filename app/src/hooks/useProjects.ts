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
 * Projects are stored in the root `projects` collection.
 * 
 * @param teamFilter - Optional prime/agent ID to filter by team membership
 * @param includeArchived - Include archived projects (default: false)
 */
export function useProjects(
  teamFilter?: string | null,
  includeArchived = false
): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);

    const col = collection(db, "projects");
    const constraints: any[] = [];

    // Filter by team membership if specified
    if (teamFilter) {
      constraints.push(where("team", "array-contains", teamFilter));
    }

    if (!includeArchived) {
      constraints.push(where("status", "==", "active"));
    }

    constraints.push(orderBy("created_at", "desc"));

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
  }, [teamFilter, includeArchived]);

  return { projects, loading };
}
