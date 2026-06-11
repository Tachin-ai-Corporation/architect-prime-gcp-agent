import { NextRequest, NextResponse } from "next/server";
import { secretsCol } from "@/lib/firestore";
import { rotateSecret, deleteSecret as smDelete } from "@/lib/secret-manager";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ name: string }>;
}

/**
 * PUT /api/secrets/[name] — Rotate a secret (add new version)
 * Body: { value: string }
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { name } = await ctx.params;
    const body = await req.json();
    const { value } = body;

    if (!value || typeof value !== "string") {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }

    // Check exists
    const doc = await secretsCol().doc(name).get();
    if (!doc.exists) {
      return NextResponse.json({ error: `Secret '${name}' not found` }, { status: 404 });
    }

    // Rotate in Secret Manager
    await rotateSecret(name, value);

    return NextResponse.json({ success: true, name });
  } catch (err) {
    console.error(`[api/secrets/${(await ctx.params).name}] PUT error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to rotate secret" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/secrets/[name] — Destroy a secret
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { name } = await ctx.params;

    // Check exists
    const doc = await secretsCol().doc(name).get();
    if (!doc.exists) {
      return NextResponse.json({ error: `Secret '${name}' not found` }, { status: 404 });
    }

    // Delete from Secret Manager (also revokes all IAM bindings on the resource)
    await smDelete(name);

    // Delete Firestore metadata
    await secretsCol().doc(name).delete();

    return NextResponse.json({ success: true, name });
  } catch (err) {
    console.error(`[api/secrets/${(await ctx.params).name}] DELETE error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete secret" },
      { status: 500 }
    );
  }
}
