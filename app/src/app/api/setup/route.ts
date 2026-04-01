import { NextResponse } from "next/server";
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
    });
  } catch (err) {
    console.error("[api/setup] Error:", err);
    return NextResponse.json({
      hasPrimes: false,
      dwdConfigured: false,
      projectId: process.env.GCP_PROJECT_ID || "",
      dwdSignerSA: "",
      dwdClientId: "",
    });
  }
}
