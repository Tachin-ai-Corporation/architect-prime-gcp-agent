"use client";

import { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrime } from "@/contexts/PrimeContext";
import styles from "./Breadcrumb.module.css";

/* ---- Static label map for known route segments ---- */
const SEGMENT_LABELS: Record<string, string> = {
  p: "Primes",
  a: "Agents",
  settings: "Settings",
  work: "Work",
  fleet: "Fleet",
  chat: "Chat",
  deploy: "Deploy",
  setup: "Setup",
  projects: "Projects",
  models: "Models",
  skills: "Skills",
  brain: "Brain",
};

/* Segments that are structural labels only — not clickable */
const NON_LINKABLE = new Set(["p", "a"]);

interface Crumb {
  label: string;
  href: string;
  linkable: boolean;
}

export function Breadcrumb() {
  const pathname = usePathname();
  const { primes, sidebarFleet } = usePrime();

  const crumbs = useMemo<Crumb[]>(() => {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 0) return [{ label: "Home", href: "/", linkable: true }];

    const result: Crumb[] = [{ label: "Home", href: "/", linkable: true }];
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

    return result;
  }, [pathname, primes, sidebarFleet]);

  return (
    <nav className={styles.bar} aria-label="Breadcrumb" id="breadcrumb-nav">
      <ol className={styles.segments}>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={crumb.href} style={{ display: "flex", alignItems: "center" }}>
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

