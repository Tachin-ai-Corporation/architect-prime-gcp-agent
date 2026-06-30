import { NextRequest, NextResponse } from "next/server";
import { approvalsCol } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/approvals — List approvals
 *
 * Query params:
 *   ?status=pending — filter by status
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status");

    let query = approvalsCol()
      .where("prime_id", "==", id)
      .orderBy("requestedAt", "desc");

    if (statusFilter) {
      query = approvalsCol()
        .where("prime_id", "==", id)
        .where("status", "==", statusFilter)
        .orderBy("requestedAt", "desc");
    }

    const snap = await query.get();
    const approvals = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        envelopeId: data.envelopeId || null,
        checkpointId: data.checkpointId || null,
        taskId: data.taskId || null,
        title: data.title || null,
        description: data.description || null,
        processId: data.processId || null,
        processName: data.processName || null,
        status: data.status,
        requestedAt: data.requestedAt?.toDate?.()?.toISOString() || data.requestedAt || null,
        resolvedAt: data.resolvedAt?.toDate?.()?.toISOString() || data.resolvedAt || null,
        resolvedBy: data.resolvedBy || null,
        reason: data.reason || null,
      };
    });

    return NextResponse.json({ approvals });
  } catch (err) {
    console.error(`[api/primes/approvals] GET error:`, err);
    return NextResponse.json({ error: "Failed to list approvals" }, { status: 500 });
  }
}

/**
 * POST /api/primes/[id]/approvals — Approve or reject
 *
 * Body: { approvalId, action: 'approve'|'reject', reason? }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { approvalId, action, reason } = body;

    if (!approvalId || !action) {
      return NextResponse.json(
        { error: "Missing required fields: approvalId, action" },
        { status: 400 }
      );
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        { error: "Invalid action. Must be 'approve' or 'reject'" },
        { status: 400 }
      );
    }

    const docRef = approvalsCol().doc(approvalId);
    const existing = await docRef.get();

    if (!existing.exists) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    const status = action === "approve" ? "approved" : "rejected";
    const session = auth.session as { user?: { email?: string } } | null;
    const resolvedBy = session?.user?.email || "operator";

    await docRef.update({
      status,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
      ...(reason ? { reason } : {}),
    });

    return NextResponse.json({
      id: approvalId,
      status,
      resolvedBy,
    });
  } catch (err) {
    console.error(`[api/primes/approvals] POST error:`, err);
    return NextResponse.json(
      { error: "Failed to update approval" },
      { status: 500 }
    );
  }
}
