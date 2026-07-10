import { NextRequest, NextResponse } from "next/server";
import { fleetMessagesCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; agent: string }>;
}

/**
 * GET /api/primes/[id]/fleet/[agent]/messages — List messages for a fleet agent
 * Query: ?limit=50
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, agent } = await ctx.params;
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);

    const snap = await fleetMessagesCol(id, agent)
      .orderBy("timestamp", "asc")
      .limitToLast(limit)
      .get();

    const messages = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.()?.toISOString() ?? null,
    }));

    return NextResponse.json({ messages });
  } catch (err) {
    const { id, agent } = await ctx.params;
    console.error(`[api/primes/${id}/fleet/${agent}/messages] GET error:`, err);
    return NextResponse.json({ error: "Failed to list messages" }, { status: 500 });
  }
}

/**
 * POST /api/primes/[id]/fleet/[agent]/messages — Send a message to a fleet agent
 * Body: { text }
 * The agent-ears service on the fleet VM polls for unprocessed admin messages.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  return NextResponse.json(
    { error: "Direct dashboard chat is retired for fleet agents. Please use GChat." },
    {
      status: 405,
      headers: {
        Allow: "GET",
      },
    }
  );
}
