// API route: /api/approvals — Global approvals endpoint
// Replaces the prime-scoped /api/primes/[id]/approvals
// primeId comes from query param (GET) or request body (POST)

import { NextRequest, NextResponse } from "next/server";
import { approvalsCol } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";

/**
 * GET /api/approvals?primeId=xxx — List approvals
 *
 * Query params:
 *   primeId — required
 *   status  — optional filter (e.g. "pending")
 */
export async function GET(req: NextRequest) {
  try {
    const primeId = req.nextUrl.searchParams.get("primeId");
    if (!primeId) {
      return NextResponse.json({ error: "primeId query param required" }, { status: 400 });
    }

    const statusFilter = req.nextUrl.searchParams.get("status");

    let query = approvalsCol()
      .where("prime_id", "==", primeId)
      .orderBy("requestedAt", "desc");

    if (statusFilter) {
      query = approvalsCol()
        .where("prime_id", "==", primeId)
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
    console.error(`[api/approvals] GET error:`, err);
    return NextResponse.json({ error: "Failed to list approvals" }, { status: 500 });
  }
}

/**
 * POST /api/approvals — Approve or reject
 *
 * Body: { primeId, approvalId, action: 'approve'|'reject', reason? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { primeId, approvalId, action, reason } = body;

    if (!primeId || !approvalId || !action) {
      return NextResponse.json(
        { error: "Missing required fields: primeId, approvalId, action" },
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
    console.error(`[api/approvals] POST error:`, err);
    return NextResponse.json(
      { error: "Failed to update approval" },
      { status: 500 }
    );
  }
}
