/**
 * One release, assembled into the answers an operator actually needs.
 *
 * P6's exit gate is a list of seven questions: what changed, why, who authored
 * it, where it is active, how it performed, what approval occurred, and how to
 * undo it. Encoding them as a structure rather than as a page layout means the
 * gate is testable, and means a missing answer has to say so.
 *
 * That last part is the whole design. Every field is either an answer or an
 * explicit `unknown` with a reason. A dashboard that renders a blank where it
 * has no evidence is indistinguishable from one reporting good news, and this
 * program has already been bitten twice by exactly that shape — a gate that
 * said "0 missions" when it meant "I looked somewhere else", and an assignment
 * that said "converged" about a file that had been reverted underneath it.
 */

import type { AgentCoordinates } from './coordinates';

export type Answer<T> = { known: true; value: T } | { known: false; why: string };

const known = <T>(value: T): Answer<T> => ({ known: true, value });
const unknown = <T>(why: string): Answer<T> => ({ known: false, why });

export interface DiffEntry {
  kind?: string;
  id?: string;
  summary?: string;
}

export interface ChangeRecord {
  id: string;
  title?: string;
  rationale?: string;
  author?: string;
  created_at?: string;
  status?: string;
  risk?: 'low' | 'medium' | 'high';
  diff?: DiffEntry[];
  revisions?: Array<{ kind: string; id: string; revision: string }>;
  validation?: { at: string; passed: boolean; errors?: string[]; checks?: string[] } | null;
}

export interface ReleaseRecord {
  id: string;
  created_at?: string;
  created_by?: string;
  change_ids?: string[];
  digest?: string;
  parent_release?: string | null;
  status?: string;
  content_ref?: { repo: string; branch: string; commit: string };
  evidence?: {
    validated?: boolean;
    evaluation_ids?: string[];
    approved_by?: string | null;
    approved_at?: string | null;
  };
}

/** Metrics as `fleet-config observe` derives them; null when never evaluated. */
export interface PerformanceRecord {
  missions_finished?: number | null;
  completion_rate?: number | null;
  false_complete_rate?: number | null;
  decision?: { action?: string; reason?: string } | null;
}

export interface ReleaseAnswers {
  release: string;
  status: string;
  whatChanged: Answer<Array<{ change: string; entries: string[] }>>;
  why: Answer<Array<{ change: string; rationale: string }>>;
  whoAuthored: Answer<string[]>;
  whereActive: Answer<{ agents: string[]; converged: string[]; notConverged: string[] }>;
  howItPerformed: Answer<PerformanceRecord>;
  whatApproval: Answer<{ approvedBy: string; approvedAt: string | null }>;
  howToUndo: Answer<{ rollbackTo: string; command: string }>;
}

/**
 * Assemble the answers for one release.
 *
 * @param release      the release record
 * @param changes      the changes it carries (may be partial — say so if so)
 * @param coordinates  every agent's coordinates, from deriveCoordinates
 * @param performance  observed metrics, or null if the gate has never run
 */
export function answerOperatorQuestions(
  release: ReleaseRecord,
  changes: ChangeRecord[],
  coordinates: AgentCoordinates[],
  performance: PerformanceRecord | null,
): ReleaseAnswers {
  const changeIds = release.change_ids ?? [];
  const found = new Set(changes.map((c) => c.id));
  const missing = changeIds.filter((id) => !found.has(id));

  // ---- What changed ----
  let whatChanged: ReleaseAnswers['whatChanged'];
  if (!changes.length) {
    whatChanged = unknown(
      changeIds.length
        ? `the release names ${changeIds.length} change(s) but none could be read`
        : 'the release names no changes',
    );
  } else {
    const entries = changes.map((c) => ({
      change: c.id,
      entries: (c.diff ?? []).map((d) => d.summary ?? `${d.kind ?? 'definition'} ${d.id ?? ''}`.trim())
        // A change with revisions but no rendered diff still changed something;
        // saying "no changes" there would be a lie of omission.
        .concat((c.diff ?? []).length === 0 && (c.revisions ?? []).length
          ? (c.revisions ?? []).map((r) => `${r.kind} '${r.id}' → ${r.revision}`)
          : []),
    }));
    whatChanged = missing.length
      ? { known: true, value: entries } // partial, flagged through `why` below
      : known(entries);
  }

  // ---- Why ----
  const rationales = changes
    .filter((c) => c.rationale)
    .map((c) => ({ change: c.id, rationale: c.rationale as string }));
  const why: ReleaseAnswers['why'] = rationales.length
    ? known(rationales)
    : unknown(
        missing.length
          ? `${missing.length} change record(s) could not be read: ${missing.join(', ')}`
          : 'no change carries a rationale',
      );

  // ---- Who authored it ----
  const authors = [...new Set(changes.map((c) => c.author).filter((a): a is string => Boolean(a)))];
  const whoAuthored: ReleaseAnswers['whoAuthored'] = authors.length
    ? known(authors)
    : release.created_by
      // The release creator is who cut it, not necessarily who wrote the content.
      // Reporting it as the author would be a plausible-sounding guess.
      ? unknown(`no change records an author; the release was cut by ${release.created_by}`)
      : unknown('no author recorded');

  // ---- Where it is active ----
  const onRelease = coordinates.filter((c) => c.fleetRelease.actual === release.id || c.fleetRelease.desired === release.id);
  const whereActive: ReleaseAnswers['whereActive'] = onRelease.length
    ? known({
        agents: onRelease.map((c) => c.agent),
        converged: onRelease.filter((c) => c.drift === 'converged').map((c) => c.agent),
        notConverged: onRelease.filter((c) => c.drift !== 'converged').map((c) => c.agent),
      })
    : unknown('no agent is assigned to this release');

  // ---- How it performed ----
  const howItPerformed: ReleaseAnswers['howItPerformed'] =
    performance && (performance.missions_finished ?? 0) > 0
      ? known(performance)
      : unknown(
          performance
            ? 'no finished missions have been observed on this release yet'
            : 'the rollout gate has not been run for this release',
        );

  // ---- What approval occurred ----
  const approvedBy = release.evidence?.approved_by;
  const whatApproval: ReleaseAnswers['whatApproval'] = approvedBy
    ? known({ approvedBy, approvedAt: release.evidence?.approved_at ?? null })
    : unknown(
        release.evidence?.validated
          ? 'validated, but no human approval is recorded'
          : 'neither validation nor approval is recorded',
      );

  // ---- How to undo it ----
  const parent = release.parent_release;
  const howToUndo: ReleaseAnswers['howToUndo'] = parent
    ? known({ rollbackTo: parent, command: `fleet-config rollback ${release.id}` })
    : unknown('this release has no predecessor, so there is nothing to roll back to');

  return {
    release: release.id,
    status: release.status ?? 'unknown',
    whatChanged, why, whoAuthored, whereActive, howItPerformed, whatApproval, howToUndo,
  };
}

/** Which of the seven questions this release cannot currently answer. */
export function unanswered(a: ReleaseAnswers): string[] {
  const pairs: Array<[string, Answer<unknown>]> = [
    ['what changed', a.whatChanged],
    ['why', a.why],
    ['who authored it', a.whoAuthored],
    ['where it is active', a.whereActive],
    ['how it performed', a.howItPerformed],
    ['what approval occurred', a.whatApproval],
    ['how to undo it', a.howToUndo],
  ];
  return pairs.filter(([, ans]) => !ans.known).map(([q]) => q);
}
