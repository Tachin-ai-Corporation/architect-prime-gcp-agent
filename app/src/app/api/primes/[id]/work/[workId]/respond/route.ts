import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; workId: string }>;
}

/**
 * POST /api/primes/[id]/work/[workId]/respond
 * Submit a response to a work envelope that is in `needs_input` status.
 * Creates an intake document that the brain will pick up.
 *
 * Body: { response: string }
 * Returns: { ok: true, intakeId: string }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id: primeId, workId } = await ctx.params;
    const body = await req.json();
    const { response } = body;

    if (!response || typeof response !== "string") {
      return NextResponse.json(
        { error: "response is required and must be a string" },
        { status: 400 }
      );
    }

    const db = getDb();
    const now = new Date();
    const hex4 = Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
    const intakeId = `i-${now.getTime()}-${hex4}`;

    const intakeRef = db
      .collection("primes")
      .doc(primeId)
      .collection("intake")
      .doc(intakeId);

    await intakeRef.set({
      id: intakeId,
      text: response.trim(),
      source: "dashboard",
      source_meta: { responding_to: workId },
      status: "pending",
      created_at: now.toISOString(),
    });

    return NextResponse.json({ ok: true, intakeId }, { status: 201 });
  } catch (err) {
    const { id, workId } = await ctx.params;
    console.error(
      `[api/primes/${id}/work/${workId}/respond] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to submit response" },
      { status: 500 }
    );
  }
}
