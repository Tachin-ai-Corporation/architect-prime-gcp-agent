"use client";

import React, { useCallback } from "react";
import type { StepDef } from "./types";
import styles from "@/app/p/[id]/processes/page.module.css";

const STEP_TYPES: StepDef["type"][] = ["standard", "delegation", "spawn_responsibility", "approval_gate"];

const TYPE_ICONS: Record<StepDef["type"], string> = {
  standard: "⚡",
  delegation: "🔀",
  spawn_responsibility: "🔄",
  approval_gate: "✅",
};

const TYPE_CLASSES: Record<StepDef["type"], string> = {
  standard: styles.typeStandard,
  delegation: styles.typeDelegation,
  spawn_responsibility: styles.typeSpawn,
  approval_gate: styles.typeApproval,
};

interface StepEditorProps {
  isEditing: boolean;
  steps: StepDef[];
  onChange?: (steps: StepDef[]) => void;
}

export function StepEditor({ isEditing, steps, onChange }: StepEditorProps) {
  const updateStep = useCallback((index: number, field: keyof StepDef, value: string | boolean) => {
    if (!onChange) return;
    onChange(steps.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }, [steps, onChange]);

  const removeStep = useCallback((index: number) => {
    if (!onChange) return;
    onChange(steps.filter((_, i) => i !== index));
  }, [steps, onChange]);

  const addStep = useCallback(() => {
    if (!onChange) return;
    onChange([
      ...steps,
      { title: "", description: "", agent: "", type: "standard", optional: false, checkpointBoundary: false }
    ]);
  }, [steps, onChange]);

  const moveStep = useCallback((index: number, direction: -1 | 1) => {
    if (!onChange) return;
    const next = [...steps];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }, [steps, onChange]);

  if (isEditing) {
    return (
      <div className={styles.stepBuilder}>
        {steps.map((step, i) => (
          <div key={i} className={styles.stepBuilderItem}>
            <div className={styles.stepBuilderHeader}>
              <span className={styles.stepBuilderNum}>Step {i + 1}</span>
              <div className={styles.stepBuilderHeaderActions}>
                <button
                  className={styles.reorderBtn}
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  type="button"
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className={styles.reorderBtn}
                  onClick={() => moveStep(i, 1)}
                  disabled={i === steps.length - 1}
                  type="button"
                  title="Move down"
                >
                  ↓
                </button>
                {steps.length > 1 && (
                  <button className={styles.removeStepBtn} onClick={() => removeStep(i)} type="button">
                    ✕
                  </button>
                )}
              </div>
            </div>
            <div className={styles.stepBuilderRow}>
              <input
                className={styles.fieldInput}
                value={step.title}
                onChange={(e) => updateStep(i, "title", e.target.value)}
                placeholder="Step title"
              />
              <input
                className={styles.fieldInput}
                value={step.agent}
                onChange={(e) => updateStep(i, "agent", e.target.value)}
                placeholder="Agent name"
              />
            </div>
            <input
              className={styles.fieldInput}
              value={step.description}
              onChange={(e) => updateStep(i, "description", e.target.value)}
              placeholder="Step description"
            />
            <div className={styles.stepBuilderRow}>
              <select
                className={styles.fieldSelect}
                value={step.type}
                onChange={(e) => updateStep(i, "type", e.target.value as StepDef["type"])}
              >
                {STEP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_ICONS[t]} {t.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.stepBuilderOptions}>
              <label className={styles.fieldCheckbox}>
                <input
                  type="checkbox"
                  checked={step.optional ?? false}
                  onChange={(e) => updateStep(i, "optional", e.target.checked)}
                />
                Optional
              </label>
              <label className={styles.fieldCheckbox}>
                <input
                  type="checkbox"
                  checked={step.checkpointBoundary ?? false}
                  onChange={(e) => updateStep(i, "checkpointBoundary", e.target.checked)}
                />
                Checkpoint boundary
              </label>
            </div>
          </div>
        ))}
        <button className={styles.addStepBtn} onClick={addStep} type="button">
          + Add Step
        </button>
      </div>
    );
  }

  return (
    <div className={styles.stepList}>
      {steps.map((step, i) => (
        <div key={i} className={styles.stepItem}>
          <div className={`${styles.stepDot} ${step.checkpointBoundary ? styles.stepDotCheckpoint : ""}`} />
          <div className={styles.stepNumber}>Step {i + 1}</div>
          <div className={styles.stepTitle}>
            <span>{TYPE_ICONS[step.type]}</span>
            {step.title}
          </div>
          {step.description && <div className={styles.stepDesc}>{step.description}</div>}
          <div className={styles.stepMeta}>
            <span className={`${styles.typeBadge} ${TYPE_CLASSES[step.type] || ""}`}>
              {step.type.replace("_", " ")}
            </span>
            {step.agent && <span className={styles.stepAgent}>{step.agent}</span>}
            {step.optional && <span className={styles.optionalFlag}>Optional</span>}
            {step.checkpointBoundary && <span className={styles.checkpointIndicator}>🔒 Checkpoint</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
