"use client";

import { forwardRef } from "react";
import styles from "./PrimeGrid.module.css";
import type { PrimeInstance, FleetAgent } from "@/lib/types";

/* ---- Chat target ---- */
export interface ChatTarget {
  type: "prime" | "agent";
  primeId: string;
  agentName?: string;
  entityName: string;
  entityStatus: string;
  specialty?: string;
}

interface PrimeChipProps {
  prime: PrimeInstance;
  fleet: FleetAgent[];
  isSelected: boolean;
  upgradingPrime: string | null;
  deletingPrime: string | null;
  onSelect: (prime: PrimeInstance) => void;
  onUpgrade: (primeId: string, e: React.MouseEvent) => void;
  onDelete: (primeId: string, primeName: string, e: React.MouseEvent) => void;
  onChat: (primeId: string, primeName: string, status: string) => void;
  children?: React.ReactNode;
}

/* ---- Status class helper ---- */
function statusClass(status: string) {
  switch (status) {
    case "online": return styles.statusOnline;
    case "deploying": return styles.statusDeploying;
    case "error": return styles.statusError;
    default: return styles.statusOffline;
  }
}

export { statusClass };

export const PrimeChip = forwardRef<HTMLButtonElement, PrimeChipProps>(function PrimeChip(
  { prime, fleet, isSelected, upgradingPrime, deletingPrime, onSelect, onUpgrade, onDelete, onChat, children },
  ref,
) {
  return (
    <div className={styles.primeRow}>
      <div
        id={`prime-chip-${prime.id}`}
        ref={isSelected ? ref as React.Ref<HTMLDivElement> : undefined}
        className={`${styles.primeChip} ${styles.primeChipSelected}`}
        onClick={() => onSelect(prime)}
        data-proximity
      >
        <span className={`${styles.statusDot} ${statusClass(prime.status)}`} />
        <span className={styles.chipName}>{prime.name}</span>
        <span className={styles.chipMeta}>
          {fleet.length} agent{fleet.length !== 1 ? "s" : ""} · {prime.status}
        </span>
        <span className={styles.chipSpacer} />

        {/* Upgrade CoreKit button on Prime chip */}
        {prime.status === "online" && (
          <button
            className={styles.chipUpgradeBtn}
            onClick={(e) => onUpgrade(prime.id, e)}
            disabled={upgradingPrime === prime.id}
            title="Upgrade Prime CoreKit"
            id={`upgrade-prime-${prime.id}`}
          >
            {upgradingPrime === prime.id ? "⏳" : "⬆ Upgrade"}
          </button>
        )}

        {/* Chat with Prime button */}
        {prime.status === "online" && (
          <button
            className={styles.chipChatBtn}
            onClick={(e) => {
              e.stopPropagation();
              onChat(prime.id, prime.name, prime.status);
            }}
            title={`Chat with ${prime.name}`}
            id={`chat-prime-${prime.id}`}
          >
            💬
          </button>
        )}

        {/* Delete Prime button */}
        {prime.status !== "deploying" && prime.status !== "tearing_down" && (
          <button
            className={styles.chipDeleteBtn}
            onClick={(e) => onDelete(prime.id, prime.name, e)}
            disabled={deletingPrime === prime.id}
            title="Delete Prime"
            id={`delete-prime-${prime.id}`}
          >
            {deletingPrime === prime.id ? "⏳" : "🗑"}
          </button>
        )}
      </div>

      {/* Children slot: SVG lines + agent grid rendered by parent */}
      {children}
    </div>
  );
});
