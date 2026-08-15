import { NextRequest, NextResponse } from "next/server";
import { processesCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { withCanonicalId } from "@/lib/entity";

interface RouteContext {
  params: Promise<{ id: string; processId: string }>;
}

/**
 * GET /api/primes/[id]/processes/[processId] — Get single process with full detail
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id, processId } = await ctx.params;

    const docRef = processesCol().doc(processId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Process not found" }, { status: 404 });
    }

    return NextResponse.json({ process: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error(`[api/primes/processes/detail] GET error:`, err);
    return NextResponse.json({ error: "Failed to get process" }, { status: 500 });
  }
}

/**
 * PUT /api/primes/[id]/processes/[processId] — Update process (narrative playbook)
 * Body: partial update over { name, description, narrative, intent_keywords, status }.
 * Auto-increments version and stamps updated_at / updated_by.
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, processId } = await ctx.params;
    const body = await req.json();

    const docRef = processesCol().doc(processId);
    const existing = await docRef.get();

    if (!existing.exists) {
      return NextResponse.json({ error: "Process not found" }, { status: 404 });
    }

    const existingData = existing.data() || {};
    const now = new Date().toISOString();
    const newVersion = (existingData.version || 1) + 1;

    // Whitelist the narrative shape — no step/parameter machinery is written.
    // C-31: the path ID is stamped on every update, self-healing records written
    // before the canonical-ID fix.
    const update: Record<string, unknown> = withCanonicalId(processId, {
      version: newVersion,
      updated_at: now,
      updated_by: "operator",
    });
    if (typeof body.name === "string") update.name = body.name;
    if (typeof body.description === "string") update.description = body.description;
    if (typeof body.narrative === "string") update.narrative = body.narrative;
    if (Array.isArray(body.intent_keywords)) update.intent_keywords = body.intent_keywords;
    if (body.status === "active" || body.status === "deprecated") update.status = body.status;

    await docRef.update(update);

    // Re-read to return merged result
    const updated = await docRef.get();
    return NextResponse.json({ process: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error(`[api/primes/processes/detail] PUT error:`, err);
    return NextResponse.json({ error: "Failed to update process" }, { status: 500 });
  }
}

/**
 * PATCH /api/primes/[id]/processes/[processId] — Subscribe/unsubscribe agent
 * Body: { action: "subscribe" | "unsubscribe", email: string }
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, processId } = await ctx.params;
    const body = await req.json();
    const { action, email } = body;

    if (!action || !email) {
      return NextResponse.json(
        { error: "Missing required fields: action, email" },
        { status: 400 },
      );
    }

    if (action !== "subscribe" && action !== "unsubscribe") {
      return NextResponse.json(
        { error: "action must be 'subscribe' or 'unsubscribe'" },
        { status: 400 },
      );
    }

    const docRef = processesCol().doc(processId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Process not found" }, { status: 404 });
    }

    if (action === "subscribe") {
      await docRef.update({ subscribers: FieldValue.arrayUnion(email) });
    } else {
      await docRef.update({ subscribers: FieldValue.arrayRemove(email) });
    }

    const updated = await docRef.get();
    return NextResponse.json({ process: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error(`[api/primes/processes/detail] PATCH error:`, err);
    return NextResponse.json({ error: "Failed to update subscription" }, { status: 500 });
  }
}
