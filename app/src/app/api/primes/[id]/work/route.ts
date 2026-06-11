import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/work — List work envelopes for a Prime
 * Returns all non-archived envelopes from the last 7 days.
 * Query: ?status=active&type=M&limit=100
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
    const statusFilter = url.searchParams.get("status");
    const typeFilter = url.searchParams.get("type");

    const db = getDb();
    const workCol = db.collection("primes").doc(id).collection("work");

    // Filter to last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = sevenDaysAgo.toISOString();

    let q: FirebaseFirestore.Query = workCol
      .where("created_at", ">=", cutoff)
      .orderBy("created_at", "desc")
      .limit(limit);

    const snap = await q.get();

    let envelopes = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Client-side filters (Firestore doesn't support multiple inequality/equality filters well)
    if (statusFilter) {
      envelopes = envelopes.filter((e: any) => e.status === statusFilter);
    }
    if (typeFilter) {
      envelopes = envelopes.filter((e: any) => e.type === typeFilter);
    }

    // Exclude archived
    envelopes = envelopes.filter((e: any) => e.status !== "archived");

    return NextResponse.json({ envelopes });
  } catch (err) {
    console.error(`[api/primes/work] GET error:`, err);
    return NextResponse.json({ error: "Failed to list work envelopes" }, { status: 500 });
  }
}
