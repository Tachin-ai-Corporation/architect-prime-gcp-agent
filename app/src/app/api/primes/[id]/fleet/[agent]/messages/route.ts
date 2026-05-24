import { NextRequest, NextResponse } from "next/server";
import { fleetMessagesCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { requireAuth } from "@/lib/require-auth";

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
  try {
    const { id, agent } = await ctx.params;
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const body = await req.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const msgRef = fleetMessagesCol(id, agent).doc();
    await msgRef.set({
      sender: "admin",
      text: text.trim(),
      timestamp: FieldValue.serverTimestamp(),
      processed: false,
    });

    return NextResponse.json(
      { id: msgRef.id, sender: "admin", text: text.trim() },
      { status: 201 }
    );
  } catch (err) {
    const { id, agent } = await ctx.params;
    console.error(`[api/primes/${id}/fleet/${agent}/messages] POST error:`, err);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
