import { NextRequest, NextResponse } from "next/server";
import { primesCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/teardown — Tear down a Prime VM
 *
 * Deletes the GCE VM and disk. Preserves the Firestore document
 * (messages, fleet history) for audit. Sets status to "removed".
 *
 * The Prime can be re-deployed later via POST /api/primes/[id]/deploy.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  try {
    // Get Prime config from Firestore
    const doc = await primesCol().doc(id).get();
    if (!doc.exists) {
      return NextResponse.json({ error: "Prime not found" }, { status: 404 });
    }

    const prime = doc.data()!;
    const projectId = process.env.GCP_PROJECT_ID!;
    const zone = prime.zone || "us-central1-a";
    const vmName = prime.vmName || `prime-${id}`;

    // Don't tear down if already removed
    if (prime.status === "removed") {
      return NextResponse.json({ error: "Prime already removed" }, { status: 400 });
    }

    // Update status to tearing_down
    await primesCol().doc(id).update({ status: "tearing_down" });

    // Delete the VM via Compute Engine REST API
    const token = await getAccessToken();
    const deleteResult = await deleteVM(token, projectId, zone, vmName);

    if (!deleteResult.ok) {
      const err = await deleteResult.text();
      // 404 = VM already deleted, treat as success
      if (deleteResult.status === 404) {
        console.log(`[teardown] VM ${vmName} already deleted (404)`);
      } else {
        console.error(`[teardown] VM deletion failed: ${err}`);
        await primesCol().doc(id).update({ status: "error" });
        return NextResponse.json(
          { error: "VM deletion failed", details: err },
          { status: 500 }
        );
      }
    }

    // Mark as removed (preserve doc for re-deploy and audit)
    await primesCol().doc(id).update({
      status: "removed",
      removedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      status: "removed",
      vmName,
      zone,
      message: `VM ${vmName} deletion is queued. Billing will stop within 1-2 minutes.`,
    });
  } catch (err) {
    console.error(`[teardown] Error:`, err);
    await primesCol().doc(id).update({ status: "error" }).catch(() => {});
    return NextResponse.json({ error: "Teardown failed" }, { status: 500 });
  }
}

/**
 * Get access token from the metadata server (Cloud Run SA).
 */
async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) {
    throw new Error("Cannot get access token — not running on GCP");
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Delete a GCE VM via the Compute Engine REST API.
 * Uses autoDelete disks — the boot disk is removed with the VM.
 */
async function deleteVM(
  token: string,
  projectId: string,
  zone: string,
  vmName: string
): Promise<Response> {
  return fetch(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${vmName}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
}
