import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

/**
 * POST /api/setup/dwd-test — Test DWD configuration
 *
 * Attempts to sign a JWT using the DWD signer SA to verify
 * that Domain-Wide Delegation is properly configured.
 *
 * Body: { email } — Workspace email to test impersonation for
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const body = await req.json();
    const testEmail = body.email;
    const projectId = process.env.GCP_PROJECT_ID || "";
    const dwdSignerSA = `dwd-signer@${projectId}.iam.gserviceaccount.com`;

    if (!testEmail) {
      return NextResponse.json(
        { error: "email is required" },
        { status: 400 }
      );
    }

    // Step 1: Get access token for the Cloud Run SA
    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }
    );

    if (!tokenRes.ok) {
      return NextResponse.json({
        success: false,
        step: "token",
        error: "Cannot get Cloud Run SA token. Are you running on GCP?",
      });
    }

    const { access_token: token } = await tokenRes.json();

    // Step 2: Try to sign a JWT using the DWD signer SA
    // This validates that:
    //   a) The signer SA exists
    //   b) Cloud Run SA has signJwt permission on it
    const now = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      iss: dwdSignerSA,
      sub: testEmail,
      scope: "https://www.googleapis.com/auth/chat.messages",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 60,
    };

    const signRes = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${dwdSignerSA}:signJwt`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: JSON.stringify(jwtPayload),
        }),
      }
    );

    if (!signRes.ok) {
      const err = await signRes.text();
      return NextResponse.json({
        success: false,
        step: "signJwt",
        error: `Cannot sign JWT with ${dwdSignerSA}. Ensure the Cloud Run SA has roles/iam.serviceAccountTokenCreator on the signer SA.`,
        details: err,
      });
    }

    const { signedJwt } = await signRes.json();

    // Step 3: Exchange the signed JWT for an access token
    // This validates that DWD is actually configured in the Admin Console
    const exchangeRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedJwt,
      }),
    });

    if (!exchangeRes.ok) {
      const err = await exchangeRes.json();
      const errorDesc = err.error_description || err.error || "Unknown error";

      return NextResponse.json({
        success: false,
        step: "exchange",
        error: `DWD token exchange failed for ${testEmail}. ${errorDesc}`,
        hint: errorDesc.includes("unauthorized_client")
          ? "DWD is not configured in Google Admin Console. Go to Security → API Controls → Domain-Wide Delegation and add the Client ID with the required scopes."
          : errorDesc.includes("invalid_grant")
            ? `The email ${testEmail} may not exist as a Workspace user, or the scopes may not be authorized.`
            : "Check the DWD configuration in Google Admin Console.",
      });
    }

    // Success! DWD is working — persist to Firestore
    try {
      const { Firestore } = await import("@google-cloud/firestore");
      const db = new Firestore({
        projectId: process.env.GCP_PROJECT_ID,
        databaseId: process.env.FIRESTORE_DATABASE || "(default)",
      });
      await db.collection("config").doc("dwd").set({
        configured: true,
        lastVerified: new Date().toISOString(),
        verifiedEmail: testEmail,
        signerSA: dwdSignerSA,
      }, { merge: true });
    } catch (persistErr) {
      console.warn("[api/setup/dwd-test] Failed to persist DWD state:", persistErr);
      // Non-fatal: DWD test passed even if persistence fails
    }

    return NextResponse.json({
      success: true,
      email: testEmail,
      signerSA: dwdSignerSA,
      message: `DWD is working! Successfully obtained a token impersonating ${testEmail}.`,
    });
  } catch (err) {
    console.error("[api/setup/dwd-test] Error:", err);
    return NextResponse.json(
      {
        success: false,
        step: "internal",
        error: "Internal error testing DWD",
      },
      { status: 500 }
    );
  }
}
