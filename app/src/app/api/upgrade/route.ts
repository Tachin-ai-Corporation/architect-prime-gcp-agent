import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { commandsCol } from "@/lib/firestore";
import { FieldValue } from "@google-cloud/firestore";

const GH_OWNER = "Tachin-ai-Corporation";
const GH_REPO = "architect-prime-gcp-agent";

/**
 * Extract version from commit message.
 * Supports two formats:
 *   - Canonical (forever): "v2026.04.26.1.0: description" → "v2026.04.26.1.0"
 *   - Back-compat (v5.0-v5.3 era): "v5.3.0: description" → "v5.3.0"
 * Returns the version prefix or "unknown".
 *
 * ADR: The canonical format is v{YYYY}.{MM}.{DD}.{index}.{subindex}.
 * This is the FOREVER versioning schema. The vX.Y.Z format was a
 * temporary deviation and is kept only for back-compat.
 * See also: contracts.json → versioning
 */
function extractVersion(commitMessage: string): string {
  // Canonical format: v2026.04.26.1.0 (date-based, forever format)
  const canonical = commitMessage.match(/^(v\d{4}\.\d{2}\.\d{2}\.\d+\.\d+)/);
  if (canonical) return canonical[1];
  // Back-compat: vX.Y.Z (temporary format used during v5.0-v5.3)
  const semver = commitMessage.match(/^(v\d+\.\d+\.\d+)/);
  return semver ? semver[1] : "unknown";
}

/**
 * GET /api/upgrade — Check deployed and latest versions
 *
 * Returns:
 *   - deployedVersion: human-friendly version from deployed commit message
 *   - latestVersion: human-friendly version from main HEAD commit message
 *   - deployedStable / latestStable: whether each commit is tagged STABLE
 *   - updateAvailable: true if main HEAD differs from deployed commit
 */
export async function GET() {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    const ghOwner = process.env.GH_OWNER || GH_OWNER;
    const ghRepo = process.env.GH_REPO || GH_REPO;
    const deployedCommit = process.env.APP_COMMIT || "";

    let stableTagSha = "";
    let mainHeadSha = "";
    let mainCommitMessage = "";
    let deployedCommitMessage = "";

    // Fetch STABLE tag SHA
    try {
      const res = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/git/ref/tags/STABLE`,
        { headers: { Accept: "application/vnd.github.v3+json" }, next: { revalidate: 60 } }
      );
      if (res.ok) {
        const ref = await res.json();
        stableTagSha = ref.object?.sha?.substring(0, 7) || "";
      }
    } catch {
      // GitHub API may be unavailable
    }

    // Fetch main HEAD commit (sha + message)
    try {
      const res = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/commits/main`,
        { headers: { Accept: "application/vnd.github.v3+json" }, next: { revalidate: 60 } }
      );
      if (res.ok) {
        const commit = await res.json();
        mainHeadSha = commit.sha?.substring(0, 7) || "";
        mainCommitMessage = commit.commit?.message?.split("\n")[0] || "";
      }
    } catch {
      // GitHub API may be unavailable
    }

    // Fetch deployed commit message (if different from main HEAD)
    if (deployedCommit && deployedCommit !== mainHeadSha) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${ghOwner}/${ghRepo}/commits/${deployedCommit}`,
          { headers: { Accept: "application/vnd.github.v3+json" }, next: { revalidate: 300 } }
        );
        if (res.ok) {
          const commit = await res.json();
          deployedCommitMessage = commit.commit?.message?.split("\n")[0] || "";
        }
      } catch {
        // non-fatal
      }
    } else {
      deployedCommitMessage = mainCommitMessage;
    }

    const deployedVersion = extractVersion(deployedCommitMessage) || process.env.APP_VERSION || "dev";
    const latestVersion = extractVersion(mainCommitMessage);
    const deployedStable = deployedCommit !== "" && stableTagSha !== "" && deployedCommit === stableTagSha;
    const latestStable = mainHeadSha !== "" && stableTagSha !== "" && mainHeadSha === stableTagSha;
    const updateAvailable = deployedCommit !== "" && mainHeadSha !== "" && deployedCommit !== mainHeadSha;

    return NextResponse.json({
      deployedVersion,
      latestVersion,
      deployedStable,
      latestStable,
      deployedCommit,
      mainHeadSha,
      updateAvailable,
      projectId,
      // Legacy fields for backward compat
      currentVersion: deployedVersion,
      latestTag: stableTagSha ? "STABLE" : "unknown",
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
 * Always deploys from main HEAD. Sets APP_VERSION to the extracted
 * version from the commit message and APP_COMMIT to the sha.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  // Read optional primeId from body for ops tracking
  let primeId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    primeId = body?.primeId;
  } catch {
    // non-fatal — body is optional
  }

  try {
    const projectId = process.env.GCP_PROJECT_ID || "";
    const ghOwner = process.env.GH_OWNER || GH_OWNER;
    const ghRepo = process.env.GH_REPO || GH_REPO;
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

    // Always deploy from main HEAD
    const deployRef = "main";
    let deployVersion = "main";
    let deployCommit = "";

    // Get main HEAD commit (sha + message for version label)
    try {
      const commitRes = await fetch(
        `https://api.github.com/repos/${ghOwner}/${ghRepo}/commits/main`,
        { headers: { Accept: "application/vnd.github.v3+json" } }
      );
      if (commitRes.ok) {
        const commit = await commitRes.json();
        deployCommit = commit.sha?.substring(0, 7) || "";
        const message = commit.commit?.message?.split("\n")[0] || "";
        deployVersion = extractVersion(message) || `main@${deployCommit}`;
      }
    } catch {
      // non-fatal
    }

    // Preserve existing env vars from current deployment
    const dwdClientId = process.env.DWD_CLIENT_ID || "";
    const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
    const nextAuthSecret = process.env.NEXTAUTH_SECRET || "";
    const allowedDomain = process.env.ALLOWED_DOMAIN || "";
    const nextAuthUrl = process.env.NEXTAUTH_URL || "";

    // Build env vars string
    const envVars = [
      `APP_VERSION=${deployVersion}`,
      `APP_COMMIT=${deployCommit}`,
      `GCP_PROJECT_ID=${projectId}`,
      `NODE_ENV=production`,
      ...(dwdClientId ? [`DWD_CLIENT_ID=${dwdClientId}`] : []),
      ...(googleClientId ? [`GOOGLE_CLIENT_ID=${googleClientId}`] : []),
      ...(nextAuthSecret ? [`NEXTAUTH_SECRET=${nextAuthSecret}`] : []),
      ...(allowedDomain ? [`ALLOWED_DOMAIN=${allowedDomain}`] : []),
      ...(nextAuthUrl ? [`NEXTAUTH_URL=${nextAuthUrl}`] : []),
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
      `https://cloudbuild.googleapis.com/v1/projects/${projectId}/locations/${region}/builds`,
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
    // Cloud Build regional API returns Operation with metadata.build.id
    // The name field is "operations/build/PROJECT_ID/BUILD_ID"
    let buildId = buildData?.metadata?.build?.id || "";
    if (!buildId && buildData?.name) {
      // Extract BUILD_ID from "operations/build/PROJECT_ID/BUILD_ID"
      const parts = (buildData.name as string).split("/");
      buildId = parts.length >= 4 ? parts[parts.length - 1] : buildData.name;
    }
    if (!buildId) buildId = "unknown";

    console.log(`[api/upgrade] Cloud Build submitted: ${buildId} → ${deployVersion} (ref: ${deployRef}, commit: ${deployCommit})`);
    if (buildId === "unknown") {
      console.warn(`[api/upgrade] buildId extraction failed. Response keys: ${Object.keys(buildData).join(", ")}. name: ${buildData?.name}`);
    }

    // Write command doc for ops feed tracking
    if (primeId) {
      try {
        await commandsCol(primeId).doc().set({
          type: "dashboard_deploy",
          status: "running",
          args: { version: deployVersion, buildId, commit: deployCommit },
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn("[api/upgrade] Failed to write command doc:", e);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Build triggered for ${deployVersion}. The dashboard will upgrade automatically in ~3 minutes.`,
      buildId,
      version: deployVersion,
      ref: deployRef,
      commit: deployCommit,
      region,
    });
  } catch (err) {
    console.error("[api/upgrade] POST error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to trigger upgrade" },
      { status: 500 }
    );
  }
}
