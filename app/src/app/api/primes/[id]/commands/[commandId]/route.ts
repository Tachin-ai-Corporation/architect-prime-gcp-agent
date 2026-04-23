import { NextRequest, NextResponse } from "next/server";
import { commandsCol } from "@/lib/firestore";

/**
 * GET /api/primes/[id]/commands/[commandId] — Get status of a single command.
 * Used by the frontend to poll for command completion.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; commandId: string }> }
) {
  const { id: primeId, commandId } = await params;
  try {
    const doc = await commandsCol(primeId).doc(commandId).get();
    if (!doc.exists) {
      return NextResponse.json({ error: "Command not found" }, { status: 404 });
    }

    const data = doc.data()!;
    return NextResponse.json({
      id: doc.id,
      type: data.type,
      status: data.status,
      result: data.result || null,
      error: data.error || null,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
      updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || null,
    });
  } catch (err) {
    console.error("[api/commands] GET error:", err);
    return NextResponse.json({ error: "Failed to get command status" }, { status: 500 });
  }
}
