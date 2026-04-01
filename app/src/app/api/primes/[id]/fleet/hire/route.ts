import { NextRequest, NextResponse } from "next/server";
import { messagesCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/hire — Hire a fleet agent
 *
 * Sends a structured hire command to the Prime via Firestore messages.
 * The Prime's control-daemon picks this up, invokes agent-ask,
 * which runs fleet-deploy to create the agent VM.
 *
 * Body: { name, specialty, email }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { name, specialty, email } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!specialty || typeof specialty !== "string") {
      return NextResponse.json(
        { error: "specialty is required" },
        { status: 400 }
      );
    }

    // Build the hire command as a natural language message that Prime understands
    const hireCommand = email
      ? `hire a ${specialty} agent named ${name} with email ${email}`
      : `hire a ${specialty} agent named ${name}`;

    const msgRef = messagesCol(id).doc();
    await msgRef.set({
      sender: "admin",
      text: hireCommand,
      timestamp: FieldValue.serverTimestamp(),
      processed: false,
    });

    return NextResponse.json(
      {
        id: msgRef.id,
        command: "hire",
        agent: name,
        specialty,
        email: email || null,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/hire] POST error:`,
      err
    );
    return NextResponse.json(
      { error: "Failed to send hire command" },
      { status: 500 }
    );
  }
}
