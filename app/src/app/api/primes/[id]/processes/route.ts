import { NextRequest, NextResponse } from "next/server";
import { processesCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/processes — List all processes for a prime
 * Query: ?includeDeprecated=true
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const includeDeprecated = url.searchParams.get("includeDeprecated") === "true";

    const col = processesCol();
    const snap = await col.orderBy("created_at", "desc").get();

    let processes = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Exclude deprecated by default
    if (!includeDeprecated) {
      processes = processes.filter((p: any) => p.status !== "deprecated");
    }

    return NextResponse.json({ processes });
  } catch (err) {
    console.error(`[api/primes/processes] GET error:`, err);
    return NextResponse.json({ error: "Failed to list processes" }, { status: 500 });
  }
}

/**
 * POST /api/primes/[id]/processes — Create a new process (narrative playbook)
 * Body: { id, name, description?, narrative, intent_keywords? }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();

    if (!body.id || !body.name || !body.narrative) {
      return NextResponse.json(
        { error: "Missing required fields: id, name, narrative" },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();

    const process = {
      name: body.name,
      description: body.description || "",
      narrative: body.narrative,
      intent_keywords: body.intent_keywords || [],
      status: "active",
      version: 1,
      visibility: "team",
      // created_at is retained purely to keep the GET list ordering stable.
      created_at: now,
      updated_at: now,
      updated_by: "operator",
    };

    const col = processesCol();
    await col.doc(body.id).set(process);

    return NextResponse.json({ process: { id: body.id, ...process } });
  } catch (err) {
    console.error(`[api/primes/processes] POST error:`, err);
    return NextResponse.json({ error: "Failed to create process" }, { status: 500 });
  }
}
