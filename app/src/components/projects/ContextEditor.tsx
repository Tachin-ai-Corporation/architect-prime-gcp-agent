"use client";

import { useState, useCallback } from "react";
import styles from "./ContextEditor.module.css";

/* ---- Types ---- */
export interface ContextEntry {
  kind: "drive_folder" | "sheet" | "doc" | "dataset" | "url" | "template" | "people" | "convention";
  ref: string | null;
  url?: string;
  name: string;
  summary: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ContextEditorProps {
  context: Record<string, ContextEntry>;
  onChange: (context: Record<string, ContextEntry>) => void;
  readOnly?: boolean;
}

/* ---- Kind → emoji map ---- */
const KIND_ICONS: Record<ContextEntry["kind"], string> = {
  drive_folder: "📁",
  sheet: "📊",
  doc: "📄",
  dataset: "🗄️",
  url: "🔗",
  template: "📋",
  people: "👥",
  convention: "📐",
};

const KIND_OPTIONS: ContextEntry["kind"][] = [
  "drive_folder", "sheet", "doc", "dataset", "url", "template", "people", "convention",
];

/* ---- URL auto-detection ---- */
function detectKindFromUrl(url: string): { kind: ContextEntry["kind"]; ref: string | null } {
  try {
    const u = new URL(url);
    const path = u.pathname;

    if (u.hostname === "docs.google.com" && path.startsWith("/spreadsheets")) {
      const match = path.match(/\/d\/([a-zA-Z0-9_-]+)/);
      return { kind: "sheet", ref: match?.[1] ?? null };
    }
    if (u.hostname === "docs.google.com" && path.startsWith("/document")) {
      const match = path.match(/\/d\/([a-zA-Z0-9_-]+)/);
      return { kind: "doc", ref: match?.[1] ?? null };
    }
    if (u.hostname === "drive.google.com" && path.includes("/folders/")) {
      const match = path.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      return { kind: "drive_folder", ref: match?.[1] ?? null };
    }
    if (u.hostname === "docs.google.com" && path.startsWith("/presentation")) {
      const match = path.match(/\/d\/([a-zA-Z0-9_-]+)/);
      return { kind: "template", ref: match?.[1] ?? null };
    }
    return { kind: "url", ref: null };
  } catch {
    return { kind: "url", ref: null };
  }
}

/* ---- Blank entry for the add form ---- */
const BLANK_FORM = { key: "", kind: "url" as ContextEntry["kind"], ref: "", url: "", name: "", summary: "" };

/* ---- Normalize legacy free-form context values ---- */
function normalizeEntry(key: string, raw: unknown): ContextEntry {
  // Already a proper ContextEntry (has 'kind' and 'name')
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw && "name" in raw) {
    return raw as ContextEntry;
  }
  // Legacy: plain string
  if (typeof raw === "string") {
    return { kind: "convention", ref: null, name: key.replace(/_/g, " "), summary: raw };
  }
  // Legacy: array (e.g. service_accounts, cloud_run_services)
  if (Array.isArray(raw)) {
    const summary = raw.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        return Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(", ");
      }
      return String(item);
    }).join("\n");
    return { kind: "dataset", ref: null, name: key.replace(/_/g, " "), summary };
  }
  // Legacy: nested object without kind/name
  if (raw && typeof raw === "object") {
    const summary = Object.entries(raw).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
    return { kind: "convention", ref: null, name: key.replace(/_/g, " "), summary };
  }
  // Fallback
  return { kind: "convention", ref: null, name: key.replace(/_/g, " "), summary: String(raw ?? "") };
}

/* ---- Component ---- */
export function ContextEditor({ context, onChange, readOnly = false }: ContextEditorProps) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });

  // Normalize all entries so legacy free-form values render properly
  const entries: [string, ContextEntry][] = Object.entries(context).map(
    ([key, raw]) => [key, normalizeEntry(key, raw)]
  );

  /* ---- Toggle expand ---- */
  const toggleExpand = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  }, []);

  /* ---- Delete ---- */
  const handleDelete = useCallback(
    (key: string) => {
      const next = { ...context };
      delete next[key];
      onChange(next);
      if (expandedKey === key) setExpandedKey(null);
    },
    [context, onChange, expandedKey]
  );

  /* ---- Inline edit ---- */
  const handleFieldChange = useCallback(
    (key: string, field: keyof ContextEntry, value: string) => {
      const entry = context[key];
      if (!entry) return;
      onChange({ ...context, [key]: { ...entry, [field]: value } });
    },
    [context, onChange]
  );

  /* ---- URL paste in add form ---- */
  const handleUrlChange = useCallback(
    (url: string) => {
      const detected = detectKindFromUrl(url);
      setForm((f) => ({ ...f, url, kind: detected.kind, ref: detected.ref ?? "" }));
    },
    []
  );

  /* ---- Add entry ---- */
  const handleAdd = useCallback(() => {
    if (!form.key.trim() || !form.name.trim()) return;
    const entry: ContextEntry = {
      kind: form.kind,
      ref: form.ref || null,
      url: form.url || undefined,
      name: form.name,
      summary: form.summary,
    };
    onChange({ ...context, [form.key.trim()]: entry });
    setForm({ ...BLANK_FORM });
    setShowAddForm(false);
  }, [form, context, onChange]);

  return (
    <div className={styles.editor}>
      {/* ---- Entry rows ---- */}
      {entries.length === 0 && (
        <div className={styles.empty}>No context entries yet</div>
      )}
      {entries.map(([key, entry]) => {
        const expanded = expandedKey === key;
        return (
          <div key={key} className={`${styles.row} ${expanded ? styles.rowExpanded : ""}`}>
            {/* Compact row */}
            <button
              className={styles.rowHeader}
              onClick={() => toggleExpand(key)}
              type="button"
            >
              <span className={styles.kindIcon}>{KIND_ICONS[entry.kind]}</span>
              <span className={styles.rowKey}>{key}</span>
              <span className={styles.rowName}>{entry.name}</span>
              <span className={styles.rowSummary}>{truncate(entry.summary, 40)}</span>
              {entry.updatedBy && (
                <span className={styles.updatedChip}>{entry.updatedBy}</span>
              )}
              {!readOnly && (
                <span
                  className={styles.deleteBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(key);
                  }}
                  role="button"
                  tabIndex={0}
                  title="Remove entry"
                >
                  ✕
                </span>
              )}
              <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}>▾</span>
            </button>

            {/* Expanded detail */}
            {expanded && (
              <div className={styles.detail}>
                <div className={styles.detailGrid}>
                  <label className={styles.detailLabel}>Kind</label>
                  <span className={styles.detailValue}>
                    {KIND_ICONS[entry.kind]} {entry.kind}
                  </span>

                  <label className={styles.detailLabel}>Ref</label>
                  {readOnly ? (
                    <span className={styles.detailValue}>{entry.ref ?? "—"}</span>
                  ) : (
                    <input
                      className={styles.detailInput}
                      value={entry.ref ?? ""}
                      onChange={(e) => handleFieldChange(key, "ref", e.target.value)}
                      placeholder="Resource ID"
                    />
                  )}

                  <label className={styles.detailLabel}>URL</label>
                  {readOnly ? (
                    <span className={styles.detailValue}>
                      {entry.url ? (
                        <a href={entry.url} target="_blank" rel="noopener noreferrer" className={styles.link}>
                          {entry.url}
                        </a>
                      ) : "—"}
                    </span>
                  ) : (
                    <input
                      className={styles.detailInput}
                      value={entry.url ?? ""}
                      onChange={(e) => handleFieldChange(key, "url", e.target.value)}
                      placeholder="https://..."
                    />
                  )}

                  <label className={styles.detailLabel}>Name</label>
                  {readOnly ? (
                    <span className={styles.detailValue}>{entry.name}</span>
                  ) : (
                    <input
                      className={styles.detailInput}
                      value={entry.name}
                      onChange={(e) => handleFieldChange(key, "name", e.target.value)}
                      placeholder="Entry name"
                    />
                  )}

                  <label className={styles.detailLabel}>Summary</label>
                  {readOnly ? (
                    <span className={styles.detailValue}>{entry.summary}</span>
                  ) : (
                    <textarea
                      className={styles.detailTextarea}
                      value={entry.summary}
                      onChange={(e) => handleFieldChange(key, "summary", e.target.value)}
                      rows={3}
                      placeholder="Describe this context entry…"
                    />
                  )}

                  {entry.updatedAt && (
                    <>
                      <label className={styles.detailLabel}>Updated</label>
                      <span className={styles.detailMeta}>
                        {new Date(entry.updatedAt).toLocaleDateString()} by {entry.updatedBy ?? "unknown"}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* ---- Add form ---- */}
      {!readOnly && (
        <>
          {showAddForm ? (
            <div className={styles.addForm}>
              <div className={styles.addFormTitle}>Add Context Entry</div>
              <div className={styles.addGrid}>
                <label className={styles.addLabel}>Key</label>
                <input
                  className={styles.addInput}
                  value={form.key}
                  onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                  placeholder="e.g. project_tracker"
                />

                <label className={styles.addLabel}>URL</label>
                <input
                  className={styles.addInput}
                  value={form.url}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  placeholder="Paste URL to auto-detect kind"
                />

                <label className={styles.addLabel}>Kind</label>
                <select
                  className={styles.addSelect}
                  value={form.kind}
                  onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ContextEntry["kind"] }))}
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_ICONS[k]} {k}
                    </option>
                  ))}
                </select>

                <label className={styles.addLabel}>Ref</label>
                <input
                  className={styles.addInput}
                  value={form.ref}
                  onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))}
                  placeholder="Resource ID (auto-filled from URL)"
                />

                <label className={styles.addLabel}>Name</label>
                <input
                  className={styles.addInput}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Display name"
                />

                <label className={styles.addLabel}>Summary</label>
                <textarea
                  className={styles.addTextarea}
                  value={form.summary}
                  onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
                  rows={2}
                  placeholder="What is this resource?"
                />
              </div>
              <div className={styles.addActions}>
                <button className={styles.cancelBtn} onClick={() => { setShowAddForm(false); setForm({ ...BLANK_FORM }); }}>
                  Cancel
                </button>
                <button className={styles.confirmBtn} onClick={handleAdd} disabled={!form.key.trim() || !form.name.trim()}>
                  Add Entry
                </button>
              </div>
            </div>
          ) : (
            <button className={styles.addBtn} onClick={() => setShowAddForm(true)}>
              + Add entry
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ---- Helpers ---- */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
