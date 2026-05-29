import { NextRequest, NextResponse } from "next/server";
import { commandsCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_TYPES = [
  "fleet_deploy",
  "fleet_teardown",
  "fleet_upgrade",
  "upgrade_corekit",
  "dashboard_deploy",
  "gateway_restart",
] as const;

/**
 * POST /api/primes/[id]/commands — Create a new command
 *
 * Writes a pending command to Firestore. The command-runner daemon
 * on the Prime VM host picks it up and executes it deterministically.
 *
 * Body: { type, args }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { type, args } = body;

    if (!type || !VALID_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `Invalid command type. Valid: ${VALID_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    const cmdRef = commandsCol(id).doc();
    await cmdRef.set({
      type,
      args: args || {},
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json(
      { id: cmdRef.id, type, status: "pending" },
      { status: 201 }
    );
  } catch (err) {
    console.error(`[api/commands] POST error:`, err);
    return NextResponse.json(
      { error: "Failed to create command" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/primes/[id]/commands — List recent commands
 *
 * Returns the most recent commands for progress display.
 * Query params:
 *   ?status=pending,running — filter by status (comma-separated)
 *   ?limit=10               — max results (default 10)
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "10"), 50);

    let query = commandsCol(id)
      .orderBy("createdAt", "desc")
      .limit(limit);

    // If status filter provided, use where-in
    if (statusFilter) {
      const statuses = statusFilter.split(",").map((s) => s.trim());
      query = commandsCol(id)
        .where("status", "in", statuses)
        .orderBy("createdAt", "desc")
        .limit(limit);
    }

    const snap = await query.get();
    const commands = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        type: data.type,
        args: data.args || {},
        status: data.status,
        result: data.result || null,
        error: data.error || null,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt || null,
      };
    });

    return NextResponse.json({ commands });
  } catch (err) {
    console.error(`[api/commands] GET error:`, err);
    return NextResponse.json(
      { error: "Failed to list commands" },
      { status: 500 }
    );
  }
}
