import { NextRequest, NextResponse } from "next/server";
import { primesCol, getDb } from "@/lib/firestore";

/**
 * GET /api/setup — Returns the project's setup state.
 * Used by the frontend to drive the onboarding wizard.
 */
export async function GET() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";

    // Check if any Primes exist
    const primesSnap = await primesCol().limit(1).get();
    const hasPrimes = !primesSnap.empty;

    // Check for DWD config in Firestore
    const configDoc = await getDb().collection("config").doc("dwd").get();
    const dwdConfig = configDoc.exists ? configDoc.data() : null;

    // Check for settings
    const settingsDoc = await getDb().collection("config").doc("settings").get();
    const settings = settingsDoc.exists ? settingsDoc.data() : null;

    // Derive DWD signer SA email from project
    const dwdSignerSA = `dwd-signer@${projectId}.iam.gserviceaccount.com`;

    // Try to get the SA's unique ID (client ID for DWD)
    // This is set during install by deploy/install.sh
    const dwdClientId = dwdConfig?.clientId || process.env.DWD_CLIENT_ID || "";

    return NextResponse.json({
      hasPrimes,
      dwdConfigured: dwdConfig?.configured === true,
      projectId,
      dwdSignerSA,
      dwdClientId,
      agentEmailDomain: settings?.agentEmailDomain || "",
    });
  } catch (err) {
    console.error("[api/setup] Error:", err);
    return NextResponse.json({
      hasPrimes: false,
      dwdConfigured: false,
      projectId: process.env.GCP_PROJECT_ID || "",
      dwdSignerSA: "",
      dwdClientId: "",
      agentEmailDomain: "",
    });
  }
}

/**
 * POST /api/setup — Save setup settings.
 * Currently supports: agentEmailDomain
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const db = getDb();

    const updates: Record<string, string> = {};
    if (typeof body.agentEmailDomain === "string") {
      updates.agentEmailDomain = body.agentEmailDomain.trim();
    }

    if (Object.keys(updates).length > 0) {
      await db.collection("config").doc("settings").set(updates, { merge: true });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/setup] POST error:", err);
    return NextResponse.json({ success: false, error: "Failed to save settings" }, { status: 500 });
  }
}
