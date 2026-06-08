import { NextRequest, NextResponse } from "next/server";
import { projectsCol } from "@/lib/firestore";

/**
 * GET /api/projects — List projects
 * Query: ?team=chuck — filter by team membership
 *        &status=active — filter by status
 *        &includeArchived=true — include archived projects
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const teamFilter = url.searchParams.get("team");
    const statusFilter = url.searchParams.get("status");
    const includeArchived = url.searchParams.get("includeArchived") === "true";

    const col = projectsCol();

    let queryRef: FirebaseFirestore.Query = col;

    // Filter by team membership if specified
    if (teamFilter) {
      queryRef = queryRef.where("team", "array-contains", teamFilter);
    }

    queryRef = queryRef.orderBy("created_at", "desc");
    const snap = await queryRef.get();

    let projects = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Exclude archived by default
    if (!includeArchived) {
      projects = projects.filter((p: any) => p.status !== "archived");
    }

    // Optional status filter
    if (statusFilter) {
      projects = projects.filter((p: any) => p.status === statusFilter);
    }

    return NextResponse.json({ projects });
  } catch (err) {
    console.error(`[api/projects] GET error:`, err);
    return NextResponse.json({ error: "Failed to list projects" }, { status: 500 });
  }
}

/**
 * POST /api/projects — Create a new project
 * Body: { id, name, description, team?, ownerAgent?, context? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (!body.id || !body.name || !body.description) {
      return NextResponse.json(
        { error: "Missing required fields: id, name, description" },
        { status: 400 }
      );
    }

    // Validate against duplicate project IDs
    const col = projectsCol();
    const existing = await col.doc(body.id).get();
    if (existing.exists) {
      return NextResponse.json(
        { error: `Project with ID '${body.id}' already exists` },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();

    const project = {
      name: body.name,
      description: body.description,
      status: "active",
      ownerAgent: body.ownerAgent || null,
      team: body.team || [],
      created_by: body.created_by || "operator",
      participants: [],
      missionCount: 0,
      completedMissions: 0,
      context: body.context || {},
      created_at: now,
      completed_at: null,
    };

    await col.doc(body.id).set(project);

    return NextResponse.json({ project: { id: body.id, ...project } });
  } catch (err) {
    console.error(`[api/projects] POST error:`, err);
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 });
  }
}
