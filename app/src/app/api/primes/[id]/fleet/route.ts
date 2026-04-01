import { NextResponse } from "next/server";
import { fleetCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/fleet — List fleet agents for a Prime
 */
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const snap = await fleetCol(id).get();

    const fleet = snap.docs.map((doc) => ({
      name: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() ?? null,
    }));

    return NextResponse.json({ fleet });
  } catch (err) {
    console.error(`[api/primes/${(await ctx.params).id}/fleet] GET error:`, err);
    return NextResponse.json({ error: "Failed to list fleet" }, { status: 500 });
  }
}
