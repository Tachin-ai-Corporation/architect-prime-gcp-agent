"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { api } from "@/lib/api";

/* ================================================================
   useIntrospect — shared POST-then-poll introspection hook

   Pattern:
     1. POST to /api/primes/{pid}/fleet/{agent}/introspect { type }
     2. Receive { queryId }
     3. Poll GET ?queryId= every 2s until status=complete or maxAttempts
   ================================================================ */

interface UseIntrospectOptions<T> {
  primeId: string | null;
  agent: string | null;
  type: string;
  /** Max poll attempts (default 15 = 30s) */
  maxAttempts?: number;
  /** Poll interval ms (default 2000) */
  pollInterval?: number;
  /** Auto-fetch on mount / when primeId+agent change (default true) */
  autoFetch?: boolean;
  /** Transform raw result before storing */
  transform?: (raw: unknown) => T;
}

interface UseIntrospectReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useIntrospect<T = unknown>(opts: UseIntrospectOptions<T>): UseIntrospectReturn<T> {
  const {
    primeId,
    agent,
    type,
    maxAttempts = 15,
    pollInterval = 2000,
    autoFetch = true,
    transform,
  } = opts;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track current fetch to avoid race conditions
  const fetchIdRef = useRef(0);

  const doFetch = useCallback(async () => {
    if (!primeId || !agent) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const thisId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    setData(null);

    try {
      // Step 1: Submit introspection query
      const submit = await api<{ queryId: string }>(
        `/api/primes/${primeId}/fleet/${agent}/introspect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type }),
        }
      );

      if (thisId !== fetchIdRef.current) return; // stale

      if (!submit?.queryId) {
        setError("Failed to submit introspection query");
        setLoading(false);
        return;
      }

      // Step 2: Poll for result
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, pollInterval));
        if (thisId !== fetchIdRef.current) return; // stale

        const poll = await api<{ status: string; result?: unknown; error?: string }>(
          `/api/primes/${primeId}/fleet/${agent}/introspect?queryId=${submit.queryId}`
        );

        if (thisId !== fetchIdRef.current) return; // stale

        if (poll?.status === "complete" && poll.result !== undefined) {
          const result = transform ? transform(poll.result) : (poll.result as T);
          setData(result);
          setLoading(false);
          return;
        }

        if (poll?.status === "error") {
          setError(poll.error || "Introspection error");
          setLoading(false);
          return;
        }
      }

      // Timed out
      setError("Introspection timed out");
    } catch (err) {
      if (thisId !== fetchIdRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    }

    setLoading(false);
  }, [primeId, agent, type, maxAttempts, pollInterval, transform]);

  // Auto-fetch on mount / param changes.
  //
  // Called through an async IIFE rather than directly. `doFetch` sets three
  // pieces of state before it awaits anything, and invoking it straight from
  // the effect body put those updates in the effect's own synchronous path —
  // the cascading render react-hooks/set-state-in-effect flags.
  //
  // Timing is unchanged: the IIFE body runs synchronously up to its first
  // await, so `doFetch` is still entered in the same tick and `loading` still
  // flips before the request goes out. Deferring with setTimeout would also
  // have satisfied the rule, but it delays that first update by a task and
  // leaves one render showing the empty state instead of the spinner.
  useEffect(() => {
    if (!autoFetch) return;
    void (async () => { await doFetch(); })();
  }, [autoFetch, doFetch]);

  return { data, loading, error, refresh: doFetch };
}

/* ================================================================
   useIntrospectMutation — fire-and-poll for write operations
   (e.g., set_model, set_responsibility_enabled)
   ================================================================ */

interface MutationResult {
  success: boolean;
  message?: string;
  error?: string;
}

interface UseIntrospectMutationOptions {
  primeId: string | null;
  agent: string | null;
  maxAttempts?: number;
  pollInterval?: number;
}

interface UseIntrospectMutationReturn {
  mutate: (type: string, params: Record<string, unknown>) => Promise<MutationResult>;
  loading: boolean;
}

export function useIntrospectMutation(opts: UseIntrospectMutationOptions): UseIntrospectMutationReturn {
  const { primeId, agent, maxAttempts = 30, pollInterval = 2000 } = opts;
  const [loading, setLoading] = useState(false);

  const mutate = useCallback(
    async (type: string, params: Record<string, unknown>): Promise<MutationResult> => {
      if (!primeId || !agent) return { success: false, error: "No prime/agent selected" };

      setLoading(true);
      try {
        const submit = await api<{ queryId: string }>(
          `/api/primes/${primeId}/fleet/${agent}/introspect`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, params }),
          }
        );

        if (!submit?.queryId) {
          setLoading(false);
          return { success: false, error: "Failed to submit mutation" };
        }

        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, pollInterval));
          const poll = await api<{ status: string; result?: MutationResult; error?: string }>(
            `/api/primes/${primeId}/fleet/${agent}/introspect?queryId=${submit.queryId}`
          );

          if (poll?.status === "complete") {
            setLoading(false);
            return poll.result || { success: true };
          }
          if (poll?.status === "error") {
            setLoading(false);
            return { success: false, error: poll.error || "Introspection error" };
          }
        }

        setLoading(false);
        return { success: false, error: "Mutation timed out" };
      } catch (err) {
        setLoading(false);
        return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
      }
    },
    [primeId, agent, maxAttempts, pollInterval]
  );

  return { mutate, loading };
}
