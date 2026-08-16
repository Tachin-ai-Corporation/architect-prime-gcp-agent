"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { api } from "@/lib/api";
import type {
  PrimeInstance,
  FleetAgent,
  SetupState,
} from "@/lib/types";

/* ---- Version info (matches /api/upgrade response) ---- */
export interface VersionInfo {
  deployedVersion: string;
  latestVersion: string;
  deployedStable: boolean;
  latestStable: boolean;
  deployedCommit: string;
  mainHeadSha: string;
  updateAvailable: boolean;
  currentVersion: string;
  latestTag: string;
}

/* ---- Context shape ---- */
interface PrimeContextType {
  primes: PrimeInstance[];
  setup: SetupState;
  sidebarFleet: Record<string, FleetAgent[]>;
  versionInfo: VersionInfo | null;
  loading: boolean;
  refreshPrimes: () => Promise<void>;
  refreshFleet: (primeId: string) => Promise<void>;
}

const PrimeCtx = createContext<PrimeContextType | null>(null);

/* ---- Hook ---- */
export function usePrime(): PrimeContextType {
  const ctx = useContext(PrimeCtx);
  if (!ctx) throw new Error("usePrime must be used within <PrimeProvider>");
  return ctx;
}

/* ---- Provider ---- */
export function PrimeProvider({ children }: { children: React.ReactNode }) {
  const [primes, setPrimes] = useState<PrimeInstance[]>([]);
  const [setup, setSetup] = useState<SetupState>({
    hasPrimes: false,
    dwdConfigured: false,
    authConfigured: false,
    projectId: "",
    dwdSignerSA: "",
    dwdClientId: "",
    agentEmailDomain: "",
    artifactsRootFolderId: "",
  });
  const [sidebarFleet, setSidebarFleet] = useState<Record<string, FleetAgent[]>>({});
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fleetPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ---- Refresh helpers ---- */
  const refreshPrimes = useCallback(async () => {
    const data = await api<{ primes: PrimeInstance[] }>("/api/primes");
    if (data?.primes) setPrimes(data.primes);
  }, []);

  const refreshFleet = useCallback(async (primeId: string) => {
    const data = await api<{ fleet: FleetAgent[] }>(`/api/primes/${primeId}/fleet`);
    if (data?.fleet) {
      setSidebarFleet((prev) => ({ ...prev, [primeId]: data.fleet }));
    }
  }, []);

  /* ---- Initial load ---- */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [setupData, primesData, ver] = await Promise.all([
        api<SetupState>("/api/setup"),
        api<{ primes: PrimeInstance[] }>("/api/primes"),
        api<VersionInfo>("/api/upgrade"),
      ]);

      if (cancelled) return;

      if (setupData) setSetup(setupData);
      if (primesData?.primes) setPrimes(primesData.primes);
      if (ver) setVersionInfo(ver);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, []);

  /* ---- Fleet polling (every 8s, all primes) ---- */
  //
  // Keyed on the ids, not the count. The dependency was `primes.length` while
  // the loop closed over `primes` itself, so swapping one prime for another —
  // same count, different id — left the poller fetching the old one forever.
  // `primes` is a new array on every refresh, so depending on it directly would
  // tear down and re-subscribe the interval on each poll instead.
  const primeIdsKey = primes.map((p) => p.id).join(",");
  useEffect(() => {
    const ids = primeIdsKey ? primeIdsKey.split(",") : [];
    if (ids.length === 0) return;

    const loadAllFleet = async () => {
      for (const id of ids) {
        const data = await api<{ fleet: FleetAgent[] }>(`/api/primes/${id}/fleet`);
        if (data?.fleet) {
          setSidebarFleet((prev) => ({ ...prev, [id]: data.fleet }));
        }
      }
    };

    // Initial fetch
    void loadAllFleet();

    // Poll every 8s
    fleetPollRef.current = setInterval(loadAllFleet, 8000);
    return () => {
      if (fleetPollRef.current) clearInterval(fleetPollRef.current);
    };
  }, [primeIdsKey]);

  /* ---- Value ---- */
  const value: PrimeContextType = {
    primes,
    setup,
    sidebarFleet,
    versionInfo,
    loading,
    refreshPrimes,
    refreshFleet,
  };

  return <PrimeCtx.Provider value={value}>{children}</PrimeCtx.Provider>;
}
