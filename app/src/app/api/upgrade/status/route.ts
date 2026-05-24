import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

/**
 * GET /api/upgrade/status?buildId=xxx&region=yyy — Poll Cloud Build status
 *
 * Uses the regional Cloud Build API for real-time step-level progress.
 * The global endpoint only returns overall status without step timing.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const buildId = req.nextUrl.searchParams.get("buildId");
  if (!buildId) {
    return NextResponse.json({ error: "buildId required" }, { status: 400 });
  }

  // Region from query param, env var, or default
  const region = req.nextUrl.searchParams.get("region")
    || process.env.REGION
    || "us-central1";

  try {
    const projectId = process.env.GCP_PROJECT_ID || "";

    // Get SA token
    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }
    );

    if (!tokenRes.ok) {
      return NextResponse.json({ error: "Cannot get SA token" }, { status: 500 });
    }

    const { access_token: token } = await tokenRes.json();

    // Fetch build status from regional Cloud Build API (has step-level timing)
    const buildRes = await fetch(
      `https://cloudbuild.googleapis.com/v1/projects/${projectId}/locations/${region}/builds/${buildId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!buildRes.ok) {
      // Fallback: try global endpoint for backward compat with older builds
      const globalRes = await fetch(
        `https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${buildId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          cache: "no-store",
        }
      );

      if (!globalRes.ok) {
        return NextResponse.json(
          { error: `Cloud Build API error (${buildRes.status} regional, ${globalRes.status} global)` },
          { status: buildRes.status }
        );
      }

      // Use global response as fallback
      return formatBuildResponse(buildId, await globalRes.json());
    }

    return formatBuildResponse(buildId, await buildRes.json());
  } catch (err) {
    console.error("[api/upgrade/status] Error:", err);
    return NextResponse.json({ error: "Failed to fetch build status" }, { status: 500 });
  }
}

function formatBuildResponse(buildId: string, build: Record<string, unknown>) {
  // Map Cloud Build steps to human-readable labels
  const stepLabels = ["Clone repo", "Build Docker image", "Push image", "Deploy to Cloud Run"];

  // Parse step statuses
  const steps = ((build.steps || []) as Array<{ status?: string; timing?: { startTime?: string; endTime?: string } }>).map((step, i) => ({
    label: stepLabels[i] || `Step ${i + 1}`,
    status: step.status || "QUEUED",
    startTime: step.timing?.startTime || null,
    endTime: step.timing?.endTime || null,
  }));

  // Calculate progress
  const totalSteps = steps.length || 4;
  const doneSteps = steps.filter((s) => s.status === "SUCCESS").length;
  const activeStep = steps.find((s) => s.status === "WORKING");
  const failedStep = steps.find((s) => s.status === "FAILURE" || s.status === "TIMEOUT" || s.status === "CANCELLED");
  const progress = Math.round((doneSteps / totalSteps) * 100);

  // Overall status
  const status: string = (build.status as string) || "QUEUED";

  return NextResponse.json({
    buildId,
    status,
    progress,
    totalSteps,
    doneSteps,
    activeStep: activeStep?.label || null,
    failedStep: failedStep?.label || null,
    steps,
    startTime: (build.startTime as string) || null,
    finishTime: (build.finishTime as string) || null,
    statusDetail: (build.statusDetail as string) || null,
  });
}
