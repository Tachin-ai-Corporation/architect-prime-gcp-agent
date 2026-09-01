import { NextRequest, NextResponse } from "next/server";
import { primesCol, commandsCol } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";
import { seedCoreProcesses } from "@/lib/seed-processes";
import { FieldValue } from "@google-cloud/firestore";
import { getGitHubOwner, getGitHubRepo } from "@/lib/github";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/primes/[id]/deploy — Provision a Prime VM
 *
 * Uses the Cloud Run SA's credentials to create a GCE VM
 * in the same project that runs the control plane.
 *
 * The VM startup script:
 *   1. Reads all config from VM metadata attributes
 *   2. Downloads install.sh (manifest-based CoreKit installer)
 *   3. Installs CoreKit (web-search, brain-exec, etc.)
 *   4. Writes prime-config.json with the Prime ID + project
 *   5. Installs agent-ears + agent-mouth as systemd services
 *   6. agent-ears starts polling → agent ready
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  // Declared outside the try so the catch block can mark the command failed.
  let cmdRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    // Get Prime config from Firestore
    const doc = await primesCol().doc(id).get();
    if (!doc.exists) {
      return NextResponse.json({ error: "Prime not found" }, { status: 404 });
    }

    const prime = doc.data()!;
    const projectId = process.env.GCP_PROJECT_ID!;
    const zone = prime.zone || "us-central1-a";
    const vmName = prime.vmName || `prime-${id}`;

    // Update status to deploying. Clear any stale error from a prior wedged
    // attempt so re-clicking Deploy on an errored Prime retries cleanly.
    await primesCol()
      .doc(id)
      .update({ status: "deploying", error: FieldValue.delete() });

    // Seed core processes (p-plan, p-investigate) — idempotent
    seedCoreProcesses(id).catch((err) =>
      console.error(`[deploy] Failed to seed core processes:`, err)
    );

    // Track the deploy in the Operations panel. Written up front (status
    // 'running') so both the success and failure paths have a doc to resolve.
    // Non-fatal: a visibility-doc write failure must not abort the deploy.
    try {
      cmdRef = commandsCol(id).doc();
      await cmdRef.set({
        type: "prime_deploy",
        args: { vmName, zone },
        status: "running",
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn(`[deploy] Failed to write command doc:`, e);
      cmdRef = null;
    }

    // Create the VM, then poll the returned zone operation to a terminal state.
    // instances.insert returns 202 (request accepted) long before the operation
    // finishes; checking only the HTTP acceptance let a later async failure (e.g.
    // INTERNAL_ERROR) wedge the Prime at 'deploying'/'running' forever with no VM.
    // We poll to DONE within a budget that stays well under Cloud Run's 300s
    // request timeout, and retry once on the transient INTERNAL_ERROR that GCP
    // explicitly says to retry. Reaching DONE here means the VM *resource* was
    // created — the ~10-min bootstrap still runs async on the VM afterward.
    const token = await getAccessToken();
    const POLL_INTERVAL_MS = 5000;
    const pollDeadline = Date.now() + 180_000;

    let failure: { message: string; code: string } | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const insertResult = await createVM(token, projectId, zone, vmName, id);

      if (!insertResult.ok) {
        // 409 = the VM already exists (a prior attempt or redeploy won). Idempotent
        // success: let the boot + ops reconciler carry it the rest of the way.
        if (insertResult.status === 409) break;
        const errText = await insertResult
          .text()
          .catch(() => `HTTP ${insertResult.status}`);
        failure = { message: errText, code: `HTTP_${insertResult.status}` };
        break; // request-level rejection, not the transient op error we retry
      }

      const op = (await insertResult
        .json()
        .catch(() => null)) as GceOperation | null;
      const opName = op?.name;
      if (!opName) {
        // Accepted but no operation handle to poll — don't guess failure; leave it
        // in progress for the ops reconciler to finish when the Prime comes online.
        break;
      }

      const done = await pollZoneOperation(
        token,
        projectId,
        zone,
        opName,
        pollDeadline,
        POLL_INTERVAL_MS
      );

      if (done.status === "TIMEOUT") {
        // The operation is genuinely still running (not wedged): the insert was
        // accepted and is progressing. Leave 'deploying'/'running'; the ops route
        // flips the command to 'complete' when the Prime reports online.
        break;
      }

      if (done.error) {
        const codes = (done.error.errors || []).map((e) => e.code || "");
        const message =
          done.error.errors?.[0]?.message ||
          done.error.message ||
          "VM create operation failed";
        // "Internal error. Please try again" — retry once if budget allows.
        if (
          codes.includes("INTERNAL_ERROR") &&
          attempt === 1 &&
          Date.now() < pollDeadline - 60_000
        ) {
          console.warn(
            `[deploy] Transient INTERNAL_ERROR creating ${vmName} — retrying once…`
          );
          continue;
        }
        failure = { message, code: codes.join(",") || "OPERATION_ERROR" };
        break;
      }

      // DONE with no error — the VM resource was created cleanly.
      break;
    }

    if (failure) {
      console.error(
        `[deploy] VM creation failed (${failure.code}): ${failure.message}`
      );
      await primesCol()
        .doc(id)
        .update({ status: "error", error: failure.message })
        .catch(() => {});
      if (cmdRef) {
        await cmdRef
          .update({
            status: "failed",
            error: failure.message,
            updatedAt: FieldValue.serverTimestamp(),
          })
          .catch(() => {});
      }
      return NextResponse.json(
        { error: "VM creation failed", details: failure.message },
        { status: 500 }
      );
    }

    // VM resource created (or already existed). The startup script runs the
    // bootstrap on boot; the Prime comes online in ~10 min. The command stays
    // 'running' until the ops route observes prime.status === 'online'.
    return NextResponse.json({
      status: "deploying",
      vmName,
      zone,
      message: `VM ${vmName} is being created. Prime will come online in ~10 minutes.`,
    });
  } catch (err) {
    console.error(`[deploy] Error:`, err);
    const errMsg = err instanceof Error ? err.message : "Deploy failed";
    await primesCol()
      .doc(id)
      .update({ status: "error", error: errMsg })
      .catch(() => {});
    if (cmdRef) {
      await cmdRef
        .update({
          status: "failed",
          error: errMsg,
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
    }
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}

/**
 * Get access token from the metadata server (Cloud Run SA).
 */
/**
 * Resolve a human channel (branch, tag) to an immutable commit SHA.
 *
 * C-35: a branch is a moving target — activating one makes "what is running?"
 * unanswerable and rollback impossible. Throws rather than falling back, so a
 * resolution failure aborts the deploy instead of provisioning from whatever
 * `main` happens to be when the VM boots.
 */
async function resolveChannelToSha(
  owner: string,
  repo: string,
  channel: string
): Promise<string> {
  if (/^[0-9a-f]{40}$/.test(channel)) return channel;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${channel}`,
    { headers: { Accept: "application/vnd.github.v3+json" } }
  );
  if (!res.ok) {
    throw new Error(
      `Could not resolve ${owner}/${repo}@${channel} to a commit (HTTP ${res.status}). ` +
        `Refusing to deploy from a mutable ref.`
    );
  }
  const commit = await res.json();
  const sha = commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha || "")) {
    throw new Error(`GitHub returned no usable commit SHA for ${owner}/${repo}@${channel}.`);
  }
  return sha;
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) {
    throw new Error("Cannot get access token — not running on GCP");
  }
  const data = await res.json();
  return data.access_token;
}

/* ---- Zone operation polling ---- */

interface GceOperationError {
  errors?: { code?: string; message?: string }[];
  message?: string;
}

interface GceOperation {
  name?: string;
  // "PENDING" | "RUNNING" | "DONE" from GCE, plus a local "TIMEOUT" sentinel.
  status?: string;
  error?: GceOperationError;
  progress?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a zonal Compute Engine operation until it reports DONE or the deadline
 * passes. instances.insert is asynchronous: the POST returns an operation that
 * is still PENDING/RUNNING, and the create can still fail (e.g. INTERNAL_ERROR)
 * after the request was accepted. Returning a definitive DONE (carrying .error
 * on failure) is what lets the caller record a real terminal state instead of a
 * VM that silently never appeared.
 *
 * On deadline, returns a synthetic { status: "TIMEOUT" } — the operation is
 * still legitimately running, not failed, so the caller leaves it in progress.
 * Transient GET failures are swallowed and retried within the budget.
 */
async function pollZoneOperation(
  token: string,
  projectId: string,
  zone: string,
  opName: string,
  deadlineMs: number,
  intervalMs: number
): Promise<GceOperation> {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/operations/${opName}`;
  for (;;) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const op = (await res.json().catch(() => null)) as GceOperation | null;
        if (op?.status === "DONE") return op;
      }
    } catch {
      // transient network/timeout — fall through and retry within budget
    }
    if (Date.now() + intervalMs >= deadlineMs) return { status: "TIMEOUT" };
    await sleep(intervalMs);
  }
}

/**
 * Create a GCE VM via the Compute Engine REST API.
 *
 * Follows the fleet-deploy pattern: all config passed as
 * metadata attributes, startup script reads from metadata.
 *
 * Returns the raw insert Response (202 on acceptance). The insert is only the
 * *request* — the caller must poll the returned zone operation (see
 * pollZoneOperation) to learn whether the VM was actually created.
 */
async function createVM(
  token: string,
  projectId: string,
  zone: string,
  vmName: string,
  primeId: string
): Promise<Response> {
  const machineType = `zones/${zone}/machineTypes/e2-medium`;
  const sourceImage = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts";

  const ghOwner = getGitHubOwner();
  const ghRepo = getGitHubRepo();
  const startupScript = getStartupScript(ghOwner, ghRepo);

  // C-35: a VM is stamped with an immutable commit, never a branch. Resolving
  // here — at the boundary where the human channel enters the system — means the
  // VM's own record of what it runs is exact, and two Primes deployed minutes
  // apart cannot silently differ.
  const coreRef = await resolveChannelToSha(ghOwner, ghRepo, "main");

  // Get the project number for the default compute SA
  const projRes = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const projData = await projRes.json();
  const projectNumber = projData.projectNumber;
  const defaultSA = `${projectNumber}-compute@developer.gserviceaccount.com`;

  const body = {
    name: vmName,
    machineType,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage,
          diskSizeGb: "30",
          diskType: `zones/${zone}/diskTypes/pd-balanced`,
        },
      },
    ],
    networkInterfaces: [
      {
        accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
      },
    ],
    metadata: {
      items: [
        { key: "startup-script", value: startupScript },
        { key: "prime_id", value: primeId },
        { key: "agent_id", value: "prime" },
        { key: "core_ref", value: coreRef },
        { key: "gh_owner", value: ghOwner },
        { key: "gh_repo", value: ghRepo },
        { key: "gcp_project_id", value: projectId },
      ],
    },
    tags: { items: ["architect-prime"] },
    serviceAccounts: [
      {
        email: defaultSA,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    ],
    labels: {
      app: "architect-prime",
      role: "prime",
      "prime-id": primeId.substring(0, 63), // labels max 63 chars
    },
  };

  return fetch(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}

/**
 * Startup script for Prime VMs.
 *
 * This is a thin boot stub — it downloads the real bootstrap script
 * from GitHub and executes it. All the heavy lifting (Node.js installation,
 * neural gateway setup, agent-ears, agent-mouth) is in infra/bootstrap/prime-bootstrap.sh.
 *
 * Why: embedding 230 lines of bash inside a JS template literal
 * caused 5 consecutive deploy failures due to escape conflicts
 * (JS template → bash → python heredocs). Never again.
 */
function getStartupScript(ghOwner: string, ghRepo: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'exec > >(tee -a /var/log/prime-setup.log) 2>&1',
    '',
    '# Read repo coordinates from VM metadata',
    'META="http://metadata.google.internal/computeMetadata/v1"',
    'MH="Metadata-Flavor: Google"',
    // C-35: no branch fallback. The deploy route stamped an immutable commit
    // into metadata; if we cannot read it back, the VM must not guess.
    'CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || true)"',
    'if [[ ! "$CORE_REF" =~ ^[0-9a-f]{40}$ ]]; then',
    '  echo "FATAL: core_ref metadata is not a commit SHA (got: ${CORE_REF:-<empty>}). Refusing to bootstrap." >&2',
    '  exit 1',
    'fi',
    `GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo ${ghOwner})"`,
    `GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo ${ghRepo})"`,
    '',
    '# Download and run the real bootstrap',
    'SCRIPT_URL="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}/infra/bootstrap/prime-bootstrap.sh"',
    'echo "==> Downloading bootstrap from: ${SCRIPT_URL}"',
    'curl -fsSL "${SCRIPT_URL}" -o /tmp/prime-bootstrap.sh',
    'chmod +x /tmp/prime-bootstrap.sh',
    'exec bash /tmp/prime-bootstrap.sh',
  ].join('\n');
}

