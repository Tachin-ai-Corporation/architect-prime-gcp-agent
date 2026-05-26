import { NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

/**
 * GET /api/models — Returns project-wide model catalog from Firestore.
 * Reads from config/models (populated by POST /api/models/scan).
 */
export async function GET() {
  try {
    const db = getDb();
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
    });
  }
}
