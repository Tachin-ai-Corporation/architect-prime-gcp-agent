import { NextResponse } from "next/server";

/**
 * GET /api/upgrade — Check current and latest CoreKit version
 *
 * Reads current from the installed manifest, latest from GitHub.
 */
export async function GET() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    const ghOwner = process.env.GH_OWNER || "Tachin-ai-Corporation";
    const ghRepo = process.env.GH_REPO || "architect-prime-gcp-agent";

    // Current version: from the latest git tag we're running
    // In Cloud Run, we bake this at build time via package.json or env
    const currentVersion = process.env.APP_VERSION || "dev";

    // Latest version: check GitHub for latest tag
    let latestVersion = "unknown";
    let latestSha = "";
    try {
      const res = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/tags?per_page=1`,
        { headers: { Accept: "application/vnd.github.v3+json" }, next: { revalidate: 300 } }
      );
      if (res.ok) {
        const tags = await res.json();
        if (tags.length > 0) {
          latestVersion = tags[0].name;
          latestSha = tags[0].commit?.sha?.substring(0, 7) || "";
        }
      }
    } catch {
      // GitHub API may be unavailable
    }

    const updateAvailable = latestVersion !== "unknown" &&
                            currentVersion !== latestVersion &&
                            currentVersion !== "dev";

    return NextResponse.json({
      currentVersion,
      latestVersion,
      latestSha,
      updateAvailable,
      projectId,
    });
  } catch (err) {
    console.error("[api/upgrade] GET error:", err);
    return NextResponse.json(
      { error: "Failed to check version" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/upgrade — Trigger CoreKit upgrade on Prime VM
 *
 * Sends an upgrade command to the Prime via Firestore message.
 * Optionally triggers Cloud Run redeployment.
 */
export async function POST() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";

    // Get Cloud Run SA token
    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }
    );

    if (!tokenRes.ok) {
      return NextResponse.json({
        success: false,
        error: "Cannot get SA token. Are you running on GCP?",
      });
    }

    const { access_token: token } = await tokenRes.json();

    // Trigger Cloud Run service update by deploying the latest image
    // This forces Cloud Run to pull the latest :latest tag
    const ghOwner = process.env.GH_OWNER || "Tachin-ai-Corporation";
    const ghRepo = process.env.GH_REPO || "architect-prime-gcp-agent";
    const region = process.env.REGION || "us-central1";
    const serviceName = "architect-prime";
    const image = `us-docker.pkg.dev/${projectId}/architect-prime/control-plane:latest`;

    // Update the Cloud Run service to use the latest image
    // This is a PATCH to the Cloud Run v2 API
    const updateRes = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}?updateMask=template.containers`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template: {
            containers: [{ image }],
          },
        }),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.text();
      console.error(`[api/upgrade] Cloud Run update failed: ${err}`);
      return NextResponse.json({
        success: false,
        error: "Cloud Run update failed",
        details: err,
      });
    }

    return NextResponse.json({
      success: true,
      message: `Upgrade initiated. Cloud Run will pull the latest image (${image}). Prime VMs will upgrade via upgrade-corekit on next poll.`,
      ghOwner,
      ghRepo,
    });
  } catch (err) {
    console.error("[api/upgrade] POST error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to trigger upgrade" },
      { status: 500 }
    );
  }
}
