import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { getDb } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string; agent: string }>;
}

/**
 * POST /api/primes/[id]/fleet/[agent]/introspect — Submit an introspection query
 *
 * Body: { type: "skills" | "status" | "config" | "workspace" }
 *
 * Creates a Firestore doc in primes/{id}/fleet/{agent}/introspect/{queryId}
 * with status: "pending". The agent-side daemon picks it up, fills the result,
 * and sets status: "complete".
 *
 * Returns the queryId. The client polls GET with this queryId.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id, agent } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const type = body?.type;

  const VALID_TYPES = ["skills", "status", "config", "workspace", "brain_config", "set_model", "responsibilities", "set_responsibility_enabled"];
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const db = getDb();
    const queryRef = db
      .collection("primes")
      .doc(id)
      .collection("fleet")
      .doc(agent)
      .collection("introspect")
      .doc();

    const doc: Record<string, unknown> = {
      type,
      status: "pending",
      requestedAt: FieldValue.serverTimestamp(),
    };

    // Pass through params for set_model (model assignments payload)
    if (body?.params && typeof body.params === "object") {
      doc.params = body.params;
    }

    await queryRef.set(doc);

    return NextResponse.json({
      queryId: queryRef.id,
      status: "pending",
    });
  } catch (err) {
    console.error(`[api/introspect] POST error:`, err);
    return NextResponse.json(
      { error: "Failed to submit introspection query" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/primes/[id]/fleet/[agent]/introspect?queryId=xxx — Poll for result
 *
 * Returns the current status. If complete, includes the result.
 * Client should poll until status === "complete" or "error".
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id, agent } = await ctx.params;
  const queryId = req.nextUrl.searchParams.get("queryId");

  if (!queryId) {
    return NextResponse.json({ error: "queryId required" }, { status: 400 });
  }

  try {
    const db = getDb();
    const doc = await db
      .collection("primes")
      .doc(id)
      .collection("fleet")
      .doc(agent)
      .collection("introspect")
      .doc(queryId)
      .get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Query not found" }, { status: 404 });
    }

    const data = doc.data()!;

    // Decode Firestore map values to plain objects
    const result = data.status === "complete" ? decodeFirestoreValue(data.result) : null;

    return NextResponse.json({
      queryId,
      type: data.type,
      status: data.status,
      result,
      error: data.error || null,
      requestedAt: data.requestedAt?.toDate?.()?.toISOString() || null,
      completedAt: data.completedAt?.toDate?.()?.toISOString() || null,
    });
  } catch (err) {
    console.error(`[api/introspect] GET error:`, err);
    return NextResponse.json(
      { error: "Failed to fetch query result" },
      { status: 500 }
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeFirestoreValue(val: any): any {
  if (val === null || val === undefined) return null;
  // Already decoded by Firestore SDK — just return as-is
  return val;
}
