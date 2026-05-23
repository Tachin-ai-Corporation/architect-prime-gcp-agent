import { NextRequest, NextResponse } from "next/server";
import { commandsCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { requireAuth } from "@/lib/require-auth";

/**
 * POST /api/primes/[id]/models/scan — Trigger model scan on Prime VM.
 * Queues a discover_models command and returns the command ID.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: primeId } = await params;
  try {
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const cmdRef = await commandsCol(primeId).add({
      type: "discover_models",
      args: {},
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ commandId: cmdRef.id });
  } catch (err) {
    console.error("[api/models/scan] POST error:", err);
    return NextResponse.json({ error: "Failed to queue scan command" }, { status: 500 });
  }
}
