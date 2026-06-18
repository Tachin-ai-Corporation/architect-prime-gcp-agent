"use client";

import React, { useCallback } from "react";
import type { ParamDef } from "./types";
import styles from "@/app/p/[id]/processes/page.module.css";

interface ParamEditorProps {
  isEditing: boolean;
  parameters: ParamDef[];
  onChange?: (parameters: ParamDef[]) => void;
}

export function ParamEditor({ isEditing, parameters, onChange }: ParamEditorProps) {
  const updateParam = useCallback((index: number, field: keyof ParamDef, value: string) => {
    if (!onChange) return;
    onChange(parameters.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }, [parameters, onChange]);

  const removeParam = useCallback((index: number) => {
    if (!onChange) return;
    onChange(parameters.filter((_, i) => i !== index));
  }, [parameters, onChange]);

  const addParam = useCallback(() => {
    if (!onChange) return;
    onChange([...parameters, { key: "", type: "string", default: "", description: "" }]);
  }, [parameters, onChange]);

  if (isEditing) {
    return (
      <div className={styles.paramBuilder}>
        {parameters.map((p, i) => (
          <div key={i} className={styles.paramBuilderRow}>
            <input
              className={styles.fieldInput}
              value={p.key}
              onChange={(e) => updateParam(i, "key", e.target.value)}
              placeholder="Key"
            />
            <select
              className={styles.fieldSelect}
              value={p.type}
              onChange={(e) => updateParam(i, "type", e.target.value)}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="array">array</option>
              <option value="object">object</option>
            </select>
            <input
              className={styles.fieldInput}
              value={p.default}
              onChange={(e) => updateParam(i, "default", e.target.value)}
              placeholder="Default"
            />
            <input
              className={styles.fieldInput}
              value={p.description}
              onChange={(e) => updateParam(i, "description", e.target.value)}
              placeholder="Description"
            />
            <button className={styles.removeParamBtn} onClick={() => removeParam(i)} type="button">
              ✕
            </button>
          </div>
        ))}
        <button className={styles.addStepBtn} onClick={addParam} type="button">
          + Add Parameter
        </button>
      </div>
    );
  }

  if (parameters.length > 0) {
    return (
      <table className={styles.paramTable}>
        <thead>
          <tr>
            <th>Key</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {parameters.map((param) => (
            <tr key={param.key}>
              <td>
                <span className={styles.paramKey}>{param.key}</span>
              </td>
              <td>
                <span className={styles.paramType}>{param.type}</span>
              </td>
              <td>{param.default || "—"}</td>
              <td>{param.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return <div className={styles.emptySection}>No parameters defined</div>;
}
