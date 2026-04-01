import { NextRequest, NextResponse } from "next/server";
import { primesCol, type PrimeDoc } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

/**
 * GET /api/primes — List all Prime instances
 */
export async function GET() {
  try {
    const snap = await primesCol().orderBy("createdAt", "desc").get();
    const primes = snap.docs.map((doc) => ({
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
    const body = await req.json();
    const { name, zone } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Check if exists
    const existing = await primesCol().doc(id).get();
    if (existing.exists) {
      return NextResponse.json(
        { error: `Prime '${name}' already exists` },
        { status: 409 }
      );
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
