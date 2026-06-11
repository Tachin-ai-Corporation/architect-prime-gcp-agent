import { NextRequest, NextResponse } from "next/server";
import { secretsCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { createSecret as smCreate } from "@/lib/secret-manager";
import { requireAuth } from "@/lib/require-auth";

/**
 * GET /api/secrets — List all secrets (metadata only, never values)
 */
export async function GET() {
  try {
    const snap = await secretsCol().orderBy("createdAt", "desc").get();
    const secrets = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        name: data.name,
        description: data.description,
        secretManagerName: data.secretManagerName,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        createdBy: data.createdBy || "",
        grants: (data.grants || []).map((g: Record<string, unknown>) => ({
          agentEmail: g.agentEmail,
          serviceAccount: g.serviceAccount,
          grantedAt: (g.grantedAt as FirebaseFirestore.Timestamp)?.toDate?.()?.toISOString() || null,
          grantedBy: g.grantedBy || "",
        })),
      };
    });
    return NextResponse.json({ secrets });
  } catch (err) {
    console.error("[api/secrets] GET error:", err);
    return NextResponse.json({ error: "Failed to list secrets" }, { status: 500 });
  }
}

/**
 * POST /api/secrets — Create a new secret
 * Body: { name: string, description: string, value: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { name, description, value } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!value || typeof value !== "string") {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }

    // Validate name format (slug: lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return NextResponse.json(
        { error: "name must be lowercase alphanumeric with hyphens (e.g., 'github-token')" },
        { status: 400 }
      );
    }

    // Check if already exists
    const existing = await secretsCol().doc(name).get();
    if (existing.exists) {
      return NextResponse.json({ error: `Secret '${name}' already exists` }, { status: 409 });
    }

    // Create in Secret Manager
    await smCreate(name, value);

    // Write metadata to Firestore (value never stored here)
    await secretsCol().doc(name).set({
      name,
      description: description || "",
      secretManagerName: `aps-secret-${name}`,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: auth.session?.user?.email || "unknown",
      grants: [],
    });

    return NextResponse.json({ success: true, name });
  } catch (err) {
    console.error("[api/secrets] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create secret" },
      { status: 500 }
    );
  }
}
