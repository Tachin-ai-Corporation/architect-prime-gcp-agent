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
 * POST /api/primes/[id]/fleet/[agent]/skills — DISABLED
 *
 * This wrote a `status: "pending_install"` metadata record that nothing could
 * ever resolve. The only consumer was the custom-skill block inside
 * `upgrade-corekit`, which ran solely during a CoreKit upgrade and derived its
 * lookup key from `agentDisplayName` — so a skill queued under `millie` was read
 * back under `Assistant Agent Millie` and never found. An operator saw "queued"
 * and got nothing, indefinitely.
 *
 * Returning a definite 501 is more honest than an install that silently never
 * happens. Skill assignment is being rebuilt as a Fleet Definition release
 * (C-31): authored as an immutable revision, validated, evaluated, assigned to a
 * canary, and applied by content-sync at an idle mission boundary — with a
 * desired-vs-actual digest instead of a status string.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id, agent } = await ctx.params;
  console.warn(`[api/skills] refused disabled custom-skill install for ${id}/${agent}`);
  return NextResponse.json(
    {
      error: "Custom skill install is not available.",
      reason:
        "The previous implementation recorded an install that no runtime path could complete. " +
        "Skill assignment now goes through the Fleet Definition release lifecycle.",
      status: "not_implemented",
    },
    { status: 501 }
  );
}

/**
 * DELETE /api/primes/[id]/fleet/[agent]/skills — DISABLED
 *
 * The mirror of POST. Deleting the metadata record removed the *record*, never
 * the installed skill on the VM, so "removed" reported a state change that had
 * not occurred. Removal belongs to the same Fleet Definition release lifecycle
 * as assignment (C-31) — a deprecation is a revision with a rollback target, not
 * a document delete.
 */
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const { id, agent } = await ctx.params;
  console.warn(`[api/skills] refused disabled custom-skill removal for ${id}/${agent}`);
  return NextResponse.json(
    {
      error: "Custom skill removal is not available.",
      reason:
        "The previous implementation deleted a metadata record without removing anything " +
        "from the agent. Deprecation now goes through the Fleet Definition release lifecycle.",
      status: "not_implemented",
    },
    { status: 501 }
  );
}
