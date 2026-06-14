import { NextRequest, NextResponse } from "next/server";
import { primesCol, commandsCol } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";
import { FieldValue } from "@google-cloud/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/teardown — Tear down a Prime VM
 *
 * Deletes the GCE VM and disk, then deletes the Firestore document
 * and its subcollections. This is a full teardown — redeployment
 * goes through the standard onboarding flow.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  // Declare outside try so catch block can update on failure
  let cmdRef: FirebaseFirestore.DocumentReference | null = null;

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

    // Log operation in commands collection for ops queue visibility
    cmdRef = commandsCol(id).doc();
    await cmdRef.set({
      type: "prime_teardown",
      args: { vmName, zone },
      status: "running",
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`[teardown] Command logged: ${cmdRef.id} for prime ${id}`);

    // Delete the VM via Compute Engine REST API
    // Always continue to Firestore cleanup even if this fails
    let vmDeleted = false;
    try {
      const token = await getAccessToken();
      const deleteResult = await deleteVM(token, projectId, zone, vmName);

      if (deleteResult.ok) {
        vmDeleted = true;
        console.log(`[teardown] VM ${vmName} deletion initiated`);
      } else if (deleteResult.status === 404) {
        // VM already deleted — treat as success
        vmDeleted = true;
        console.log(`[teardown] VM ${vmName} already deleted (404)`);
      } else {
        const errText = await deleteResult.text();
        console.error(`[teardown] VM deletion failed (${deleteResult.status}): ${errText}`);
        // Continue with Firestore cleanup — don't leave orphaned docs
      }
    } catch (vmErr) {
      console.error(`[teardown] VM deletion error:`, vmErr);
      // Continue with Firestore cleanup
    }

    // Delete all subcollections then the prime doc itself
    const primeRef = primesCol().doc(id);
    const subcollections = [
      "fleet", "commands", "work", "work_archive", "intake",
      "messages", "projects", "processes", "approvals", "plans",
      "skill-proposals", "dispatch-log",
    ];
    for (const sub of subcollections) {
      try {
        await deleteCollection(primeRef.collection(sub));
      } catch (subErr) {
        console.error(`[teardown] Failed to delete subcollection ${sub}:`, subErr);
        // Continue cleaning other subcollections
      }
    }
    await primeRef.delete();
    console.log(`[teardown] Firestore doc and subcollections deleted for prime ${id}`);

    return NextResponse.json({
      success: true,
      status: "removed",
      vmName,
      zone,
      vmDeleted,
      message: vmDeleted
        ? `VM ${vmName} deleted. Firestore cleaned. Billing stops within 1-2 minutes.`
        : `VM ${vmName} deletion failed but Firestore cleaned. Check GCE console for orphaned VM.`,
    });
  } catch (err) {
    console.error(`[teardown] Error:`, err);
    // Best-effort: try to delete the doc anyway so re-deploy isn't blocked
    try {
      await primesCol().doc(id).delete();
      console.log(`[teardown] Cleaned up prime doc ${id} despite error`);
    } catch {}
    // Try to update the command status to failed
    try {
      if (cmdRef) {
        await cmdRef.update({
          status: "failed",
          error: err instanceof Error ? err.message : "Unknown error",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    } catch {} // best-effort
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

/**
 * Delete all documents in a Firestore collection (batch delete).
 */
async function deleteCollection(collectionRef: FirebaseFirestore.CollectionReference) {
  const batchSize = 100;
  let deleted = 0;
  for (;;) {
    const snapshot = await collectionRef.limit(batchSize).get();
    if (snapshot.empty) break;
    const batch = collectionRef.firestore.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snapshot.size;
  }
  if (deleted > 0) {
    console.log(`[teardown] Deleted ${deleted} docs from ${collectionRef.path}`);
  }
}
