import { NextRequest, NextResponse } from "next/server";
import { projectsCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; projectId: string }>;
}

/**
 * GET /api/primes/[id]/projects/[projectId] — Get single project with full context
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id, projectId } = await ctx.params;

    const docRef = projectsCol(id).doc(projectId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({ project: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error(`[api/primes/projects/detail] GET error:`, err);
    return NextResponse.json({ error: "Failed to get project" }, { status: 500 });
  }
}

/**
 * PUT /api/primes/[id]/projects/[projectId] — Update project
 * Body: partial update. Context is deep-merged (entry-level) with existing.
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, projectId } = await ctx.params;
    const body = await req.json();

    const docRef = projectsCol(id).doc(projectId);
    const existing = await docRef.get();

    if (!existing.exists) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const existingData = existing.data() || {};

    // Deep merge context at entry level if provided
    if (body.context && typeof body.context === "object") {
      body.context = {
        ...(existingData.context || {}),
        ...body.context,
      };
    }

    const update = {
      ...body,
      updated_at: new Date().toISOString(),
    };

    await docRef.update(update);

    // Re-read to return merged result
    const updated = await docRef.get();
    return NextResponse.json({ project: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error(`[api/primes/projects/detail] PUT error:`, err);
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}
