import { NextResponse } from "next/server";
import { getDb, fleetCol } from "@/lib/firestore";
import { deriveCoordinates, summarize, type AssignmentRecord } from "@/lib/coordinates";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/fleet/coordinates
 *
 * What every agent in this Prime's fleet is actually running: the Foundation
 * commit, the Fleet release, and the digest of the content that compiled to —
 * desired and actual, side by side (C-32).
 *
 * Read straight from the deployment's own records. The dashboard's other
 * catalog views read GitHub `main`, which answers "what would a fresh install
 * get today" — a different question from "what is this fleet running", and one
 * that looks identical until they diverge.
 *
 * Read-only by construction: Fleet Definition state changes through the
 * registry (`fleet-config`), where a change is sealed, validated and released
 * rather than saved. `test/boundaries.test.mjs` enforces that.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  try {
    const db = getDb();

    // The fleet roster is per-Prime; assignments are deployment-rooted (C-1),
    // so they are matched by agent name rather than nested under the Prime.
    const [roster, assignments] = await Promise.all([
      fleetCol(id).get(),
      db.collection("fleet_assignments").get(),
    ]);

    const byAgent = new Map<string, AssignmentRecord>();
    for (const doc of assignments.docs) byAgent.set(doc.id, { id: doc.id, ...doc.data() } as AssignmentRecord);

    const agents = roster.docs
      .filter((d) => !["removed", "deleted", "decommissioned"].includes(d.data().status))
      .map((d) => {
        // `coreRef` is the commit the VM installed. STATE.json's `version` is a
        // schema counter, not a platform coordinate, and reporting it here would
        // put a small integer where a commit belongs.
        const platformVersion = (d.data().coreRef as string | undefined) ?? null;
        return deriveCoordinates(d.id, byAgent.get(d.id) ?? null, platformVersion);
      });

    return NextResponse.json({ agents, summary: summarize(agents) });
  } catch (err) {
    console.error(`[api/primes/${id}/fleet/coordinates] GET error:`, err);
    return NextResponse.json({ error: "Failed to read fleet coordinates" }, { status: 500 });
  }
}
