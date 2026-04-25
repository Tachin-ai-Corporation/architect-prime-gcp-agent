"use client";

import { useState, useCallback, createContext, useContext, useRef, useEffect } from "react";
import { CommandProgress } from "./CommandProgress";

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

interface TrackedCommand {
  id: number;
  primeId: string;
  commandId: string;
  label: string;
}

interface DialogContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  toast: (options: ToastOptions) => void;
  trackCommand: (primeId: string, commandId: string, label: string) => void;
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
  const [trackedCommands, setTrackedCommands] = useState<TrackedCommand[]>([]);
  const toastIdRef = useRef(0);
  const cmdIdRef = useRef(0);

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

  const trackCommand = useCallback((primeId: string, commandId: string, label: string) => {
    const id = ++cmdIdRef.current;
    setTrackedCommands((prev) => [...prev, { id, primeId, commandId, label }]);
  }, []);

  const handleConfirm = useCallback(() => {
    activeConfirm?.resolve(true);
    setActiveConfirm(null);
  }, [activeConfirm]);

  const handleCancel = useCallback(() => {
    activeConfirm?.resolve(false);
    setActiveConfirm(null);
  }, [activeConfirm]);

  const dismissCommand = useCallback((id: number) => {
    setTrackedCommands((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return (
    <DialogContext.Provider value={{ confirm, toast, trackCommand }}>
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
      {(toasts.length > 0 || trackedCommands.length > 0) && (
        <div className="toast-container">
          {trackedCommands.map((cmd) => (
            <CommandProgress
              key={cmd.id}
              primeId={cmd.primeId}
              commandId={cmd.commandId}
              label={cmd.label}
              onDismiss={() => dismissCommand(cmd.id)}
            />
          ))}
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
