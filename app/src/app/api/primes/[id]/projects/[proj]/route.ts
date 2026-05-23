import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; proj: string }>;
}

/**
 * GET /api/primes/[id]/projects/[proj] — Get project with its missions
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { id, proj } = await ctx.params;
    const db = getDb();

    // Read project doc
    const projDoc = await db
      .collection("primes")
      .doc(id)
      .collection("projects")
      .doc(proj)
      .get();

    if (!projDoc.exists) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const project = { id: projDoc.id, ...projDoc.data() };

    // Query work envelopes linked to this project (missions only)
    const workCol = db.collection("primes").doc(id).collection("work");
    const missionSnap = await workCol
      .where("project_id", "==", proj)
      .where("type", "==", "M")
      .orderBy("created_at", "desc")
      .limit(200)
      .get();

    const missions = missionSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({ project, missions });
  } catch (err) {
    console.error(`[api/primes/projects/detail] GET error:`, err);
    return NextResponse.json({ error: "Failed to get project" }, { status: 500 });
  }
}

/**
 * PATCH /api/primes/[id]/projects/[proj] — Update project
 * Body: { name?, description?, status? }
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { id, proj } = await ctx.params;
    const body = await req.json();

    const allowed = ["name", "description", "status"];
    const update: Record<string, string> = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        update[key] = body[key];
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    update.updated_at = new Date().toISOString();

    const db = getDb();
    const docRef = db
      .collection("primes")
      .doc(id)
      .collection("projects")
      .doc(proj);

    await docRef.update(update);

    const updated = await docRef.get();
    const project = { id: updated.id, ...updated.data() };

    return NextResponse.json({ project });
  } catch (err) {
    console.error(`[api/primes/projects/detail] PATCH error:`, err);
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}

/**
 * DELETE /api/primes/[id]/projects/[proj] — Archive project (soft delete)
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { id, proj } = await ctx.params;
    const db = getDb();

    await db
      .collection("primes")
      .doc(id)
      .collection("projects")
      .doc(proj)
      .update({
        status: "archived",
        updated_at: new Date().toISOString(),
      });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[api/primes/projects/detail] DELETE error:`, err);
    return NextResponse.json({ error: "Failed to archive project" }, { status: 500 });
  }
}
