import { NextRequest, NextResponse } from "next/server";
import { primesCol, getDb } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";
import { isAuthConfigured } from "@/lib/auth";

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

    // Read artifacts root folder from app-level settings
    let artifactsRootFolderId = settings?.artifacts_root_folder_id || "";

    // Migration: if not in config/settings yet, check legacy per-prime location
    if (!artifactsRootFolderId && hasPrimes) {
      const legacyId = primesSnap.docs[0].data()?.artifacts_root_folder_id;
      if (legacyId) {
        artifactsRootFolderId = legacyId;
        // Migrate to config/settings so it survives prime teardown
        await getDb().collection("config").doc("settings").set(
          { artifacts_root_folder_id: legacyId }, { merge: true }
        );
        console.log(`[setup] Migrated artifacts_root_folder_id to config/settings`);
      }
    }

    return NextResponse.json({
      hasPrimes,
      dwdConfigured: dwdConfig?.configured === true,
      authConfigured: isAuthConfigured(),
      projectId,
      dwdSignerSA,
      dwdClientId,
      agentEmailDomain: settings?.agentEmailDomain || "",
      adminEmail: settings?.adminEmail || "",
      artifactsRootFolderId,
    });
  } catch (err) {
    console.error("[api/setup] Error:", err);
    return NextResponse.json({
      hasPrimes: false,
      dwdConfigured: false,
      authConfigured: false,
      projectId: process.env.GCP_PROJECT_ID || "",
      dwdSignerSA: "",
      dwdClientId: "",
      agentEmailDomain: "",
      artifactsRootFolderId: "",
    });
  }
}

/**
 * POST /api/setup — Save setup settings.
 * Supports: agentEmailDomain, adminEmail, artifactsRootFolderId
 * All settings saved to config/settings (app-level, survives prime teardown).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

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
    if (typeof body.artifactsRootFolderId === "string") {
      updates.artifacts_root_folder_id = body.artifactsRootFolderId.trim();
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
