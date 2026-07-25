"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Hash-synced tab state for the deep-dive pages.
 *
 * Reads the initial tab from `window.location.hash`, keeps state in sync with
 * `hashchange` events (browser back/forward, in-app anchor links), and writes
 * the hash on selection. Unknown hashes are ignored — state stays at the
 * default — so an arbitrary `#foo` can never select a non-existent tab.
 */
export function useHashTab<K extends string>(
  validKeys: readonly K[],
  defaultKey: K
): readonly [K, (key: K) => void] {
  const [activeTab, setActiveTab] = useState<K>(defaultKey);

  useEffect(() => {
    const readHash = () => {
      const hash = window.location.hash.replace("#", "");
      if ((validKeys as readonly string[]).includes(hash)) {
        setActiveTab(hash as K);
      }
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
    // validKeys is a stable module-level constant; run once like the pages did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectTab = useCallback((key: K) => {
    setActiveTab(key);
    window.location.hash = key;
  }, []);

  return [activeTab, selectTab] as const;
}
