"use client";

import { useState, useCallback, useMemo } from "react";
import styles from "./CanonEditor.module.css";

/* ---- Types ---- */
export interface CanonEntry {
  key: string;
  text: string;
  updated_at?: string;
  updated_by?: string;
}

export interface Canon {
  authority: string[];
  entries: CanonEntry[];
}

export interface CanonEditorProps {
  canon: Canon | undefined;
  onChange: (canon: Canon) => void;
}

/* ---- Blank form ---- */
const BLANK_FORM = { key: "", text: "" };

/* ---- Component ---- */
export function CanonEditor({ canon, onChange }: CanonEditorProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });

  // Memoised because `?? []` builds a NEW array whenever canon is absent, and
  // three useCallbacks below depend on these. A fresh array each render made
  // every one of those callbacks a new function each render, which defeats the
  // memoisation they were written for.
  const entries = useMemo(() => canon?.entries ?? [], [canon?.entries]);
  const authority = useMemo(() => canon?.authority ?? [], [canon?.authority]);

  /* ---- Start editing ---- */
  const startEdit = useCallback((entry: CanonEntry) => {
    setEditingKey(entry.key);
    setEditText(entry.text);
  }, []);

  /* ---- Save edit ---- */
  const saveEdit = useCallback(() => {
    if (!editingKey) return;
    const updated = entries.map((e) =>
      e.key === editingKey
        ? { ...e, text: editText, updated_at: new Date().toISOString() }
        : e
    );
    onChange({ authority, entries: updated });
    setEditingKey(null);
    setEditText("");
  }, [editingKey, editText, entries, authority, onChange]);

  /* ---- Cancel edit ---- */
  const cancelEdit = useCallback(() => {
    setEditingKey(null);
    setEditText("");
  }, []);

  /* ---- Delete entry ---- */
  const deleteEntry = useCallback(
    (key: string) => {
      const filtered = entries.filter((e) => e.key !== key);
      onChange({ authority, entries: filtered });
      if (editingKey === key) {
        setEditingKey(null);
        setEditText("");
      }
    },
    [entries, authority, onChange, editingKey]
  );

  /* ---- Add entry ---- */
  const addEntry = useCallback(() => {
    if (!form.key.trim() || !form.text.trim()) return;
    const newEntry: CanonEntry = {
      key: form.key.trim().toLowerCase().replace(/\s+/g, "-"),
      text: form.text.trim(),
      updated_at: new Date().toISOString(),
    };
    onChange({ authority, entries: [...entries, newEntry] });
    setForm({ ...BLANK_FORM });
    setShowAddForm(false);
  }, [form, entries, authority, onChange]);

  return (
    <div className={styles.canonSection}>
      {/* ---- Header ---- */}
      <div className={styles.canonHeader}>
        <div className={styles.canonTitleRow}>
          <span className={styles.canonIcon}>📜</span>
          <h2 className={styles.canonTitle}>Canon</h2>
          <span className={styles.canonBadge}>Authoritative</span>
        </div>
      </div>

      {/* ---- Authority list ---- */}
      {authority.length > 0 && (
        <div className={styles.authoritySection}>
          <div className={styles.authorityLabel}>Authority</div>
          <div className={styles.authorityChips}>
            {authority.map((auth) => (
              <span key={auth} className={styles.authorityChip}>
                <span className={styles.authorityIcon}>🔑</span>
                {auth}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ---- Entry list ---- */}
      <div className={styles.entryList}>
        {entries.length === 0 && (
          <div className={styles.empty}>No canon entries — add authoritative project facts</div>
        )}
        {entries.map((entry) => {
          const isEditing = editingKey === entry.key;
          return (
            <div key={entry.key} className={styles.entry}>
              <div className={styles.entryHeader}>
                <span className={styles.entryKey}>{entry.key}</span>
                {!isEditing && (
                  <span
                    className={styles.entryText}
                    onClick={() => startEdit(entry)}
                    title="Click to edit"
                  >
                    {entry.text}
                  </span>
                )}
                <div className={styles.entryMeta}>
                  {entry.updated_by && (
                    <span className={styles.entryAuthor}>{entry.updated_by}</span>
                  )}
                  {entry.updated_at && (
                    <span className={styles.entryDate}>
                      {new Date(entry.updated_at).toLocaleDateString()}
                    </span>
                  )}
                  <button
                    className={styles.deleteEntryBtn}
                    onClick={() => deleteEntry(entry.key)}
                    title="Remove entry"
                    type="button"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Inline edit */}
              {isEditing && (
                <div className={styles.editRow}>
                  <textarea
                    className={styles.editTextarea}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={3}
                    autoFocus
                  />
                  <div className={styles.editActions}>
                    <button className={styles.editSaveBtn} onClick={saveEdit} type="button">
                      Save
                    </button>
                    <button className={styles.editCancelBtn} onClick={cancelEdit} type="button">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- Add form ---- */}
      {showAddForm ? (
        <div className={styles.addForm}>
          <div className={styles.addFormTitle}>Add Canon Entry</div>
          <div className={styles.addGrid}>
            <label className={styles.addLabel}>Key</label>
            <input
              className={styles.addInput}
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              placeholder="e.g. website-architecture"
            />

            <label className={styles.addLabel}>Text</label>
            <textarea
              className={styles.addTextarea}
              value={form.text}
              onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
              rows={3}
              placeholder="Authoritative project fact…"
            />
          </div>
          <div className={styles.addActions}>
            <button
              className={styles.addCancelBtn}
              onClick={() => { setShowAddForm(false); setForm({ ...BLANK_FORM }); }}
              type="button"
            >
              Cancel
            </button>
            <button
              className={styles.addConfirmBtn}
              onClick={addEntry}
              disabled={!form.key.trim() || !form.text.trim()}
              type="button"
            >
              Add Entry
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.addBtn} onClick={() => setShowAddForm(true)} type="button">
          + Add canon entry
        </button>
      )}
    </div>
  );
}
