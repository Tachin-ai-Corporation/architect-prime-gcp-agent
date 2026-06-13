import { NextRequest, NextResponse } from "next/server";
import { processesCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; processId: string }>;
}

/**
 * GET /api/primes/[id]/processes/[processId] — Get single process with full detail
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id, processId } = await ctx.params;

    const docRef = processesCol(id).doc(processId);
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
 * PUT /api/primes/[id]/processes/[processId] — Update process
 * Body: partial update. Deep merge on steps, parameters, contextTemplate.
 * Auto-increments version. Appends to changelog.
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, processId } = await ctx.params;
    const body = await req.json();

    const docRef = processesCol(id).doc(processId);
    const existing = await docRef.get();

    if (!existing.exists) {
      return NextResponse.json({ error: "Process not found" }, { status: 404 });
    }

    const existingData = existing.data() || {};
    const now = new Date().toISOString();
    const newVersion = (existingData.version || 1) + 1;

    // Deep merge steps if provided (replace array)
    if (body.steps && Array.isArray(body.steps)) {
      // Steps are replaced wholesale — they're an ordered list
    }

    // Deep merge parameters at key level if provided
    if (body.parameters && typeof body.parameters === "object") {
      body.parameters = {
        ...(existingData.parameters || {}),
        ...body.parameters,
      };
    }

    // Deep merge contextTemplate at entry level if provided
    if (body.contextTemplate && typeof body.contextTemplate === "object") {
      body.contextTemplate = {
        ...(existingData.contextTemplate || {}),
        ...body.contextTemplate,
      };
    }

    // Build changelog entry
    const changelogEntry = {
      version: newVersion,
      timestamp: now,
      author: "operator",
      summary: body.changelog_summary || "Updated process",
    };

    const update = {
      ...body,
      version: newVersion,
      updated_at: now,
      changelog: [...(existingData.changelog || []), changelogEntry],
    };

    // Remove transient fields
    delete update.changelog_summary;

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

    const docRef = processesCol(id).doc(processId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Process not found" }, { status: 404 });
    }

    const { FieldValue } = await import("firebase-admin/firestore");

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
