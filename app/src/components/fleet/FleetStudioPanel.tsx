"use client";

/**
 * Fleet Studio panel — fleet-wide release/provenance/drift observability.
 *
 * Answers, for a release: what changed, why, who authored it, where it is active,
 * how it performed, what approval occurred, and how to undo it — plus a coordinates
 * table of what every agent is actually running (C-32).
 *
 * The design rule that matters more than any layout choice: an unknown must not
 * look like good news. `release-view.ts` returns every answer as either a value or
 * an explicit reason it cannot be given, and this renders those two states
 * differently on purpose — a blank cell reads as "fine", and twice in this program
 * a confident blank has been wrong.
 *
 * Extracted from the standalone /p/[id]/studio route so the Home can surface it as
 * the fleet observability view (its former home was orphaned — nothing linked to it).
 */

import { useEffect, useState } from "react";
import type { AgentCoordinates } from "@/lib/coordinates";
import type { ReleaseAnswers, ReleaseRecord, Answer } from "@/lib/release-view";
import styles from "./FleetStudioPanel.module.css";

interface ReleaseDetail {
  release: ReleaseRecord;
  answers: ReleaseAnswers;
  unanswered: string[];
}

const DRIFT_LABEL: Record<string, string> = {
  converged: "Running as assigned",
  pending: "Not applied yet",
  failed: "Failed",
  unmanaged: "Not managed",
  unknown: "Unconfirmed",
};

/** Renders an answer, or the reason there isn't one — never an empty cell. */
function Answered<T>({ answer, children }: { answer: Answer<T>; children: (value: T) => React.ReactNode }) {
  if (!answer.known) {
    return <p className={styles.unknown}><span className={styles.unknownTag}>unknown</span>{answer.why}</p>;
  }
  return <>{children(answer.value)}</>;
}

function Question({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className={styles.question}>
      <h3 className={styles.questionLabel}>{label}</h3>
      <div className={styles.questionBody}>{children}</div>
    </section>
  );
}

export function FleetStudioPanel({ primeId }: { primeId: string }) {
  const [coords, setCoords] = useState<AgentCoordinates[] | null>(null);
  const [releases, setReleases] = useState<ReleaseRecord[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(`/api/primes/${primeId}/fleet/coordinates`).then((r) => r.json()),
      fetch(`/api/fleet/releases`).then((r) => r.json()),
    ])
      .then(([c, r]) => {
        if (!live) return;
        setCoords(c.agents ?? []);
        setReleases(r.releases ?? []);
        setSelected((prev) => prev ?? r.releases?.[0]?.id ?? null);
      })
      .catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [primeId]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    // Wrapped so the clear is not in the effect body itself. It still runs in the
    // same tick, before the request, so switching releases blanks the panel
    // immediately rather than showing the previous one's answers while loading.
    void (async () => {
      setDetail(null);
      try {
        const r = await fetch(`/api/fleet/releases?id=${encodeURIComponent(selected)}`);
        const d = await r.json();
        if (live) setDetail(d.answers ? d : null);
      } catch {
        /* the panel shows its own empty state */
      }
    })();
    return () => { live = false; };
  }, [selected]);

  return (
    <>
      {error && <p className={styles.error}>Could not load fleet state: {error}</p>}

      {/* ---- What every agent is actually running (C-32) ---- */}
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>What each agent is running</h2>
        {!coords && <p className={styles.muted}>Loading…</p>}
        {coords?.length === 0 && <p className={styles.muted}>No agents in this fleet.</p>}
        {coords && coords.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Agent</th><th>Foundation</th><th>Fleet release</th><th>Spec digest</th><th>State</th>
                </tr>
              </thead>
              <tbody>
                {coords.map((c) => (
                  <tr key={c.agent}>
                    <td className={styles.mono}>{c.agent}</td>
                    <td className={styles.mono}>{c.platformVersion?.slice(0, 12) ?? <span className={styles.none}>none</span>}</td>
                    <td className={styles.mono}>
                      {c.fleetRelease.actual ?? <span className={styles.none}>none</span>}
                      {c.fleetRelease.desired !== c.fleetRelease.actual && (
                        <span className={styles.desired}> → {c.fleetRelease.desired ?? "none"}</span>
                      )}
                    </td>
                    <td className={styles.mono}>
                      {c.agentSpecDigest.actual
                        ? `${c.agentSpecDigest.actual.slice(0, 19)}…`
                        : <span className={styles.none}>unattested</span>}
                    </td>
                    <td>
                      <span className={`${styles.badge} ${styles[c.drift] ?? ""}`}>{DRIFT_LABEL[c.drift] ?? c.drift}</span>
                      <span className={styles.explain}>{c.explanation}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- The seven questions, for one release ---- */}
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Releases</h2>
        {!releases && <p className={styles.muted}>Loading…</p>}
        {releases?.length === 0 && <p className={styles.muted}>No releases yet.</p>}

        {releases && releases.length > 0 && (
          <div className={styles.releaseRow}>
            {releases.map((r) => (
              <button
                key={r.id}
                className={`${styles.releaseChip} ${selected === r.id ? styles.chipActive : ""}`}
                onClick={() => setSelected(r.id)}
              >
                <span className={styles.mono}>{r.id}</span>
                <span className={styles.chipStatus}>{r.status ?? "unknown"}</span>
              </button>
            ))}
          </div>
        )}

        {selected && !detail && <p className={styles.muted}>Loading {selected}…</p>}

        {detail && (
          <div className={styles.answers}>
            {detail.unanswered.length > 0 && (
              <p className={styles.gapSummary}>
                {detail.unanswered.length} of 7 questions cannot be answered from the record:{" "}
                <strong>{detail.unanswered.join(", ")}</strong>
              </p>
            )}

            <Question label="What changed">
              <Answered answer={detail.answers.whatChanged}>
                {(changes) => (
                  <ul className={styles.list}>
                    {changes.flatMap((c) => c.entries.map((e, i) => <li key={`${c.change}-${i}`}>{e}</li>))}
                  </ul>
                )}
              </Answered>
            </Question>

            <Question label="Why">
              <Answered answer={detail.answers.why}>
                {(reasons) => <>{reasons.map((r) => <p key={r.change} className={styles.rationale}>{r.rationale}</p>)}</>}
              </Answered>
            </Question>

            <Question label="Who authored it">
              <Answered answer={detail.answers.whoAuthored}>
                {(authors) => <p className={styles.mono}>{authors.join(", ")}</p>}
              </Answered>
            </Question>

            <Question label="Where it is active">
              <Answered answer={detail.answers.whereActive}>
                {(where) => (
                  <>
                    <p><span className={styles.mono}>{where.converged.join(", ") || "none"}</span> running it</p>
                    {where.notConverged.length > 0 && (
                      <p className={styles.warn}>
                        <span className={styles.mono}>{where.notConverged.join(", ")}</span> assigned but not running it
                      </p>
                    )}
                  </>
                )}
              </Answered>
            </Question>

            <Question label="How it performed">
              <Answered answer={detail.answers.howItPerformed}>
                {(p) => (
                  <p>
                    {p.missions_finished} finished · {Math.round((p.completion_rate ?? 0) * 100)}% completed
                    {p.decision?.action ? ` · gate says ${p.decision.action}` : ""}
                  </p>
                )}
              </Answered>
            </Question>

            <Question label="What approval occurred">
              <Answered answer={detail.answers.whatApproval}>
                {(a) => <p>Approved by <span className={styles.mono}>{a.approvedBy}</span>{a.approvedAt ? ` on ${a.approvedAt}` : ""}</p>}
              </Answered>
            </Question>

            <Question label="How to undo it">
              <Answered answer={detail.answers.howToUndo}>
                {(u) => (
                  <>
                    <p>Rolls back to <span className={styles.mono}>{u.rollbackTo}</span></p>
                    <code className={styles.command}>{u.command}</code>
                  </>
                )}
              </Answered>
            </Question>
          </div>
        )}
      </section>
    </>
  );
}
