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
  // Map Cloud Build steps to human-readable labels with typical durations (seconds)
  const stepMeta = [
    { label: "Clone repo", typicalDuration: 15 },
    { label: "Build Docker image", typicalDuration: 120 },
    { label: "Push image", typicalDuration: 30 },
    { label: "Deploy to Cloud Run", typicalDuration: 45 },
  ];

  // Overall status from Cloud Build
  const status: string = (build.status as string) || "QUEUED";
  const buildStartTime = (build.startTime as string) || null;
  const buildFinishTime = (build.finishTime as string) || null;

  // Parse step statuses from API (only accurate on completion)
  const rawSteps = (build.steps || []) as Array<{
    status?: string;
    timing?: { startTime?: string; endTime?: string };
  }>;

  // Calculate elapsed time if build is active
  const elapsedMs = buildStartTime ? Date.now() - new Date(buildStartTime).getTime() : 0;
  const elapsedSec = Math.round(elapsedMs / 1000);

  // Cloud Build v1 API limitation: per-step statuses are NOT updated in real-time.
  // They all show "QUEUED" until the entire build finishes, then flip to SUCCESS/FAILURE.
  // When the overall status is "WORKING", we estimate which step is active based on
  // elapsed time and typical step durations.

  let steps: Array<{ label: string; status: string; startTime: string | null; endTime: string | null }>;
  let doneSteps: number;
  let activeStepLabel: string | null = null;
  let failedStepLabel: string | null = null;
  let progress: number;

  if (status === "WORKING" && buildStartTime) {
    // Estimate which step we're on based on elapsed time
    let cumulativeTime = 0;
    let estimatedCurrentStep = 0;

    for (let i = 0; i < stepMeta.length; i++) {
      if (elapsedSec > cumulativeTime + stepMeta[i].typicalDuration) {
        cumulativeTime += stepMeta[i].typicalDuration;
        estimatedCurrentStep = i + 1;
      } else {
        break;
      }
    }

    // Clamp to valid range
    estimatedCurrentStep = Math.min(estimatedCurrentStep, stepMeta.length - 1);
    doneSteps = estimatedCurrentStep;

    // Build the steps array with estimated statuses
    steps = stepMeta.map((meta, i) => {
      let stepStatus: string;
      if (i < estimatedCurrentStep) {
        stepStatus = "SUCCESS";
      } else if (i === estimatedCurrentStep) {
        stepStatus = "WORKING";
        activeStepLabel = meta.label;
      } else {
        stepStatus = "QUEUED";
      }

      // Use real timing data if available (sometimes the API does populate it)
      const realStep = rawSteps[i];
      const startTime = realStep?.timing?.startTime || (i <= estimatedCurrentStep ? buildStartTime : null);
      const endTime = realStep?.timing?.endTime || null;

      return {
        label: meta.label,
        status: stepStatus,
        startTime,
        endTime,
      };
    });

    // Calculate progress: combination of completed steps + partial progress on current step
    const totalDuration = stepMeta.reduce((sum, s) => sum + s.typicalDuration, 0);
    const estimatedProgress = Math.min(95, Math.round((elapsedSec / totalDuration) * 100));
    progress = Math.max(estimatedProgress, Math.round((doneSteps / stepMeta.length) * 100));
  } else if (status === "SUCCESS") {
    // Build finished successfully — all steps done
    steps = stepMeta.map((meta, i) => {
      const realStep = rawSteps[i];
      return {
        label: meta.label,
        status: realStep?.status || "SUCCESS",
        startTime: realStep?.timing?.startTime || null,
        endTime: realStep?.timing?.endTime || null,
      };
    });
    doneSteps = stepMeta.length;
    progress = 100;
  } else if (status === "FAILURE" || status === "TIMEOUT" || status === "CANCELLED") {
    // Build failed — use real step data
    steps = stepMeta.map((meta, i) => {
      const realStep = rawSteps[i];
      const stepStatus = realStep?.status || "QUEUED";
      if (stepStatus === "FAILURE" || stepStatus === "TIMEOUT" || stepStatus === "CANCELLED") {
        failedStepLabel = meta.label;
      }
      return {
        label: meta.label,
        status: stepStatus,
        startTime: realStep?.timing?.startTime || null,
        endTime: realStep?.timing?.endTime || null,
      };
    });
    doneSteps = steps.filter((s) => s.status === "SUCCESS").length;
    progress = Math.round((doneSteps / stepMeta.length) * 100);
  } else {
    // QUEUED or other — nothing started yet
    steps = stepMeta.map((meta) => ({
      label: meta.label,
      status: "QUEUED",
      startTime: null,
      endTime: null,
    }));
    doneSteps = 0;
    progress = 0;
  }

  return NextResponse.json({
    buildId,
    status,
    progress,
    totalSteps: stepMeta.length,
    doneSteps,
    activeStep: activeStepLabel,
    failedStep: failedStepLabel,
    steps,
    startTime: buildStartTime,
    finishTime: buildFinishTime,
    statusDetail: (build.statusDetail as string) || null,
  });
}

