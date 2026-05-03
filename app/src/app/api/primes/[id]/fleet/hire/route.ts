import { NextRequest, NextResponse } from "next/server";
import { commandsCol, fleetCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/fleet/hire — Hire a fleet agent
 *
 * Writes a fleet_deploy command to the commands collection.
 * The command-runner daemon on the Prime VM host picks it up
 * and runs fleet-deploy deterministically.
 *
 * Also creates a fleet doc immediately with status "deploying"
 * so the dashboard shows instant feedback.
 *
 * Body: { name, specialty, email? }
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

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "email is required (agent Workspace email address)" },
        { status: 400 }
      );
    }

    const agentEmail = email;

    // Create fleet doc immediately for instant dashboard feedback
    await fleetCol(id).doc(name).set(
      {
        name,
        specialty,
        email: agentEmail,
        status: "deploying",
        vm: `fleet-${name}`,
        zone: "us-central1-a",
        deploySteps: [],
        deployedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Write command to queue
    const cmdRef = commandsCol(id).doc();
    await cmdRef.set({
      type: "fleet_deploy",
      args: { name, specialty, email: agentEmail },
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json(
      {
        id: cmdRef.id,
        command: "fleet_deploy",
        agent: name,
        specialty,
        email: agentEmail,
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
