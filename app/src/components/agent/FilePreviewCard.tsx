"use client";

import { useState } from "react";
import styles from "./FilePreviewCard.module.css";

/* ================================================================
   FilePreviewCard — compact card with truncated content preview.
   On click, opens a full-screen overlay to read the entire file.
   ================================================================ */

export interface FileCardItem {
  key: string;
  label: string;
  icon: string;
  role?: string;
  accent?: string;
  content: string | null;
}

interface FilePreviewCardProps {
  item: FileCardItem;
  onClick: () => void;
}

function FilePreviewCard({ item, onClick }: FilePreviewCardProps) {
  const hasContent = item.content !== null;

  return (
    <button
      className={hasContent ? styles.card : styles.cardDisabled}
      style={{ "--card-accent": item.accent || "var(--border-subtle)" } as React.CSSProperties}
      onClick={hasContent ? onClick : undefined}
      type="button"
    >
      <div className={styles.header}>
        <span className={styles.icon}>{item.icon}</span>
        <span className={styles.label}>{item.label}</span>
      </div>
      {item.role && <div className={styles.role}>{item.role}</div>}
      {hasContent ? (
        <pre className={styles.preview}>{item.content!.slice(0, 400)}</pre>
      ) : (
        <div className={styles.emptyHint}>Not found on agent</div>
      )}
    </button>
  );
}

/* ================================================================
   FileViewerModal — full-screen overlay to read the entire file.
   ================================================================ */

interface FileViewerModalProps {
  item: FileCardItem | null;
  onClose: () => void;
}

function FileViewerModal({ item, onClose }: FileViewerModalProps) {
  if (!item) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.modalHeaderLeft}>
            <span className={styles.modalIcon}>{item.icon}</span>
            <span className={styles.modalTitle}>{item.label}</span>
            {item.role && <span className={styles.modalRole}>— {item.role}</span>}
          </div>
          <button className={styles.modalClose} onClick={onClose} type="button">
            ✕
          </button>
        </div>
        <div className={styles.modalBody}>
          <pre className={styles.modalPre}>{item.content || ""}</pre>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   FilePreviewGrid — the combined grid + modal controller.
   ================================================================ */

interface FilePreviewGridProps {
  items: FileCardItem[];
  columns?: 2 | 3;
}

export function FilePreviewGrid({ items, columns = 3 }: FilePreviewGridProps) {
  const [activeItem, setActiveItem] = useState<FileCardItem | null>(null);

  return (
    <>
      <div
        className={styles.grid}
        style={{ "--grid-cols": columns } as React.CSSProperties}
      >
        {items.map((item) => (
          <FilePreviewCard
            key={item.key}
            item={item}
            onClick={() => setActiveItem(item)}
          />
        ))}
      </div>
      <FileViewerModal item={activeItem} onClose={() => setActiveItem(null)} />
    </>
  );
}
