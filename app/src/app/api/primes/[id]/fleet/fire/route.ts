import { NextRequest, NextResponse } from "next/server";
import { commandsCol, fleetCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/fire — Fire a fleet agent
 *
 * Writes a fleet_teardown command to the commands collection.
 * The command-runner daemon on the Prime VM host picks it up
 * and runs fleet-teardown deterministically.
 *
 * Also immediately sets fleet doc status to "tearing_down"
 * for instant dashboard feedback.
 *
 * Body: { name }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    // Update fleet doc status immediately for instant UI feedback
    const fleetRef = fleetCol(id).doc(name);
    const fleetDoc = await fleetRef.get();
    if (fleetDoc.exists) {
      await fleetRef.update({ status: "tearing_down" });
    }

    // Dedup: skip if there's already a pending/running teardown for this agent
    const existing = await commandsCol(id)
      .where("type", "==", "fleet_teardown")
      .where("args.name", "==", name)
      .where("status", "in", ["pending", "running"])
      .limit(1)
      .get();

    if (!existing.empty) {
      return NextResponse.json(
        { id: existing.docs[0].id, command: "fleet_teardown", agent: name, deduplicated: true },
        { status: 200 }
      );
    }

    // Write command to queue
    const cmdRef = commandsCol(id).doc();
    await cmdRef.set({
      type: "fleet_teardown",
      args: { name },
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json(
      { id: cmdRef.id, command: "fleet_teardown", agent: name },
      { status: 201 }
    );
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/fire] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to send fire command" },
      { status: 500 }
    );
  }
}
