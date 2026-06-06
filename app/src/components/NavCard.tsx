"use client";

import Link from "next/link";
import styles from "./NavCard.module.css";

interface NavCardProps {
  id?: string;
  icon?: string;
  iconColor?: string;
  title: string;
  description?: string;
  href?: string;
  onClick?: () => void;
  variant?: "default" | "accent" | "action" | "warm";
  badge?: string | number;
  badgeVariant?: string;
  progress?: number;
}

export function NavCard({
  id: customId,
  icon,
  iconColor,
  title,
  description,
  href,
  onClick,
  variant = "default",
  badge,
  badgeVariant,
  progress,
}: NavCardProps) {
  const variantClass = variant !== "default" ? styles[variant] : "";
  const className = `${styles.card} ${variantClass}`.trim();
  const elementId = customId ?? `navcard-${title.toLowerCase().replace(/\s+/g, "-")}`;

  const content = (
    <>
      {badge != null && (
        <span
          className={styles.badge}
          style={badgeVariant ? { background: `var(--badge-${badgeVariant}, rgba(86,99,115,0.15))` } : undefined}
        >
          {badge}
        </span>
      )}
      {icon && (
        <span className={styles.icon} style={iconColor ? { color: iconColor } : undefined}>
          {icon}
        </span>
      )}
      <span className={styles.title}>{title}</span>
      {description && <span className={styles.description}>{description}</span>}
      {progress != null && (
        <div className={styles.progressWrap}>
          <div
            className={styles.progressBar}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className} id={elementId}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      id={elementId}
    >
      {content}
    </button>
  );
}
