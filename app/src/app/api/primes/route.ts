import { NextRequest, NextResponse } from "next/server";
import { primesCol, type PrimeDoc } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { requireAuth } from "@/lib/require-auth";

/**
 * GET /api/primes — List all Prime instances
 */
export async function GET() {
  try {
    const snap = await primesCol().orderBy("createdAt", "desc").get();
    const primes = snap.docs
      .filter((doc) => doc.data().status !== "removed")
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.()?.toISOString() ?? null,
        updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() ?? null,
      }));
    return NextResponse.json({ primes });
  } catch (err) {
    console.error("[api/primes] GET error:", err);
    return NextResponse.json({ error: "Failed to list primes" }, { status: 500 });
  }
}

/**
 * POST /api/primes — Create a new Prime instance record
 * Body: { name, zone? }
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const body = await req.json();
    const { name, zone } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Check if exists — allow re-creation if previous teardown left a zombie doc
    const existing = await primesCol().doc(id).get();
    if (existing.exists) {
      const existingStatus = existing.data()?.status;
      const terminalStatuses = ["removed", "tearing_down", "error"];
      if (!terminalStatuses.includes(existingStatus)) {
        return NextResponse.json(
          { error: `Prime '${name}' already exists (status: ${existingStatus})` },
          { status: 409 }
        );
      }
      // Clean up the zombie doc and its subcollections before re-creating
      console.log(`[deploy] Cleaning up zombie prime doc '${id}' (status: ${existingStatus})`);
      const primeRef = primesCol().doc(id);
      const subcollections = [
        "fleet", "commands", "work", "work_archive", "intake",
        "messages", "projects", "processes", "approvals", "plans",
        "skill-proposals", "dispatch-log",
      ];
      for (const sub of subcollections) {
        try {
          const snap = await primeRef.collection(sub).limit(100).get();
          if (!snap.empty) {
            const batch = primeRef.firestore.batch();
            snap.docs.forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
          }
        } catch {}
      }
      await primeRef.delete();
      console.log(`[deploy] Zombie doc '${id}' cleaned up`);
    }

    const now = FieldValue.serverTimestamp();
    const doc: Omit<PrimeDoc, "id" | "createdAt" | "updatedAt"> & {
      createdAt: FirebaseFirestore.FieldValue;
      updatedAt: FirebaseFirestore.FieldValue;
    } = {
      name,
      status: "deploying",
      zone: zone || "us-central1-a",
      vmName: `prime-${id}`,
      coreRef: "main",
      createdAt: now,
      updatedAt: now,
    };

    await primesCol().doc(id).set(doc);

    return NextResponse.json({ id, name, status: "deploying" }, { status: 201 });
  } catch (err) {
    console.error("[api/primes] POST error:", err);
    return NextResponse.json({ error: "Failed to create prime" }, { status: 500 });
  }
}
