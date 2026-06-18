"use client";

import { useState } from "react";
import styles from "./VerdictCard.module.css";

/* ---- Types ---- */

interface VerdictCheck {
  criterion: string;
  pass: boolean;
  evidence: string;
}

interface ParsedVerdict {
  type: "PASS" | "FAIL";
  reasoning: string;
  checks: VerdictCheck[];
  recommendation?: string;
}

/* ---- Parser ---- */

/**
 * Parse cerebellum tool output for report_pass/report_fail tool calls.
 * The output format contains [TOOL EXECUTION LOG] blocks with
 * [TOOL] report_pass({...}) or [TOOL] report_fail({...}) entries.
 */
export function parseVerdict(output: string | null): ParsedVerdict | null {
  if (!output) return null;

  // Look for tool call patterns
  const passMatch = output.match(/\[TOOL\]\s*report_pass\((\{[\s\S]*?\})\)/);
  const failMatch = output.match(/\[TOOL\]\s*report_fail\((\{[\s\S]*?\})\)/);

  const match = failMatch || passMatch;
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);
    return {
      type: failMatch ? "FAIL" : "PASS",
      reasoning: data.reasoning || "",
      checks: Array.isArray(data.checks)
        ? data.checks.map((c: Record<string, unknown>) => ({
            criterion: String(c.criterion || ""),
            pass: Boolean(c.pass),
            evidence: String(c.evidence || ""),
          }))
        : [],
      recommendation: data.recommendation || undefined,
    };
  } catch {
    return null;
  }
}

/* ---- Component ---- */

interface VerdictCardProps {
  output: string;
}

export function VerdictCard({ output }: VerdictCardProps) {
  const verdict = parseVerdict(output);
  const [expanded, setExpanded] = useState(false);

  if (!verdict) return null;

  const passed = verdict.checks.filter((c) => c.pass).length;
  const total = verdict.checks.length;

  return (
    <div className={`${styles.card} ${verdict.type === "PASS" ? styles.cardPass : styles.cardFail}`}>
      <div className={styles.header} onClick={() => setExpanded(!expanded)}>
        <span className={styles.badge}>
          {verdict.type === "PASS" ? "✅ PASS" : "❌ FAIL"}
        </span>
        <span className={styles.score}>
          {passed}/{total} checks passed
        </span>
        <span className={styles.toggle}>{expanded ? "▾" : "▸"}</span>
      </div>

      {verdict.reasoning && (
        <div className={styles.reasoning}>{verdict.reasoning}</div>
      )}

      {expanded && (
        <>
          <table className={styles.checksTable}>
            <thead>
              <tr>
                <th className={styles.thStatus}></th>
                <th>Criterion</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {verdict.checks.map((check, i) => (
                <tr key={i} className={check.pass ? styles.rowPass : styles.rowFail}>
                  <td className={styles.tdStatus}>
                    {check.pass ? "✓" : "✗"}
                  </td>
                  <td>{check.criterion}</td>
                  <td className={styles.evidence}>{check.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {verdict.recommendation && (
            <div className={styles.recommendation}>
              <strong>Recommendation:</strong> {verdict.recommendation}
            </div>
          )}
        </>
      )}
    </div>
  );
}
