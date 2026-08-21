"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrime } from "@/contexts/PrimeContext";
import styles from "./Breadcrumb.module.css";

/* ---- Real path segments only (hash tabs are handled separately, below) ---- */
const SEGMENT_LABELS: Record<string, string> = {
  p: "Primes",
  a: "Agents",
  settings: "Settings",
  projects: "Projects",
  processes: "Processes",
  studio: "Fleet Studio",
  models: "Models",
  skills: "Skills",
  library: "Library",
  "agent-types": "Roles",
};

/* ---- Hash-tab labels — the deep-dive and settings tab sets ----
   These live in the URL hash, not the path, so the breadcrumb reads the hash to
   show which tab you're actually on (path alone can't express tab state). */
const HASH_LABELS: Record<string, string> = {
  chat: "Chat",
  work: "Work",
  overview: "Persona",
  brain: "Brain",
  fleet: "Fleet",
  projects: "Projects",
  processes: "Processes",
  config: "Config",
  memory: "Memory",
  contracts: "Contracts",
  approvals: "Approvals",
  general: "General",
  integration: "Integration",
  security: "Security",
  secrets: "Secrets",
  system: "System",
};

/* Segments that are structural labels only — not clickable */
const NON_LINKABLE = new Set(["p", "a"]);

interface Crumb {
  label: string;
  href: string;
  linkable: boolean;
}

export function Breadcrumb({ inline }: { inline?: boolean } = {}) {
  const pathname = usePathname();
  const { primes, sidebarFleet } = usePrime();

  // Track the active hash tab (client-only) so the trailing crumb tells the truth
  // about which tab you're on. Re-read on pathname change and on hashchange.
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash.replace("#", ""));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [pathname]);

  const crumbs = useMemo<Crumb[]>(() => {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 0) return []; // Home — logo is the home link

    const result: Crumb[] = [];
    let builtPath = "";

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      builtPath += `/${seg}`;

      // Dynamic: /p/{id} → resolve Prime name
      if (parts[i - 1] === "p") {
        const prime = primes.find((p) => p.id === seg);
        result.push({ label: prime?.name ?? seg, href: builtPath, linkable: true });
        continue;
      }

      // Dynamic: /a/{agent} → resolve agent name from fleet
      if (parts[i - 1] === "a") {
        const primeIdx = parts.indexOf("p");
        const primeId = primeIdx >= 0 ? parts[primeIdx + 1] : "";
        const fleet = sidebarFleet[primeId] ?? [];
        const agent = fleet.find((f) => f.name === seg);
        result.push({ label: agent?.name ?? seg, href: builtPath, linkable: true });
        continue;
      }

      // Static labels
      result.push({
        label: SEGMENT_LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1),
        href: builtPath,
        linkable: !NON_LINKABLE.has(seg),
      });
    }

    // Trailing crumb for the active hash tab (deep-dive / settings), when recognised.
    if (hash && HASH_LABELS[hash]) {
      result.push({ label: HASH_LABELS[hash], href: `${pathname}#${hash}`, linkable: false });
    }

    return result;
  }, [pathname, primes, sidebarFleet, hash]);

  return (
    <nav className={`${styles.bar} ${inline ? styles.barInline : ""}`} aria-label="Breadcrumb" id="breadcrumb-nav">
      <ol className={styles.segments}>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={`${crumb.href}-${i}`} style={{ display: "flex", alignItems: "center" }}>
              {i > 0 && <span className={styles.separator} aria-hidden>›</span>}
              {isLast || !crumb.linkable ? (
                <span className={`${styles.segment} ${isLast ? styles.current : styles.muted}`}>
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} className={styles.segment}>
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
