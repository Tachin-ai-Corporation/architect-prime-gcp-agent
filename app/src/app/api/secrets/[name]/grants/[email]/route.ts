import { NextRequest, NextResponse } from "next/server";
import { secretsCol } from "@/lib/firestore";
import { revokeSecretAccess } from "@/lib/secret-manager";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ name: string; email: string }>;
}

/**
 * DELETE /api/secrets/[name]/grants/[email] — Revoke secret access from an agent
 *
 * The [email] param is the agent's workspace email (URL-encoded).
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { name, email } = await ctx.params;
    const agentEmail = decodeURIComponent(email);

    // Check secret exists
    const secretDoc = await secretsCol().doc(name).get();
    if (!secretDoc.exists) {
      return NextResponse.json({ error: `Secret '${name}' not found` }, { status: 404 });
    }

    // Find the grant to get the service account
    const secretData = secretDoc.data()!;
    const grants: Array<{ agentEmail: string; serviceAccount: string }> = secretData.grants || [];
    const grant = grants.find((g) => g.agentEmail === agentEmail);

    if (!grant) {
      return NextResponse.json(
        { error: `Agent '${agentEmail}' does not have access to secret '${name}'` },
        { status: 404 }
      );
    }

    // Remove IAM binding
    await revokeSecretAccess(name, grant.serviceAccount);

    // Remove grant from Firestore metadata
    const updatedGrants = grants.filter((g) => g.agentEmail !== agentEmail);
    await secretsCol().doc(name).update({ grants: updatedGrants });

    return NextResponse.json({ success: true, name, agentEmail });
  } catch (err) {
    console.error(`[api/secrets/revoke] DELETE error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to revoke access" },
      { status: 500 }
    );
  }
}
