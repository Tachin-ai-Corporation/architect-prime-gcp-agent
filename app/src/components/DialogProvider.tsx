"use client";

import { useState, useCallback, createContext, useContext, useRef, useEffect } from "react";

/* ---- Types ---- */
interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "danger";
}

interface ToastOptions {
  message: string;
  variant?: "success" | "error" | "info";
  duration?: number;
}

interface DialogContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  toast: (options: ToastOptions) => void;
}

const DialogContext = createContext<DialogContextType | null>(null);

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within <DialogProvider>");
  return ctx;
}

/* ---- Toast Component ---- */
function Toast({ message, variant = "info", onClose }: ToastOptions & { onClose: () => void }) {
  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  useEffect(() => {
    // auto-dismiss handled by parent
  }, []);

  return (
    <div className={`toast toast-${variant}`} role="alert">
      <span className="toast-icon">{icons[variant]}</span>
      <span className="toast-message">{message}</span>
      <button className="toast-close" onClick={onClose} aria-label="Close">✕</button>
    </div>
  );
}

/* ---- Confirm Modal Component ---- */
function ConfirmModal({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Focus the confirm button on mount
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="dialog-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) onCancel(); }}>
      <div className="dialog-modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-header">
          <h3 className="dialog-title" id="dialog-title">{title}</h3>
        </div>
        <div className="dialog-body">
          {message.split("\n").map((line, i) => (
            <p key={i} className="dialog-line">{line}</p>
          ))}
        </div>
        <div className="dialog-footer">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            className={`btn btn-sm ${variant === "danger" ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- Provider ---- */
interface ActiveConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface ActiveToast extends ToastOptions {
  id: number;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [activeConfirm, setActiveConfirm] = useState<ActiveConfirm | null>(null);
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const toastIdRef = useRef(0);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setActiveConfirm({ ...options, resolve });
    });
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = ++toastIdRef.current;
    const duration = options.duration ?? 4000;
    setToasts((prev) => [...prev, { ...options, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const handleConfirm = useCallback(() => {
    activeConfirm?.resolve(true);
    setActiveConfirm(null);
  }, [activeConfirm]);

  const handleCancel = useCallback(() => {
    activeConfirm?.resolve(false);
    setActiveConfirm(null);
  }, [activeConfirm]);

  return (
    <DialogContext.Provider value={{ confirm, toast }}>
      {children}
      {activeConfirm && (
        <ConfirmModal
          title={activeConfirm.title}
          message={activeConfirm.message}
          confirmText={activeConfirm.confirmText}
          cancelText={activeConfirm.cancelText}
          variant={activeConfirm.variant}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <Toast
              key={t.id}
              message={t.message}
              variant={t.variant}
              onClose={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            />
          ))}
        </div>
      )}
    </DialogContext.Provider>
  );
}
