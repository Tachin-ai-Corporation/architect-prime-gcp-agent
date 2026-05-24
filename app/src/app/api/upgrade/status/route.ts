import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

/**
 * GET /api/upgrade/status?buildId=xxx — Poll Cloud Build status
 *
 * Returns real-time build status, current step, and timing.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const buildId = req.nextUrl.searchParams.get("buildId");
  if (!buildId) {
    return NextResponse.json({ error: "buildId required" }, { status: 400 });
  }

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

    // Fetch build status from Cloud Build API
    const buildRes = await fetch(
      `https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${buildId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!buildRes.ok) {
      return NextResponse.json(
        { error: `Cloud Build API error (${buildRes.status})` },
        { status: buildRes.status }
      );
    }

    const build = await buildRes.json();

    // Map Cloud Build steps to human-readable labels
    const stepLabels = ["Clone repo", "Build Docker image", "Push image", "Deploy to Cloud Run"];

    // Parse step statuses
    const steps = (build.steps || []).map((step: { status?: string; timing?: { startTime?: string; endTime?: string } }, i: number) => ({
      label: stepLabels[i] || `Step ${i + 1}`,
      status: step.status || "QUEUED", // QUEUED, WORKING, SUCCESS, FAILURE, etc.
      startTime: step.timing?.startTime || null,
      endTime: step.timing?.endTime || null,
    }));

    // Calculate progress
    const totalSteps = steps.length || 4;
    const doneSteps = steps.filter((s: { status: string }) => s.status === "SUCCESS").length;
    const activeStep = steps.find((s: { status: string }) => s.status === "WORKING");
    const failedStep = steps.find((s: { status: string }) => s.status === "FAILURE" || s.status === "TIMEOUT" || s.status === "CANCELLED");
    const progress = Math.round((doneSteps / totalSteps) * 100);

    // Overall status
    const status: string = build.status || "QUEUED";
    // QUEUED, WORKING, SUCCESS, FAILURE, TIMEOUT, CANCELLED

    return NextResponse.json({
      buildId,
      status,
      progress,
      totalSteps,
      doneSteps,
      activeStep: activeStep?.label || null,
      failedStep: failedStep?.label || null,
      steps,
      startTime: build.startTime || null,
      finishTime: build.finishTime || null,
      statusDetail: build.statusDetail || null,
    });
  } catch (err) {
    console.error("[api/upgrade/status] Error:", err);
    return NextResponse.json({ error: "Failed to fetch build status" }, { status: 500 });
  }
}
