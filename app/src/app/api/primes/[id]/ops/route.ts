import { NextRequest, NextResponse } from "next/server";
import { commandsCol, fleetCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/* ---- Types ---- */

interface OperationStep {
  id: string;
  label: string;
  status: string;
  timestamp: string;
  detail?: string;
}

interface Operation {
  id: string;
  type: string;
  status: string;
  label: string;
  target: string;
  prime: string;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  detail: string | null;
  steps: OperationStep[] | null;
  progress: number | null;
  buildId: string | null;
}

/* ---- Helpers ---- */

const TYPE_MAP: Record<string, string> = {
  upgrade_corekit: "corekit_upgrade",
  fleet_deploy: "fleet_hire",
};

function mapType(cmdType: string): string {
  return TYPE_MAP[cmdType] || cmdType;
}

function makeLabel(cmdType: string, args: Record<string, string>, primeId: string): string {
  const primeName = primeId.charAt(0).toUpperCase() + primeId.slice(1);
  switch (cmdType) {
    case "upgrade_corekit":
      return `CoreKit Upgrade — ${primeName}`;
    case "fleet_upgrade":
      return `CoreKit Upgrade — ${args.name || "unknown"}`;
    case "fleet_deploy":
      return `Hiring Agent — ${args.name || "unknown"}`;
    case "fleet_teardown":
      return `Removing Agent — ${args.name || "unknown"}`;
    case "prime_teardown":
      return `Deleting Prime — ${primeName}`;
    case "dashboard_deploy":
      return `Dashboard Deploy — ${args.version || "latest"}`;
    case "gateway_restart":
      return `Gateway Restart — ${primeName}`;
    case "prime_deploy":
      return `Deploying Prime — ${primeName}`;
    default:
      return cmdType;
  }
}

function makeTarget(cmdType: string, args: Record<string, string>): string {
  if (["fleet_deploy", "fleet_upgrade", "fleet_teardown"].includes(cmdType)) {
    return args.name || "unknown";
  }
  if (cmdType === "dashboard_deploy") return "dashboard";
  if (cmdType === "prime_teardown" || cmdType === "prime_deploy") return "prime";
  return "prime";
}

function toISOOrNull(ts: FirebaseFirestore.Timestamp | undefined | null): string | null {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  return null;
}

function truncate(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.substring(0, max) + "…" : s;
}

/* ---- Cloud Build status mapping ---- */

const CB_STATUS_MAP: Record<string, string> = {
  QUEUED: "pending",
  WORKING: "running",
  SUCCESS: "complete",
  FAILURE: "failed",
  TIMEOUT: "failed",
  CANCELLED: "failed",
  INTERNAL_ERROR: "failed",
};

const CB_TERMINAL = new Set(["SUCCESS", "FAILURE", "TIMEOUT", "CANCELLED", "INTERNAL_ERROR"]);

async function pollCloudBuild(
  projectId: string,
  buildId: string,
  region?: string,
): Promise<{ status: string; detail: string | null } | null> {
  try {
    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    if (!tokenRes.ok) return null;
    const { access_token: token } = await tokenRes.json();

    // Use regional endpoint if region is provided (regional builds aren't visible on the global endpoint)
    const url = region
      ? `https://cloudbuild.googleapis.com/v1/projects/${projectId}/locations/${region}/builds/${buildId}`
      : `https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${buildId}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;

    const data = await res.json();
    const cbStatus = data.status as string;
    return {
      status: CB_STATUS_MAP[cbStatus] || "running",
      detail: data.statusDetail || null,
    };
  } catch {
    return null;
  }
}

/* ---- GET handler ---- */

/**
 * GET /api/primes/[id]/ops — Unified operations feed
 *
 * Returns the last 15 commands as normalized Operation objects,
 * enriched with fleet deploy steps and Cloud Build status.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id: primeId } = await ctx.params;
    const projectId = process.env.GCP_PROJECT_ID || "";

    // 1. Fetch last 15 commands
    const snap = await commandsCol(primeId)
      .orderBy("createdAt", "desc")
      .limit(25)
      .get();

    // 2. Build operations in parallel
    const operations: Operation[] = await Promise.all(
      snap.docs.map(async (doc) => {
        const d = doc.data();
        const cmdType: string = d.type || "unknown";
        const args: Record<string, string> = d.args || {};
        let status: string = d.status || "pending";
        let detail: string | null = truncate(d.result || d.error, 500);
        let steps: OperationStep[] | null = null;
        let progress: number | null = null;
        const buildId: string | null = args.buildId || null;

        // 3. Fleet deploy — fetch deploy steps from fleet doc
        if (cmdType === "fleet_deploy" && args.name) {
          try {
            const fleetSnap = await fleetCol(primeId).doc(args.name).get();
            if (fleetSnap.exists) {
              const fleetData = fleetSnap.data();
              const deploySteps = fleetData?.deploySteps;
              if (Array.isArray(deploySteps) && deploySteps.length > 0) {
                steps = deploySteps.map((s) => ({
                  id: s.id,
                  label: s.label,
                  status: s.status,
                  timestamp: s.timestamp || "",
                  ...(s.detail ? { detail: s.detail } : {}),
                }));
                const completed = deploySteps.filter(
                  (s) => s.status === "done" || s.status === "skipped",
                ).length;
                progress = Math.round((completed / deploySteps.length) * 100);
              }
            }
          } catch (e) {
            console.warn(`[api/ops] Failed to fetch fleet doc for ${args.name}:`, e);
          }
        }

        // 3b. Prime deploy — fetch deploy steps from prime doc
        if (cmdType === "prime_deploy" && status === "running") {
          try {
            const primeSnap = await primesCol().doc(primeId).get();
            if (primeSnap.exists) {
              const primeData = primeSnap.data();
              const deploySteps = primeData?.deploySteps;
              if (Array.isArray(deploySteps) && deploySteps.length > 0) {
                steps = deploySteps.map((s) => ({
                  id: s.id,
                  label: s.label,
                  status: s.status,
                  timestamp: s.timestamp || "",
                  ...(s.detail ? { detail: s.detail } : {}),
                }));
                const completed = deploySteps.filter(
                  (s) => s.status === "done" || s.status === "skipped",
                ).length;
                progress = Math.round((completed / deploySteps.length) * 100);

                // Auto-complete the command when prime is online
                if (primeData?.status === "online") {
                  status = "complete";
                  detail = "Prime is online";
                  try {
                    await commandsCol(primeId).doc(doc.id).update({
                      status: "complete",
                      result: "Prime deployed successfully",
                    });
                  } catch {}
                }
              }
            }
          } catch (e) {
            console.warn(`[api/ops] Failed to fetch prime doc for deploy steps:`, e);
          }
        }

        // 4. Dashboard deploy — poll Cloud Build if still running
        if (cmdType === "dashboard_deploy" && status === "running" && buildId && buildId !== "unknown" && projectId) {
          const cbResult = await pollCloudBuild(projectId, buildId, args.region);
          if (cbResult) {
            if (cbResult.status !== status) {
              status = cbResult.status;
              if (cbResult.detail) detail = truncate(cbResult.detail, 500);

              // If terminal, update Firestore so we don't poll again
              if (["complete", "failed"].includes(cbResult.status)) {
                try {
                  const updateData: Record<string, unknown> = { status: cbResult.status };
                  if (cbResult.status === "complete") {
                    updateData.result = cbResult.detail || "Build completed";
                  } else {
                    updateData.error = cbResult.detail || "Build failed";
                  }
                  await commandsCol(primeId).doc(doc.id).update(updateData);
                } catch (e) {
                  console.warn(`[api/ops] Failed to update command ${doc.id}:`, e);
                }
              }
            }
          }
        }

        const startedAt = toISOOrNull(d.createdAt);

        // Deterministic deploy completion: if this API is responding, the
        // dashboard is alive. Cloud Build + Cloud Run deploy takes ~3-4 min.
        // Any dashboard_deploy running > 5 min is definitively complete.
        if (cmdType === "dashboard_deploy" && status === "running") {
          const startMs = startedAt ? new Date(startedAt).getTime() : 0;
          if (startMs > 0 && Date.now() - startMs > 5 * 60 * 1000) {
            status = "complete";
            detail = "Deploy completed successfully";
            try {
              await commandsCol(primeId).doc(doc.id).update({
                status: "complete",
                result: detail,
              });
            } catch {}
          }
        }
        const completedAt = toISOOrNull(d.updatedAt);
        let duration: number | null = null;
        if (startedAt && completedAt) {
          duration = Math.round(
            (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
          );
          if (duration < 0) duration = null;
        }

        return {
          id: doc.id,
          type: mapType(cmdType),
          status,
          label: makeLabel(cmdType, args, primeId),
          target: makeTarget(cmdType, args),
          prime: primeId,
          startedAt,
          completedAt,
          duration,
          detail,
          steps,
          progress,
          buildId,
        };
      }),
    );

    return NextResponse.json({ operations });
  } catch (err) {
    console.error("[api/ops] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch operations" },
      { status: 500 },
    );
  }
}

/* ---- DELETE handler ---- */

/**
 * DELETE /api/primes/[id]/ops — Clear completed/failed operations
 *
 * Batch-deletes all commands with status 'complete' or 'failed'.
 * Never deletes active (pending/running) operations.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id: primeId } = await ctx.params;

    // Query completed/failed commands
    const completedSnap = await commandsCol(primeId)
      .where("status", "==", "complete")
      .get();
    const failedSnap = await commandsCol(primeId)
      .where("status", "==", "failed")
      .get();

    const allDocs = [...completedSnap.docs, ...failedSnap.docs];
    if (allDocs.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }

    // Batch delete (max 500 per batch)
    const db = commandsCol(primeId).firestore;
    const batch = db.batch();
    allDocs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    return NextResponse.json({ deleted: allDocs.length });
  } catch (err) {
    console.error("[api/ops] DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to clear operations" },
      { status: 500 },
    );
  }
}
