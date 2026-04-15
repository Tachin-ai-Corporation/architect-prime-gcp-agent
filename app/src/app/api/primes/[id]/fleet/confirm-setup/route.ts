import { NextRequest, NextResponse } from "next/server";
import { fleetCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/confirm-setup — Confirm Workspace user setup
 *
 * Clears the actionRequired field from the fleet doc so the
 * admin action card disappears. If the agent is already online,
 * returns immediately. If not, returns the current status so the
 * UI can show an appropriate message.
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
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const currentStatus = fleetDoc.data()?.status;

    // Clear actionRequired regardless of status — user confirmed they did it
    await fleetRef.update({
      actionRequired: FieldValue.delete(),
    });

    if (currentStatus === "online") {
      return NextResponse.json({ success: true, status: "online" });
    }

    // Agent not yet online — user confirmed but DWD may still be propagating
    return NextResponse.json({
      success: true,
      status: currentStatus,
      message: "Setup confirmed. The agent will come online once the Workspace user propagates.",
    });
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/confirm-setup] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to confirm setup" },
      { status: 500 }
    );
  }
}
