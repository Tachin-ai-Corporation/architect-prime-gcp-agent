import { NextRequest, NextResponse } from "next/server";
import { commandsCol, fleetCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { requireAuth } from "@/lib/require-auth";
import { seedCoreProcesses } from "@/lib/seed-processes";

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
  const { id } = await ctx.params;

  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
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

    // Create fleet doc immediately for instant dashboard feedback
    await fleetCol(id).doc(name).set(
      {
        name,
        specialty,
        email,
        status: "deploying",
        vm: `fleet-${name}`,
        zone: "us-central1-a",
        deploySteps: [],
        deployedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Dedup: skip if there's already a pending/running deploy for this agent
    const existing = await commandsCol(id)
      .where("type", "==", "fleet_deploy")
      .where("args.name", "==", name)
      .where("status", "in", ["pending", "running"])
      .limit(1)
      .get();

    if (!existing.empty) {
      return NextResponse.json(
        { id: existing.docs[0].id, command: "fleet_deploy", agent: name, deduplicated: true },
        { status: 200 }
      );
    }

    // Write command to queue
    const cmdRef = commandsCol(id).doc();
    await cmdRef.set({
      type: "fleet_deploy",
      args: { name, specialty, email },
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    // Seed core processes (p-plan, p-investigate) — idempotent
    seedCoreProcesses(id).catch((err) =>
      console.error(`[hire] Failed to seed core processes:`, err)
    );

    return NextResponse.json(
      {
        id: cmdRef.id,
        command: "fleet_deploy",
        agent: name,
        specialty,
        email,
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
