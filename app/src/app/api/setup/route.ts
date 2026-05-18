import { NextRequest, NextResponse } from "next/server";
import { primesCol, getDb } from "@/lib/firestore";

/**
 * GET /api/setup — Returns the project's setup state.
 * Used by the frontend to drive the onboarding wizard.
 */
export async function GET() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    // TODO: The setup flow should also check for and automatically create the Firestore 
    // composite index on the `core_memory` collection group (status ASC, createdAt DESC).

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
      adminEmail: settings?.adminEmail || "",
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
 * Supports: agentEmailDomain, adminEmail
 * Auto-captures admin email from IAP header if not explicitly provided.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const db = getDb();

    const updates: Record<string, string> = {};
    if (typeof body.agentEmailDomain === "string") {
      updates.agentEmailDomain = body.agentEmailDomain.trim();
    }
    if (typeof body.adminEmail === "string") {
      updates.adminEmail = body.adminEmail.trim();
    }

    // Auto-capture admin email from IAP if not already set
    if (!updates.adminEmail) {
      const settingsDoc = await db.collection("config").doc("settings").get();
      const existing = settingsDoc.exists ? settingsDoc.data() : null;
      if (!existing?.adminEmail) {
        // IAP sets this header with the authenticated user's email
        const iapEmail = req.headers.get("x-goog-authenticated-user-email");
        if (iapEmail) {
          // IAP prefixes with "accounts.google.com:" — strip it
          updates.adminEmail = iapEmail.replace(/^accounts\.google\.com:/, "");
        }
      }
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
