import { NextResponse } from "next/server";
import { getDb, primesCol } from "@/lib/firestore";
import { deriveCoordinates, summarize, type AssignmentRecord } from "@/lib/coordinates";

const DEAD = ["removed", "deleted", "decommissioned"];

/**
 * GET /api/fleet/coordinates
 *
 * The fleet-wide version of the per-Prime coordinates view: every agent across
 * every live Prime, each tagged with the Prime it belongs to, plus one drift
 * summary for the whole fleet.
 *
 * The Home fleet-observability table uses this so "what each agent is running"
 * matches the node graph — all agents — rather than only the auto-selected
 * Prime's roster, which made a two-Prime fleet look like it had one agent.
 *
 * Read-only by construction, exactly like the per-Prime route: assignments are
 * deployment-rooted and change through the registry (`fleet-config`), never here.
 */
export async function GET() {
  try {
    const db = getDb();
    const [primesSnap, assignments] = await Promise.all([
      primesCol().get(),
      db.collection("fleet_assignments").get(),
    ]);

    const byAgent = new Map<string, AssignmentRecord>();
    for (const doc of assignments.docs) byAgent.set(doc.id, { id: doc.id, ...doc.data() } as AssignmentRecord);

    const livePrimes = primesSnap.docs.filter((d) => !DEAD.includes(d.data().status));
    const rosters = await Promise.all(
      livePrimes.map(async (p) => {
        const roster = await db.collection("primes").doc(p.id).collection("fleet").get();
        return roster.docs
          .filter((d) => !DEAD.includes(d.data().status))
          .map((d) => {
            // `coreRef` is the commit the VM installed (STATE.json), not the
            // schema counter — same choice the per-Prime route makes.
            const platformVersion = (d.data().coreRef as string | undefined) ?? null;
            const coords = deriveCoordinates(d.id, byAgent.get(d.id) ?? null, platformVersion);
            return { ...coords, prime: (p.data().name as string | undefined) ?? p.id };
          });
      }),
    );

    const agents = rosters.flat();
    return NextResponse.json({ agents, summary: summarize(agents) });
  } catch (err) {
    console.error("[api/fleet/coordinates] GET error:", err);
    return NextResponse.json({ error: "Failed to read fleet coordinates" }, { status: 500 });
  }
}
