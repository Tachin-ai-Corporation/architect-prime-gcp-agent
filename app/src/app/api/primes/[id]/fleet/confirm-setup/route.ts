import { NextRequest, NextResponse } from "next/server";
import { commandsCol, fleetCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/confirm-setup — Confirm Workspace user setup
 *
 * Writes a fleet_verify command to the commands collection.
 * The command-runner daemon SSH-checks DWD health on the agent VM.
 *
 * Also checks the current fleet doc status — if already "online",
 * returns success immediately without queuing a command.
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

    // Check current status — if already online, no action needed
    const fleetRef = fleetCol(id).doc(name);
    const fleetDoc = await fleetRef.get();
    if (!fleetDoc.exists) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const currentStatus = fleetDoc.data()?.status;
    if (currentStatus === "online") {
      return NextResponse.json({ success: true, status: "online" });
    }

    // Write a verify command — command-runner will SSH-check DWD
    const cmdRef = commandsCol(id).doc();
    await cmdRef.set({
      type: "fleet_verify_dwd",
      args: { name },
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    // Wait up to 20 seconds for the command to complete
    const maxWait = 20;
    const startTime = Date.now();
    let verifyResult = null;

    while (Date.now() - startTime < maxWait * 1000) {
      await new Promise((r) => setTimeout(r, 2000));

      // Re-check fleet doc status
      const freshDoc = await fleetRef.get();
      const freshStatus = freshDoc.data()?.status;

      if (freshStatus === "online") {
        verifyResult = { success: true, status: "online" };
        break;
      }

      // Check if command completed
      const cmdDoc = await cmdRef.get();
      const cmdStatus = cmdDoc.data()?.status;
      if (cmdStatus === "complete" || cmdStatus === "failed") {
        if (cmdStatus === "complete") {
          verifyResult = { success: true, status: "online" };
        } else {
          verifyResult = {
            success: false,
            status: freshStatus,
            error: cmdDoc.data()?.error || "DWD healthcheck failed. Workspace user may not exist yet.",
          };
        }
        break;
      }
    }

    if (!verifyResult) {
      // Timeout — check one more time
      const finalDoc = await fleetRef.get();
      if (finalDoc.data()?.status === "online") {
        return NextResponse.json({ success: true, status: "online" });
      }
      return NextResponse.json({
        success: false,
        status: finalDoc.data()?.status,
        error: "Timed out waiting for DWD verification. Try again in a moment.",
      });
    }

    return NextResponse.json(verifyResult);
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/confirm-setup] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to verify setup" },
      { status: 500 }
    );
  }
}
