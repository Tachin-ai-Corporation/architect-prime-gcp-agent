import { NextRequest, NextResponse } from "next/server";
import { fleetCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/dismiss — Remove agent from fleet list
 *
 * Deletes the Firestore fleet document entirely.
 * Called when user confirms cleanup is done (or skips).
 *
 * Body: { name }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const fleetRef = fleetCol(id).doc(name);
    const fleetDoc = await fleetRef.get();

    if (!fleetDoc.exists) {
      return NextResponse.json({ success: true, message: "Already removed" });
    }

    // Delete the document
    await fleetRef.delete();

    return NextResponse.json({ success: true, message: `Agent ${name} dismissed` });
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/dismiss] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to dismiss agent" },
      { status: 500 }
    );
  }
}
