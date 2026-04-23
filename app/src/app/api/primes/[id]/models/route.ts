import { NextRequest, NextResponse } from "next/server";
import { getDb, commandsCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

/**
 * GET /api/primes/[id]/models — Returns model catalog + assignments from Firestore.
 *
 * The catalog is populated dynamically by discover-models --probe-only
 * running on the Prime VM. No models are hardcoded here — scan first
 * to populate the list.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: primeId } = await params;
  try {
    const db = getDb();
    const settingsDoc = await db
      .collection("primes").doc(primeId)
      .collection("config").doc("settings")
      .get();

    const settings = settingsDoc.exists ? settingsDoc.data() : null;

    // Models come entirely from Firestore (populated by scan)
    const cachedModels = settings?.modelCatalog || [];

    return NextResponse.json({
      models: cachedModels,
      currentModel: settings?.defaultModel || "",
      projectId: process.env.GCP_PROJECT_ID || "",
      scannedAt: settings?.modelScannedAt || null,
      assignments: settings?.modelAssignments || null,
    });
  } catch (err) {
    console.error("[api/models] GET error:", err);
    return NextResponse.json({ models: [], currentModel: "", projectId: "", scannedAt: null, assignments: null });
  }
}

/**
 * POST /api/primes/[id]/models — Save model assignments (default + per-agent overrides).
 * Body:
 *   { defaultModel: "google-vertex/gemini-2.5-pro",
 *     assignments: { default: "google-vertex/gemini-2.5-pro", overrides: { "motor": "google-vertex/gemini-2.5-flash" } } }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: primeId } = await params;
  try {
    const body = await req.json();
    const { defaultModel, assignments } = body;

    if (!defaultModel || typeof defaultModel !== "string") {
      return NextResponse.json({ success: false, error: "defaultModel is required" }, { status: 400 });
    }

    const db = getDb();

    // Persist assignments in Firestore
    await db
      .collection("primes").doc(primeId)
      .collection("config").doc("settings")
      .set({
        defaultModel,
        modelAssignments: assignments || { default: defaultModel, overrides: {} },
        modelUpdatedAt: new Date().toISOString(),
      }, { merge: true });

    // Queue set_model command with full assignments payload
    const cmdRef = await commandsCol(primeId).add({
      type: "set_model",
      args: {
        modelId: defaultModel,
        assignments: JSON.stringify(assignments || { default: defaultModel, overrides: {} }),
      },
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ success: true, commandId: cmdRef.id });
  } catch (err) {
    console.error("[api/models] POST error:", err);
    return NextResponse.json({ success: false, error: "Failed to save model assignments" }, { status: 500 });
  }
}
