import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { seedCoreProcesses } from "@/lib/seed-processes";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/processes/seed — Seed core processes
 *
 * Idempotent: skips if already seeded with same version.
 * Used by the dashboard to seed existing Primes that were
 * deployed before core process seeding was added.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { id } = await ctx.params;
    const result = await seedCoreProcesses(id);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[api/primes/processes/seed] POST error:`, err);
    return NextResponse.json(
      { error: "Failed to seed core processes" },
      { status: 500 }
    );
  }
}
