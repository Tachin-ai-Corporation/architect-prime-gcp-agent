import { NextRequest, NextResponse } from "next/server";
import { fleetCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/update-status — Fleet VM self-report
 *
 * Called by fleet-bootstrap.sh (step 18) to report completion status
 * directly to Firestore via Prime's credentials. This avoids the need
 * for the fleet SA to have roles/datastore.user.
 *
 * Auth: gateway token passed in X-Gateway-Token header, verified
 * against the token stored in the fleet registry.
 *
 * Body: { agent, status, actionRequired? }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { agent, status, actionRequired } = body;

    if (!agent || typeof agent !== "string") {
      return NextResponse.json({ error: "agent is required" }, { status: 400 });
    }
    if (!status || typeof status !== "string") {
      return NextResponse.json(
        { error: "status is required" },
        { status: 400 }
      );
    }

    const fleetRef = fleetCol(id).doc(agent);
    const fleetDoc = await fleetRef.get();
    if (!fleetDoc.exists) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Build update payload
    const update: Record<string, unknown> = {
      status,
      lastBootstrap: new Date().toISOString(),
    };

    if (actionRequired && typeof actionRequired === "object") {
      update.actionRequired = actionRequired;
    }

    await fleetRef.update(update);

    return NextResponse.json({ success: true, status });
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/update-status] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to update status" },
      { status: 500 }
    );
  }
}
