import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/projects — List projects for a Prime
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { id } = await ctx.params;
    const db = getDb();
    const col = db.collection("primes").doc(id).collection("projects");

    const snap = await col.orderBy("created_at", "desc").get();
    const projects = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({ projects });
  } catch (err) {
    console.error(`[api/primes/projects] GET error:`, err);
    return NextResponse.json({ error: "Failed to list projects" }, { status: 500 });
  }
}

/**
 * POST /api/primes/[id]/projects — Create a project
 * Body: { name: string, description?: string }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { name, description } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const projectId = `proj-${Date.now()}`;
    const now = new Date().toISOString();

    const project = {
      id: projectId,
      name: name.trim(),
      description: typeof description === "string" ? description.trim() : "",
      status: "active" as const,
      created_at: now,
      updated_at: now,
    };

    const db = getDb();
    await db
      .collection("primes")
      .doc(id)
      .collection("projects")
      .doc(projectId)
      .set(project);

    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    console.error(`[api/primes/projects] POST error:`, err);
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 });
  }
}
