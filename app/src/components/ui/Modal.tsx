"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** Overlay class. Defaults to the global `dialog-overlay`; pass a caller's own
   *  overlay class to preserve its look while still getting shared behavior. */
  overlayClassName?: string;
  /** Modal-box class. Defaults to the global `dialog-modal`. */
  className?: string;
  /** id of the heading element, for aria-labelledby. */
  labelledBy?: string;
  /** Close when the backdrop (not the box) is clicked. Default true. */
  closeOnBackdrop?: boolean;
}

/**
 * Shared modal shell: fixed overlay + backdrop, click-outside-to-close, and
 * Escape-to-close. This behavior was hand-rolled — often incompletely (missing
 * Escape) — across the dashboard's bespoke modals. Callers keep their own
 * overlay/box CSS via the class props, so looks are preserved while behavior is
 * unified and the missing Escape handling is added everywhere.
 */
export function Modal({
  onClose,
  children,
  overlayClassName = "dialog-overlay",
  className = "dialog-modal",
  labelledBy,
  closeOnBackdrop = true,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className={overlayClassName}
      onClick={
        closeOnBackdrop
          ? (e) => {
              if (e.target === overlayRef.current) onClose();
            }
          : undefined
      }
    >
      <div className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}
