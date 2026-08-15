import { NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";
import { deriveCoordinates, type AssignmentRecord } from "@/lib/coordinates";
import {
  answerOperatorQuestions, unanswered,
  type ReleaseRecord, type ChangeRecord,
} from "@/lib/release-view";

/**
 * GET /api/fleet/releases            every release, newest first
 * GET /api/fleet/releases?id=fr-…    one release, with the seven answers
 *
 * The operator's questions about a release — what changed, why, who authored it,
 * where it is active, how it performed, what approval occurred, how to undo it —
 * answered from the deployment's own records, with `unanswered` naming whatever
 * the evidence does not cover.
 *
 * Read-only. Definitions become live through the registry (`fleet-config`),
 * where a change is sealed, validated and released rather than saved;
 * `test/boundaries.test.mjs` enforces that this route never writes `fleet_*`.
 */
export async function GET(req: Request) {
  try {
    const db = getDb();
    const id = new URL(req.url).searchParams.get("id");

    if (!id) {
      const snap = await db.collection("fleet_releases").get();
      const releases = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }) as ReleaseRecord)
        .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
      return NextResponse.json({ releases });
    }

    const doc = await db.collection("fleet_releases").doc(id).get();
    if (!doc.exists) {
      return NextResponse.json({ error: `unknown release '${id}'` }, { status: 404 });
    }
    const release = { id: doc.id, ...doc.data() } as ReleaseRecord;

    // Fetch each named change individually rather than filtering a listing: a
    // change the release names but that cannot be read must surface as missing,
    // and a listing quietly omits it.
    const changes = (
      await Promise.all(
        (release.change_ids ?? []).map(async (cid) => {
          const c = await db.collection("fleet_changes").doc(cid).get();
          return c.exists ? ({ id: c.id, ...c.data() } as ChangeRecord) : null;
        }),
      )
    ).filter((c): c is ChangeRecord => c !== null);

    const assignments = await db.collection("fleet_assignments").get();
    const coordinates = assignments.docs.map((d) =>
      deriveCoordinates(d.id, { id: d.id, ...d.data() } as AssignmentRecord, null),
    );

    // Performance comes from the rollout gate, which runs on a Prime rather than
    // here. Absent evidence is reported as absent — never as zeros, which would
    // read as "totally broken" rather than "never measured".
    const evalSnap = await db
      .collection("fleet_evaluations")
      .where("release_id", "==", id)
      .get()
      .catch(() => null);
    const performance = evalSnap && !evalSnap.empty
      ? (evalSnap.docs[0].data().candidate ?? null)
      : null;

    const answers = answerOperatorQuestions(release, changes, coordinates, performance);
    return NextResponse.json({ release, changes, answers, unanswered: unanswered(answers) });
  } catch (err) {
    console.error("[api/fleet/releases] GET error:", err);
    return NextResponse.json({ error: "Failed to read releases" }, { status: 500 });
  }
}
