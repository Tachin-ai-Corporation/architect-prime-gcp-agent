import { NextRequest, NextResponse } from "next/server";
import { plansCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/plans — List all plans for a prime
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;

    const col = plansCol();
    const snap = await col
      .where("prime_id", "==", id)
      .orderBy("created_at", "desc")
      .get();

    const plans = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({ plans });
  } catch (err) {
    console.error(`[api/primes/plans] GET error:`, err);
    return NextResponse.json({ error: "Failed to list plans" }, { status: 500 });
  }
}
