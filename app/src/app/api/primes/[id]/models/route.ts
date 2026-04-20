import { NextRequest, NextResponse } from "next/server";
import { getDb, commandsCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

/**
 * GET /api/primes/[id]/models — Returns model info for this prime.
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

    // Default model list
    const defaultModels = [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Preview)", tier: "preview", status: "unknown" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tier: "ga", status: "unknown" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "ga", status: "unknown" },
    ];

    // Merge cached statuses
    const cachedStatuses = settings?.modelStatuses || {};
    const models = defaultModels.map(m => ({
      ...m,
      status: cachedStatuses[m.id] || "unknown",
    }));

    return NextResponse.json({
      models,
      currentModel: settings?.defaultModel || "",
      projectId: process.env.GCP_PROJECT_ID || "",
      scannedAt: settings?.modelScannedAt || null,
    });
  } catch (err) {
    console.error("[api/models] GET error:", err);
    return NextResponse.json({ models: [], currentModel: "", projectId: "", scannedAt: null });
  }
}

/**
 * POST /api/primes/[id]/models — Set default model.
 * Body: { modelId: "gemini-2.5-pro" }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: primeId } = await params;
  try {
    const body = await req.json();
    const { modelId } = body;

    if (!modelId || typeof modelId !== "string") {
      return NextResponse.json({ success: false, error: "modelId is required" }, { status: 400 });
    }

    const db = getDb();

    // Save to per-prime settings
    await db
      .collection("primes").doc(primeId)
      .collection("config").doc("settings")
      .set({ defaultModel: modelId, modelUpdatedAt: new Date().toISOString() }, { merge: true });

    // Queue set_model command to Prime VM
    const cmdRef = await commandsCol(primeId).add({
      type: "set_model",
      args: { modelId },
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ success: true, commandId: cmdRef.id });
  } catch (err) {
    console.error("[api/models] POST error:", err);
    return NextResponse.json({ success: false, error: "Failed to save model setting" }, { status: 500 });
  }
}
