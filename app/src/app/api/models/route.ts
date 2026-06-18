import { NextRequest, NextResponse } from "next/server";
import { getDb, commandsCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { requireAuth } from "@/lib/require-auth";

/**
 * GET /api/models — Returns project-wide or prime-scoped model catalog from Firestore.
 * Query: ?primeId=xxx
 */
export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    const url = new URL(req.url);
    const primeId = url.searchParams.get("primeId");

    if (primeId) {
      // Prime-scoped settings
      const settingsDoc = await db
        .collection("primes").doc(primeId)
        .collection("config").doc("settings")
        .get();

      const settings = settingsDoc.exists ? settingsDoc.data() : null;
      const cachedModels = settings?.modelCatalog || [];

      return NextResponse.json({
        models: cachedModels,
        currentModel: settings?.defaultModel || "",
        projectId: process.env.GCP_PROJECT_ID || "",
        scannedAt: settings?.modelScannedAt || null,
        assignments: settings?.modelAssignments || null,
      });
    }

    // Project-wide models
    const doc = await db.collection("config").doc("models").get();
    const data = doc.exists ? doc.data() : null;

    return NextResponse.json({
      models: data?.modelCatalog || [],
      currentModel: data?.bestAvailableModel || "",
      projectId: process.env.GCP_PROJECT_ID || "",
      scannedAt: data?.modelScannedAt || null,
      gardenTotal: data?.gardenTotal || 0,
    });
  } catch (err) {
    console.error("[api/models] GET error:", err);
    return NextResponse.json({
      models: [],
      currentModel: "",
      projectId: "",
      scannedAt: null,
      gardenTotal: 0,
      assignments: null,
    });
  }
}

/**
 * POST /api/models — Save model assignments (default + per-agent overrides).
 * Query: ?primeId=xxx
 */
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const primeId = url.searchParams.get("primeId");

    if (!primeId) {
      return NextResponse.json({ success: false, error: "primeId parameter required for updates" }, { status: 400 });
    }

    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

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
