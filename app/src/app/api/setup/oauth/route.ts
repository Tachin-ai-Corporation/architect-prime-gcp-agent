import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { isAuthConfigured } from "@/lib/auth";

/**
 * POST /api/setup/oauth — Configure Google OAuth credentials
 *
 * Stores the client secret in Secret Manager, then updates the
 * Cloud Run service with all OAuth env vars. This triggers a
 * restart that enables authentication.
 *
 * Only works when running on GCP (needs metadata server).
 */
export async function POST(request: Request) {
  try {
    // If OAuth is already configured, require auth to reconfigure
    if (isAuthConfigured()) {
      const auth = await requireAuth();
      if (!auth.authenticated) return auth.response;
    }

    const { clientId, clientSecret, domain } = await request.json();

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { success: false, error: "Client ID and Client Secret are required" },
        { status: 400 }
      );
    }

    const projectId = process.env.GCP_PROJECT_ID || "";
    if (!projectId) {
      return NextResponse.json(
        { success: false, error: "GCP_PROJECT_ID not set" },
        { status: 500 }
      );
    }

    // Get SA token from metadata server
    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }
    );
    if (!tokenRes.ok) {
      return NextResponse.json({
        success: false,
        error: "Cannot get SA token. Are you running on GCP?",
      }, { status: 500 });
    }
    const { access_token: token } = await tokenRes.json();

    // Enable Secret Manager API
    await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/secretmanager.googleapis.com:enable`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    // Store client secret in Secret Manager
    const secretName = `projects/${projectId}/secrets/dashboard-oauth-secret`;
    const smBase = "https://secretmanager.googleapis.com/v1";

    // Try to create the secret first
    const createRes = await fetch(`${smBase}/projects/${projectId}/secrets?secretId=dashboard-oauth-secret`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replication: { automatic: {} },
      }),
    });

    // Add the secret version (whether creation succeeded or secret already exists)
    const secretPayload = Buffer.from(clientSecret).toString("base64");
    const versionRes = await fetch(
      `${smBase}/${secretName}:addVersion`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: { data: secretPayload },
        }),
      }
    );

    if (!versionRes.ok) {
      const errText = await versionRes.text();
      console.error("[api/setup/oauth] Secret version failed:", errText);
      return NextResponse.json({
        success: false,
        error: `Failed to store secret: ${versionRes.status}`,
      });
    }

    // Generate NextAuth secret
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const nextAuthSecret = Buffer.from(randomBytes).toString("base64");

    // Get the current service URL for NEXTAUTH_URL
    const currentUrl = process.env.NEXTAUTH_URL || request.headers.get("origin") || "";

    // Update Cloud Run service with OAuth env vars
    const region = process.env.REGION || "us-central1";
    const serviceName = process.env.SERVICE_NAME || "architect-prime";
    const runBase = `https://${region}-run.googleapis.com/apis/serving.knative.dev/v1`;

    // Get current service config
    const svcRes = await fetch(
      `${runBase}/namespaces/${projectId}/services/${serviceName}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!svcRes.ok) {
      return NextResponse.json({
        success: false,
        error: `Failed to get Cloud Run service: ${svcRes.status}`,
      });
    }

    const svc = await svcRes.json();
    const container = svc.spec?.template?.spec?.containers?.[0];
    if (!container) {
      return NextResponse.json({
        success: false,
        error: "Cannot find container spec in Cloud Run service",
      });
    }

    // Add/update OAuth env vars
    const env = container.env || [];
    const setEnv = (name: string, value: string) => {
      const idx = env.findIndex((e: { name: string }) => e.name === name);
      if (idx >= 0) {
        env[idx].value = value;
      } else {
        env.push({ name, value });
      }
    };

    setEnv("GOOGLE_CLIENT_ID", clientId);
    setEnv("NEXTAUTH_SECRET", nextAuthSecret);
    setEnv("NEXTAUTH_URL", currentUrl);
    if (domain) setEnv("ALLOWED_DOMAIN", domain);
    setEnv("NEXT_PUBLIC_AUTH_CONFIGURED", "true");

    // Add secret reference for client secret
    const secretIdx = env.findIndex((e: { name: string }) => e.name === "GOOGLE_CLIENT_SECRET");
    const secretRef = {
      name: "GOOGLE_CLIENT_SECRET",
      valueFrom: {
        secretKeyRef: {
          name: "dashboard-oauth-secret",
          key: "latest",
        },
      },
    };
    if (secretIdx >= 0) {
      env[secretIdx] = secretRef;
    } else {
      env.push(secretRef);
    }

    container.env = env;

    // Force new revision
    svc.spec.template.metadata = svc.spec.template.metadata || {};
    svc.spec.template.metadata.name = undefined; // Let Cloud Run generate a new name

    // Update the service
    const updateRes = await fetch(
      `${runBase}/namespaces/${projectId}/services/${serviceName}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(svc),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error("[api/setup/oauth] Service update failed:", errText);
      return NextResponse.json({
        success: false,
        error: `Failed to update Cloud Run service: ${updateRes.status}`,
      });
    }

    return NextResponse.json({
      success: true,
      message: "OAuth configured. The dashboard will restart with authentication enabled.",
    });
  } catch (err) {
    console.error("[api/setup/oauth] Error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
