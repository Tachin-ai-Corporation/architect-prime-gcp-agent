// lib/api.ts — Generic fetch helper with null-on-failure semantics
// Original module
// Used by dashboard components for client-side API calls

/**
 * Fetch JSON from a URL. Returns null on any error (network, non-2xx, parse).
 */
export async function api<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
