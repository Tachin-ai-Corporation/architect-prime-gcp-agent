import { NextResponse } from "next/server";

/**
 * GET /api/upgrade — Check current and latest version
 *
 * Current: from APP_VERSION env var (set during Cloud Run deploy)
 * Latest: from GitHub tags API
 */
export async function GET() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    const ghOwner = process.env.GH_OWNER || "Tachin-ai-Corporation";
    const ghRepo = process.env.GH_REPO || "architect-prime-gcp-agent";
    const currentVersion = process.env.APP_VERSION || "dev";

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
 * POST /api/upgrade — Full dashboard upgrade via Cloud Build
 *
 * Triggers Cloud Build to:
 *   1. Clone the repo at the latest tag
 *   2. Build the Docker image
 *   3. Push to Artifact Registry
 *   4. Deploy to Cloud Run with correct APP_VERSION
 *
 * Returns immediately — build runs async (~2-3 min).
 */
export async function POST() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    const ghOwner = process.env.GH_OWNER || "Tachin-ai-Corporation";
    const ghRepo = process.env.GH_REPO || "architect-prime-gcp-agent";
    const region = process.env.REGION || "us-central1";
    const serviceName = process.env.SERVICE_NAME || "architect-prime";
    const image = `us-docker.pkg.dev/${projectId}/architect-prime/control-plane:latest`;
    const repoUrl = `https://github.com/${ghOwner}/${ghRepo}.git`;

    // Get SA token
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

    // Get latest version tag
    let latestVersion = "dev";
    try {
      const tagRes = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/tags?per_page=1`,
        { headers: { Accept: "application/vnd.github.v3+json" } }
      );
      if (tagRes.ok) {
        const tags = await tagRes.json();
        if (tags.length > 0) latestVersion = tags[0].name;
      }
    } catch {
      // GitHub API may be unavailable
    }

    if (latestVersion === "dev") {
      return NextResponse.json({
        success: false,
        error: "Could not determine latest version from GitHub tags.",
      });
    }

    // Preserve existing DWD_CLIENT_ID from current env
    const dwdClientId = process.env.DWD_CLIENT_ID || "";

    // Submit Cloud Build: clone → build → push → deploy
    const buildConfig = {
      steps: [
        {
          name: "gcr.io/cloud-builders/git",
          args: [
            "clone", "--depth=1", "--branch", latestVersion,
            repoUrl, "/workspace/repo",
          ],
        },
        {
          name: "gcr.io/cloud-builders/docker",
          args: ["build", "-t", image, "/workspace/repo/app"],
        },
        {
          name: "gcr.io/cloud-builders/docker",
          args: ["push", image],
        },
        {
          name: "gcr.io/google.com/cloudsdktool/cloud-sdk",
          entrypoint: "gcloud",
          args: [
            "run", "deploy", serviceName,
            "--image", image,
            "--region", region,
            "--update-env-vars",
            `APP_VERSION=${latestVersion},GCP_PROJECT_ID=${projectId},NODE_ENV=production${dwdClientId ? `,DWD_CLIENT_ID=${dwdClientId}` : ""}`,
            "--quiet",
          ],
        },
      ],
      images: [image],
      timeout: "600s",
      options: {
        logging: "CLOUD_LOGGING_ONLY",
      },
    };

    const buildRes = await fetch(
      `https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildConfig),
      }
    );

    if (!buildRes.ok) {
      const errText = await buildRes.text();
      console.error(`[api/upgrade] Cloud Build submit failed (${buildRes.status}):`, errText);

      // Provide actionable error messages
      if (buildRes.status === 403) {
        return NextResponse.json({
          success: false,
          error: "Permission denied. The Cloud Run service account needs roles/cloudbuild.builds.editor. " +
                 "Run: gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:SA --role=roles/cloudbuild.builds.editor",
        });
      }

      return NextResponse.json({
        success: false,
        error: `Cloud Build failed (${buildRes.status})`,
        details: errText.substring(0, 500),
      });
    }

    const buildData = await buildRes.json();
    const buildId = buildData?.metadata?.build?.id || buildData?.name || "unknown";

    console.log(`[api/upgrade] Cloud Build submitted: ${buildId} → ${latestVersion}`);

    return NextResponse.json({
      success: true,
      message: `Build triggered for ${latestVersion}. The dashboard will upgrade automatically in ~3 minutes.`,
      buildId,
      version: latestVersion,
    });
  } catch (err) {
    console.error("[api/upgrade] POST error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to trigger upgrade" },
      { status: 500 }
    );
  }
}
