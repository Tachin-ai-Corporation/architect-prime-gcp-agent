import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";

// Per-prime "effort" — the dispatch-temperature latitude knob read by the brain daemon at
// primes/{primeId}/config/settings.effort (refreshed on a throttled cadence, no restart needed).
const LEVELS: string[] = ["low", "medium", "high", "max"];

/** GET /api/effort?primeId=xxx — a prime's current effort (default 'medium'). */
export async function GET(req: NextRequest) {
  try {
    const primeId = new URL(req.url).searchParams.get("primeId");
    if (!primeId) return NextResponse.json({ effort: "medium" });
    const db = getDb();
    const doc = await db
      .collection("primes").doc(primeId)
      .collection("config").doc("settings")
      .get();
    const raw = doc.exists ? (doc.data()?.effort as string | undefined) : undefined;
    const effort = raw && LEVELS.includes(raw) ? raw : "medium";
    return NextResponse.json({ effort });
  } catch (err) {
    console.error("[api/effort] GET error:", err);
    return NextResponse.json({ effort: "medium" });
  }
}

/** POST /api/effort?primeId=xxx  { effort } — set a prime's effort (low|medium|high|max). */
export async function POST(req: NextRequest) {
  try {
    const primeId = new URL(req.url).searchParams.get("primeId");
    if (!primeId) {
      return NextResponse.json({ success: false, error: "primeId parameter required" }, { status: 400 });
    }
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const body = await req.json();
    const effort = body?.effort as string | undefined;
    if (!effort || !LEVELS.includes(effort)) {
      return NextResponse.json(
        { success: false, error: `effort must be one of: ${LEVELS.join(", ")}` },
        { status: 400 },
      );
    }

    const db = getDb();
    await db
      .collection("primes").doc(primeId)
      .collection("config").doc("settings")
      .set({ effort, effortUpdatedAt: new Date().toISOString() }, { merge: true });

    return NextResponse.json({ success: true, effort });
  } catch (err) {
    console.error("[api/effort] POST error:", err);
    return NextResponse.json({ success: false, error: "Failed to set effort" }, { status: 500 });
  }
}
