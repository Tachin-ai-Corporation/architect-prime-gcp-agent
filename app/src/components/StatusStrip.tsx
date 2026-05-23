"use client";

import styles from "./StatusStrip.module.css";

interface StatusItem {
  label: string;
  value: string | number;
  color?: "mint" | "aqua" | "amber" | "default";
  /** Alias for color — accepts any string for forward compat */
  variant?: string;
}

/* Map semantic variant names to design-system color tokens */
const VARIANT_MAP: Record<string, string> = {
  success: "mint",
  info: "aqua",
  warning: "amber",
  mint: "mint",
  aqua: "aqua",
  amber: "amber",
};

interface StatusStripProps {
  items: StatusItem[];
}

export function StatusStrip({ items }: StatusStripProps) {
  return (
    <div className={styles.strip} id="status-strip">
      {items.map((item) => {
        const resolved = item.color ?? VARIANT_MAP[item.variant ?? ""] ?? "";
        const colorClass = resolved && resolved !== "default" && styles[resolved] ? styles[resolved] : "";
        return (
          <span key={item.label} className={`${styles.pill} ${colorClass}`.trim()}>
            {item.label}
            <span className={styles.pillValue}>{item.value}</span>
          </span>
        );
      })}
    </div>
  );
}
