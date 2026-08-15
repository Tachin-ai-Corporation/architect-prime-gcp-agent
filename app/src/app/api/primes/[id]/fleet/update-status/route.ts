import { NextRequest, NextResponse } from "next/server";
import { fleetCol } from "@/lib/firestore";
import { requireMachineAuth, isAgentServiceAccount } from "@/lib/machine-auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Statuses a VM is allowed to assert about itself. */
const SELF_REPORTABLE = new Set(["online", "provisioning", "degraded", "failed"]);

/** Bound the free-text an unattended VM can render into the operator's dashboard. */
const MAX_TITLE = 200;
const MAX_INSTRUCTION = 500;
const MAX_INSTRUCTIONS = 10;

/**
 * POST /api/primes/[id]/fleet/update-status — Fleet VM self-report
 *
 * Called by `fleet-bootstrap.sh` (step 14) so a freshly provisioned VM can report
 * its own bootstrap outcome without the fleet SA needing `roles/datastore.user`.
 *
 * Auth: a Google-signed GCE workload identity token, audience-bound to this
 * service, asserting a `fleet-*` / `prime-*` service account inside this GCP
 * project. Fails closed. (This check was documented but absent before
 * v2026.08.15 — the route accepted any caller.)
 *
 * Body: { agent, status, actionRequired? }
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await requireMachineAuth(req, { allowServiceAccount: isAgentServiceAccount });
  if (!auth.authenticated) return auth.response;

  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const { agent, status, actionRequired } = body;

    if (!agent || typeof agent !== "string") {
      return NextResponse.json({ error: "agent is required" }, { status: 400 });
    }
    if (!status || typeof status !== "string") {
      return NextResponse.json({ error: "status is required" }, { status: 400 });
    }
    if (!SELF_REPORTABLE.has(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${[...SELF_REPORTABLE].join(", ")}` },
        { status: 400 }
      );
    }

    // A VM may only speak for itself. `fleet-deploy` derives the SA name from the
    // agent id, so the asserted identity must match the agent being reported —
    // otherwise one compromised VM could mark the whole fleet online.
    const expected = new Set([`fleet-${agent}@`, `prime-${agent}@`]);
    if (![...expected].some((prefix) => auth.serviceAccount.startsWith(prefix))) {
      console.warn(
        `[api/primes/${id}/fleet/update-status] ${auth.serviceAccount} tried to report for '${agent}'`
      );
      return NextResponse.json(
        { error: "A workload may only report its own status" },
        { status: 403 }
      );
    }

    const fleetRef = fleetCol(id).doc(agent);
    const fleetDoc = await fleetRef.get();
    if (!fleetDoc.exists) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const update: Record<string, unknown> = {
      status,
      lastBootstrap: new Date().toISOString(),
    };

    if (actionRequired && typeof actionRequired === "object") {
      update.actionRequired = sanitizeActionRequired(actionRequired);
    }

    await fleetRef.update(update);

    return NextResponse.json({ success: true, status });
  } catch (err) {
    console.error(
      `[api/primes/${(await ctx.params).id}/fleet/update-status] POST error:`,
      err
    );
    return NextResponse.json({ error: "Failed to update status" }, { status: 500 });
  }
}

/**
 * Clamp the operator-facing banner a VM can raise: known shape, bounded length,
 * strings only. The dashboard renders this to a human, so an unattended caller
 * must not be able to write unbounded arbitrary content into it.
 */
function sanitizeActionRequired(raw: Record<string, unknown>) {
  const clamp = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";

  const instructions = Array.isArray(raw.instructions)
    ? raw.instructions
        .slice(0, MAX_INSTRUCTIONS)
        .map((i) => clamp(i, MAX_INSTRUCTION))
        .filter(Boolean)
    : [];

  return {
    type: clamp(raw.type, 64),
    title: clamp(raw.title, MAX_TITLE),
    instructions,
  };
}
