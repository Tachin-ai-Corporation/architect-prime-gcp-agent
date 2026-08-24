"use client";

/**
 * Fleet observability panel — what every agent is actually running, and the
 * releases that define them.
 *
 * Answers, for a release: what changed, why, who authored it, where it is active,
 * how it performed, what approval occurred, and how to undo it — plus a coordinates
 * table of what every agent across the whole fleet is running (C-32).
 *
 * Two design rules carry meaning here, not taste:
 *  - An unknown must not look like good news. `release-view.ts` returns every
 *    answer as either a value or an explicit reason it cannot be given, rendered
 *    differently on purpose — twice in this program a confident blank was wrong.
 *  - The wall of releases is mostly drafts that run nowhere. Surfacing them all
 *    equally is what made this view unreadable, so releases an agent actually
 *    runs (active/canary/assigned) are shown, and unassigned drafts collapse
 *    behind a count — present, but not pretending to be live state.
 *
 * Fleet-wide by construction: it reads `/api/fleet/coordinates` (all Primes) so
 * the table matches the node graph rather than one auto-selected Prime.
 */

import { useEffect, useMemo, useState } from "react";
import type { AgentCoordinates } from "@/lib/coordinates";
import type { ReleaseAnswers, ReleaseRecord, Answer } from "@/lib/release-view";
import styles from "./FleetStudioPanel.module.css";

interface ReleaseDetail {
  release: ReleaseRecord;
  answers: ReleaseAnswers;
  unanswered: string[];
}

type FleetCoordinate = AgentCoordinates & { prime?: string };
interface DriftSummary {
  total: number;
  managed: number;
  counts: Record<string, number>;
  allConverged: boolean;
}

const DRIFT_LABEL: Record<string, string> = {
  converged: "Running as assigned",
  pending: "Not applied yet",
  failed: "Failed",
  unmanaged: "Foundation defaults",
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

export function FleetStudioPanel() {
  const [coords, setCoords] = useState<FleetCoordinate[] | null>(null);
  const [summary, setSummary] = useState<DriftSummary | null>(null);
  const [releases, setReleases] = useState<ReleaseRecord[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDrafts, setShowDrafts] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(`/api/fleet/coordinates`).then((r) => r.json()),
      fetch(`/api/fleet/releases`).then((r) => r.json()),
    ])
      .then(([c, r]) => {
        if (!live) return;
        setCoords(c.agents ?? []);
        setSummary(c.summary ?? null);
        setReleases(r.releases ?? []);
      })
      .catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, []);

  // Which releases an agent actually references — the ones that are real state
  // rather than an unapplied draft. Derived from the coordinates, not the release
  // status field (a release can be "pending" globally yet be an agent's live one).
  const inUse = useMemo(() => {
    const s = new Set<string>();
    for (const c of coords ?? []) {
      if (c.fleetRelease.actual) s.add(c.fleetRelease.actual);
      if (c.fleetRelease.desired) s.add(c.fleetRelease.desired);
    }
    return s;
  }, [coords]);

  const { surfaced, drafts } = useMemo(() => {
    const surfaced: ReleaseRecord[] = [];
    const drafts: ReleaseRecord[] = [];
    for (const r of releases ?? []) {
      if (r.status === "active" || r.status === "canary" || inUse.has(r.id)) surfaced.push(r);
      else drafts.push(r);
    }
    return { surfaced, drafts };
  }, [releases, inUse]);

  // Default the drill-down to a release that means something — the active one,
  // else the first surfaced — never a random newest draft (which answers nothing).
  useEffect(() => {
    if (selected || !releases || releases.length === 0) return;
    const active = releases.find((r) => r.status === "active");
    setSelected(active?.id ?? surfaced[0]?.id ?? releases[0]?.id ?? null);
  }, [releases, surfaced, selected]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
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

  const statusCount = (s: string) => (releases ?? []).filter((r) => r.status === s).length;

  const renderChip = (r: ReleaseRecord, dim = false) => (
    <button
      key={r.id}
      className={`${styles.releaseChip} ${selected === r.id ? styles.chipActive : ""} ${dim ? styles.chipDraft : ""}`}
      onClick={() => setSelected(r.id)}
    >
      <span className={styles.mono}>{r.id}</span>
      <span className={styles.chipStatus}>{inUse.has(r.id) && r.status !== "active" ? "in use" : r.status ?? "unknown"}</span>
    </button>
  );

  return (
    <>
      {error && <p className={styles.error}>Could not load fleet state: {error}</p>}

      {/* ---- What every agent is actually running (C-32) ---- */}
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>What each agent is running</h2>
        <p className={styles.panelIntro}>
          The ground truth beneath the graph — the Foundation build and Fleet release each agent
          is actually on. A release governs an agent&apos;s skills and soul; agents with no release
          run the Foundation defaults installed by their manifest.
        </p>
        {summary && coords && coords.length > 0 && (
          <p className={styles.lede}>
            {summary.total} agent{summary.total !== 1 ? "s" : ""} · {summary.managed} release-managed
            {summary.managed > 0 && (
              <> ({summary.counts.converged ?? 0} converged
                {summary.counts.pending ? `, ${summary.counts.pending} applying` : ""}
                {summary.counts.failed ? `, ${summary.counts.failed} failed` : ""})</>
            )}
            {" · "}{summary.counts.unmanaged ?? 0} on Foundation defaults
          </p>
        )}
        {!coords && <p className={styles.muted}>Loading…</p>}
        {coords?.length === 0 && <p className={styles.muted}>No agents in this fleet.</p>}
        {coords && coords.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Agent</th><th>Prime</th><th>Foundation</th><th>Fleet release</th><th>Spec digest</th><th>State</th>
                </tr>
              </thead>
              <tbody>
                {coords.map((c) => (
                  <tr key={`${c.prime ?? ""}-${c.agent}`}>
                    <td className={styles.mono}>{c.agent}</td>
                    <td className={styles.dim}>{c.prime ?? <span className={styles.none}>—</span>}</td>
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

      {/* ---- Releases — one drill-down for a selected release ---- */}
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Releases</h2>
        <p className={styles.panelIntro}>
          A Fleet release is a validated bundle of skill/soul/playbook changes a Prime authored.
          Shown here are the ones actually in use; unassigned drafts (authored but running nowhere)
          are collapsed below.
        </p>
        {!releases && <p className={styles.muted}>Loading…</p>}
        {releases?.length === 0 && <p className={styles.muted}>No releases yet.</p>}

        {releases && releases.length > 0 && (
          <>
            <p className={styles.lede}>
              {statusCount("active")} active · {statusCount("canary")} canary · {drafts.length} unassigned draft{drafts.length !== 1 ? "s" : ""}
            </p>

            <div className={styles.releaseRow}>
              {surfaced.length > 0
                ? surfaced.map((r) => renderChip(r))
                : <span className={styles.muted}>No active or in-use releases — everything below is an unapplied draft.</span>}
            </div>

            {drafts.length > 0 && (
              <div className={styles.draftsBlock}>
                <button className={styles.draftsToggle} onClick={() => setShowDrafts((v) => !v)}>
                  {showDrafts ? "▾ Hide" : "▸ Show"} {drafts.length} unassigned draft{drafts.length !== 1 ? "s" : ""}
                </button>
                {showDrafts && <div className={styles.releaseRow}>{drafts.map((r) => renderChip(r, true))}</div>}
              </div>
            )}
          </>
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
