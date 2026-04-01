import { NextRequest, NextResponse } from "next/server";
import { messagesCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/fire — Fire a fleet agent
 *
 * Sends a structured fire command to the Prime via Firestore messages.
 * The Prime's control-daemon picks this up, invokes agent-ask,
 * which runs fleet-teardown to delete the agent VM.
 *
 * Body: { name }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const fireCommand = `fire agent ${name}`;

    const msgRef = messagesCol(id).doc();
    await msgRef.set({
      sender: "admin",
      text: fireCommand,
      timestamp: FieldValue.serverTimestamp(),
      processed: false,
    });

    return NextResponse.json(
      { id: msgRef.id, command: "fire", agent: name },
      { status: 201 }
    );
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/fire] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to send fire command" },
      { status: 500 }
    );
  }
}
