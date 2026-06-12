import { NextRequest, NextResponse } from "next/server";
import { secretsCol, primesCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { grantSecretAccess, deriveServiceAccount } from "@/lib/secret-manager";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ name: string }>;
}

/**
 * POST /api/secrets/[name]/grants — Grant secret access to an agent
 * Body: { agentEmail: string }
 *
 * Resolves agent email → fleet doc → derives SA → adds IAM binding
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { name } = await ctx.params;
    const body = await req.json();
    const { agentEmail } = body;

    if (!agentEmail || typeof agentEmail !== "string") {
      return NextResponse.json({ error: "agentEmail is required" }, { status: 400 });
    }

    // Check secret exists
    const secretDoc = await secretsCol().doc(name).get();
    if (!secretDoc.exists) {
      return NextResponse.json({ error: `Secret '${name}' not found` }, { status: 404 });
    }

    // Check if already granted
    const secretData = secretDoc.data()!;
    const existingGrant = (secretData.grants || []).find(
      (g: { agentEmail: string }) => g.agentEmail === agentEmail
    );
    if (existingGrant) {
      return NextResponse.json({ error: `Agent '${agentEmail}' already has access` }, { status: 409 });
    }

    // Find the agent across all primes to resolve their name
    const primesSnap = await primesCol().get();
    let agentName: string | null = null;

    for (const primeDoc of primesSnap.docs) {
      const fleetSnap = await primeDoc.ref.collection("fleet")
        .where("email", "==", agentEmail)
        .limit(1)
        .get();
      if (!fleetSnap.empty) {
        agentName = fleetSnap.docs[0].id;
        break;
      }
    }

    if (!agentName) {
      return NextResponse.json(
        { error: `No fleet agent found with email '${agentEmail}'` },
        { status: 404 }
      );
    }

    // Derive service account from agent name
    const serviceAccount = deriveServiceAccount(agentName);

    // Add IAM binding on the SM secret
    await grantSecretAccess(name, serviceAccount);

    // Append grant to Firestore metadata
    await secretsCol().doc(name).update({
      grants: FieldValue.arrayUnion({
        agentEmail,
        serviceAccount,
        grantedAt: new Date(),
        grantedBy: (auth.session as { user?: { email?: string } } | null)?.user?.email || "unknown",
      }),
    });

    return NextResponse.json({ success: true, name, agentEmail, serviceAccount });
  } catch (err) {
    console.error(`[api/secrets/${(await ctx.params).name}/grants] POST error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to grant access" },
      { status: 500 }
    );
  }
}
