import { NextResponse } from "next/server";

const GH_OWNER = "Tachin-ai-Corporation";
const GH_REPO = "architect-prime-gcp-agent";

/**
 * GET /api/upgrade — Check current and latest version
 *
 * Version detection strategy:
 *   - currentVersion: APP_VERSION env var (set during Cloud Run deploy)
 *   - latestTag: most recent git tag (e.g. v4.0.1)
 *   - latestCommit: HEAD of main branch
 *   - updateAvailable: true if either latestTag > currentVersion
 *     OR main HEAD differs from the deployed commit
 *
 * This ensures the "Upgrade Dashboard" button is always actionable
 * when new code has been pushed, even before tagging.
 */
export async function GET() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    const ghOwner = process.env.GH_OWNER || GH_OWNER;
    const ghRepo = process.env.GH_REPO || GH_REPO;
    const currentVersion = process.env.APP_VERSION || "dev";
    const deployedCommit = process.env.APP_COMMIT || "";

    let latestTag = "unknown";
    let latestTagSha = "";
    let mainHeadSha = "";

    // Fetch latest tag
    try {
      const res = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/tags?per_page=1`,
        { headers: { Accept: "application/vnd.github.v3+json" }, next: { revalidate: 60 } }
      );
      if (res.ok) {
        const tags = await res.json();
        if (tags.length > 0) {
          latestTag = tags[0].name;
          latestTagSha = tags[0].commit?.sha?.substring(0, 7) || "";
        }
      }
    } catch {
      // GitHub API may be unavailable
    }

    // Fetch HEAD of main branch
    try {
      const res = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/commits/main`,
        { headers: { Accept: "application/vnd.github.v3+json" }, next: { revalidate: 60 } }
      );
      if (res.ok) {
        const commit = await res.json();
        mainHeadSha = commit.sha?.substring(0, 7) || "";
      }
    } catch {
      // GitHub API may be unavailable
    }

    // Update is available if:
    //   1. There's a newer tag than what's deployed, OR
    //   2. main HEAD is different from the deployed commit
    const tagDiffers = latestTag !== "unknown" &&
                       currentVersion !== latestTag &&
                       currentVersion !== "dev";
    const commitDiffers = mainHeadSha !== "" &&
                          deployedCommit !== "" &&
                          mainHeadSha !== deployedCommit;
    const updateAvailable = tagDiffers || commitDiffers ||
                            (mainHeadSha !== "" && deployedCommit === "");

    // Show the latest version as the tag if it's newer, otherwise show main@sha
    const latestVersion = tagDiffers ? latestTag :
                          (mainHeadSha && mainHeadSha !== deployedCommit)
                            ? `main@${mainHeadSha}`
                            : latestTag;

    return NextResponse.json({
      currentVersion,
      latestVersion,
      latestTag,
      latestTagSha,
      mainHeadSha,
      deployedCommit,
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
 * Deployment strategy:
 *   - If a tag is newer than current: deploy that tag
 *   - Otherwise: deploy HEAD of main
 *   - Sets APP_VERSION and APP_COMMIT env vars on the new revision
 *
 * Triggers Cloud Build to:
 *   1. Clone the repo at the target ref
 *   2. Build the Docker image
 *   3. Push to Artifact Registry
 *   4. Deploy to Cloud Run with correct APP_VERSION + APP_COMMIT
 *
 * Returns immediately — build runs async (~2-3 min).
 */
export async function POST() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    const ghOwner = process.env.GH_OWNER || GH_OWNER;
    const ghRepo = process.env.GH_REPO || GH_REPO;
    const region = process.env.REGION || "us-central1";
    const serviceName = process.env.SERVICE_NAME || "architect-prime";
    const currentVersion = process.env.APP_VERSION || "dev";
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

    // Determine deploy target: newer tag or main HEAD
    let deployRef = "main";
    let deployVersion = "main";
    let deployCommit = "";

    // Check for newer tag
    try {
      const tagRes = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/tags?per_page=1`,
        { headers: { Accept: "application/vnd.github.v3+json" } }
      );
      if (tagRes.ok) {
        const tags = await tagRes.json();
        if (tags.length > 0 && tags[0].name !== currentVersion) {
          deployRef = tags[0].name;
          deployVersion = tags[0].name;
        }
      }
    } catch {
      // fall through to main
    }

    // Get the commit SHA for the deploy ref (for APP_COMMIT tracking)
    try {
      const commitRes = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/commits/${deployRef}`,
        { headers: { Accept: "application/vnd.github.v3+json" } }
      );
      if (commitRes.ok) {
        const commit = await commitRes.json();
        deployCommit = commit.sha?.substring(0, 7) || "";
        if (deployRef === "main") {
          deployVersion = `main@${deployCommit}`;
        }
      }
    } catch {
      // non-fatal
    }

    // Preserve existing DWD_CLIENT_ID from current env
    const dwdClientId = process.env.DWD_CLIENT_ID || "";

    // Build env vars string
    const envVars = [
      `APP_VERSION=${deployVersion}`,
      `APP_COMMIT=${deployCommit}`,
      `GCP_PROJECT_ID=${projectId}`,
      `NODE_ENV=production`,
      ...(dwdClientId ? [`DWD_CLIENT_ID=${dwdClientId}`] : []),
    ].join(",");

    // Submit Cloud Build: clone → build → push → deploy
    const buildConfig = {
      steps: [
        {
          name: "gcr.io/cloud-builders/git",
          args: [
            "clone", "--depth=1", "--branch", deployRef,
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
            "--update-env-vars", envVars,
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

    console.log(`[api/upgrade] Cloud Build submitted: ${buildId} → ${deployVersion} (ref: ${deployRef}, commit: ${deployCommit})`);

    return NextResponse.json({
      success: true,
      message: `Build triggered for ${deployVersion}. The dashboard will upgrade automatically in ~3 minutes.`,
      buildId,
      version: deployVersion,
      ref: deployRef,
      commit: deployCommit,
    });
  } catch (err) {
    console.error("[api/upgrade] POST error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to trigger upgrade" },
      { status: 500 }
    );
  }
}
