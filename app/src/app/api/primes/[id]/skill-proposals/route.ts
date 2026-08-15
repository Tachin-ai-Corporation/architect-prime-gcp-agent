import { NextRequest, NextResponse } from "next/server";
import { skillProposalsCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/skill-proposals — List skill proposals
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const snap = await skillProposalsCol()
      .where("prime_id", "==", id)
      .orderBy("proposed_at", "desc")
      .limit(50)
      .get();
    const proposals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return NextResponse.json({ proposals });
  } catch (err) {
    console.error("[api/skill-proposals] GET error:", err);
    return NextResponse.json({ error: "Failed to list proposals" }, { status: 500 });
  }
}

/**
 * POST /api/primes/[id]/skill-proposals — Record an approve/reject decision
 * Body: { proposalId, action: "approve" | "reject" }
 *
 * **Approving records the decision; it does not publish the skill.** Nothing
 * installs, evaluates, assigns or activates as a result. That gap was invisible
 * to an operator who saw a proposal flip to "approved" and reasonably concluded
 * the fleet had gained a capability, so the response now says so explicitly via
 * `published: false`. Publication is being built as a Fleet Definition release
 * (C-31): draft → validate → evaluate → canary → promote, with a rollback target.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { proposalId, action } = body;

    if (!proposalId || !action) {
      return NextResponse.json({ error: "proposalId and action required" }, { status: 400 });
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
    }

    const ref = skillProposalsCol().doc(proposalId);
    const doc = await ref.get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }

    const now = new Date().toISOString();

    if (action === "approve") {
      await ref.update({ status: "approved", approved_at: now, published: false });
      return NextResponse.json({
        status: "approved",
        proposalId,
        published: false,
        note:
          "Decision recorded. The skill is not installed, assigned or active — " +
          "publication goes through the Fleet Definition release lifecycle.",
      });
    } else {
      await ref.update({ status: "rejected", rejected_at: now });
      return NextResponse.json({ status: "rejected", proposalId });
    }
  } catch (err) {
    console.error("[api/skill-proposals] POST error:", err);
    return NextResponse.json({ error: "Failed to update proposal" }, { status: 500 });
  }
}
