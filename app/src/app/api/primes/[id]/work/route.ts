import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/work — List work envelopes for a Prime
 * Returns all non-archived envelopes from the last 7 days.
 * Backfills missing parent envelopes so tree building always has complete chains.
 * Query: ?status=active&type=M&limit=250
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "250"), 500);
    const statusFilter = url.searchParams.get("status");
    const typeFilter = url.searchParams.get("type");

    const db = getDb();
    const workCol = db.collection("primes").doc(id).collection("work");

    // Filter to last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = sevenDaysAgo.toISOString();

    const q: FirebaseFirestore.Query = workCol
      .where("created_at", ">=", cutoff)
      .orderBy("created_at", "desc")
      .limit(limit);

    const snap = await q.get();

    const envelopeMap = new Map<string, Record<string, unknown>>();
    for (const doc of snap.docs) {
      envelopeMap.set(doc.id, { id: doc.id, ...doc.data() });
    }

    // Backfill missing parents — if a child references a parent_id not in the
    // result set (e.g. an M envelope created before the limit window), fetch it
    // individually so tree building can link parent→child properly.
    const missingParentIds = new Set<string>();
    for (const e of envelopeMap.values()) {
      const parentId = (e as any).parent_id;
      if (parentId && !envelopeMap.has(parentId)) {
        missingParentIds.add(parentId);
      }
    }
    if (missingParentIds.size > 0) {
      // Firestore getAll supports up to 500 refs per call
      const refs = [...missingParentIds].map((pid) => workCol.doc(pid));
      const parentDocs = await db.getAll(...refs);
      for (const doc of parentDocs) {
        if (doc.exists) {
          envelopeMap.set(doc.id, { id: doc.id, ...doc.data()! });
        }
      }
    }

    let envelopes = [...envelopeMap.values()];

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
