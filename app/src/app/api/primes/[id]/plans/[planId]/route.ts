import { NextRequest, NextResponse } from "next/server";
import { plansCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; planId: string }>;
}

/**
 * GET /api/primes/[id]/plans/[planId] — Get single plan
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id, planId } = await ctx.params;

    const docRef = plansCol(id).doc(planId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    return NextResponse.json({ plan: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error(`[api/primes/plans/detail] GET error:`, err);
    return NextResponse.json({ error: "Failed to get plan" }, { status: 500 });
  }
}

/**
 * PUT /api/primes/[id]/plans/[planId] — Update plan
 * Body: { status?, approved_by? }
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, planId } = await ctx.params;
    const body = await req.json();

    const docRef = plansCol(id).doc(planId);
    const existing = await docRef.get();

    if (!existing.exists) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      ...body,
      updated_at: now,
    };

    // Auto-set approved_at when approving
    if (body.status === "approved" && !body.approved_at) {
      update.approved_at = now;
    }

    await docRef.update(update);

    // Re-read to return merged result
    const updated = await docRef.get();
    return NextResponse.json({ plan: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error(`[api/primes/plans/detail] PUT error:`, err);
    return NextResponse.json({ error: "Failed to update plan" }, { status: 500 });
  }
}
