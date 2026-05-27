import { NextRequest, NextResponse } from "next/server";
import { fleetSkillsCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; agent: string }>;
}

/**
 * GET /api/primes/[id]/fleet/[agent]/skills — List installed custom skills
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, agent } = await ctx.params;
    const snap = await fleetSkillsCol(id, agent).get();
    const skills = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return NextResponse.json({ skills });
  } catch (err) {
    console.error("[api/skills] GET error:", err);
    return NextResponse.json({ error: "Failed to list skills" }, { status: 500 });
  }
}

/**
 * POST /api/primes/[id]/fleet/[agent]/skills — Queue a skill install
 * Body: { skillId, origin, version }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, agent } = await ctx.params;
    const body = await req.json();
    const { skillId, origin, version } = body;

    if (!skillId) {
      return NextResponse.json({ error: "skillId required" }, { status: 400 });
    }

    await fleetSkillsCol(id, agent).doc(skillId).set({
      id: skillId,
      installed_at: new Date().toISOString(),
      installed_by: "dashboard",
      origin: origin || "learned",
      version: version || "1.0.0",
      status: "pending_install",
    });

    return NextResponse.json({ status: "queued", skillId });
  } catch (err) {
    console.error("[api/skills] POST error:", err);
    return NextResponse.json({ error: "Failed to install skill" }, { status: 500 });
  }
}

/**
 * DELETE /api/primes/[id]/fleet/[agent]/skills — Remove a skill
 * Query: ?skillId=xxx
 */
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, agent } = await ctx.params;
    const url = new URL(req.url);
    const skillId = url.searchParams.get("skillId");

    if (!skillId) {
      return NextResponse.json({ error: "skillId required" }, { status: 400 });
    }

    await fleetSkillsCol(id, agent).doc(skillId).delete();
    return NextResponse.json({ status: "removed", skillId });
  } catch (err) {
    console.error("[api/skills] DELETE error:", err);
    return NextResponse.json({ error: "Failed to remove skill" }, { status: 500 });
  }
}
