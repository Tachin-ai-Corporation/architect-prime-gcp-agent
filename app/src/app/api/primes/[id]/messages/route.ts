import { NextRequest, NextResponse } from "next/server";
import { messagesCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/messages — List messages for a Prime
 * Query: ?limit=50&after=<timestamp>
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);

    const snap = await messagesCol(id)
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
    console.error(`[api/primes/${(await ctx.params).id}/messages] GET error:`, err);
    return NextResponse.json({ error: "Failed to list messages" }, { status: 500 });
  }
}

/**
 * POST /api/primes/[id]/messages — Send a message to a Prime
 * Body: { text }
 * The agent-ears service on the Prime VM polls for unprocessed admin messages.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const msgRef = messagesCol(id).doc();
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
    console.error(`[api/primes/${(await ctx.params).id}/messages] POST error:`, err);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
