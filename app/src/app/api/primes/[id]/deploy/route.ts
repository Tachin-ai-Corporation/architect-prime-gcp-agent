import { NextRequest, NextResponse } from "next/server";
import { primesCol, commandsCol } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";
import { seedCoreProcesses } from "@/lib/seed-processes";
import { FieldValue } from "@google-cloud/firestore";

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

    // Update status to deploying
    await primesCol().doc(id).update({ status: "deploying" });

    // Seed core processes (p-plan, p-investigate) — idempotent
    seedCoreProcesses(id).catch((err) =>
      console.error(`[deploy] Failed to seed core processes:`, err)
    );

    // Create the VM via Compute Engine REST API
    const token = await getAccessToken();
    const vmResult = await createVM(token, projectId, zone, vmName, id);

    if (!vmResult.ok) {
      const err = await vmResult.text();
      console.error(`[deploy] VM creation failed: ${err}`);
      await primesCol().doc(id).update({ status: "error" });
      return NextResponse.json(
        { error: "VM creation failed", details: err },
        { status: 500 }
      );
    }

    // Write a command doc so Operations panel tracks the deploy
    try {
      await commandsCol(id).doc().set({
        type: "prime_deploy",
        args: { vmName, zone },
        status: "running",
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn(`[deploy] Failed to write command doc:`, e);
    }

    return NextResponse.json({
      status: "deploying",
      vmName,
      zone,
      message: `VM ${vmName} is being created. Prime will come online in ~10 minutes.`,
    });
  } catch (err) {
    console.error(`[deploy] Error:`, err);
    await primesCol().doc(id).update({ status: "error" }).catch(() => {});
    return NextResponse.json({ error: "Deploy failed" }, { status: 500 });
  }
}

/**
 * Get access token from the metadata server (Cloud Run SA).
 */
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

/**
 * Create a GCE VM via the Compute Engine REST API.
 *
 * Follows the fleet-deploy pattern: all config passed as
 * metadata attributes, startup script reads from metadata.
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
        { key: "startup-script", value: STARTUP_SCRIPT },
        { key: "prime_id", value: primeId },
        { key: "agent_id", value: "prime" },
        { key: "core_ref", value: "main" },
        { key: "gh_owner", value: "Tachin-ai-Corporation" },
        { key: "gh_repo", value: "architect-prime-gcp-agent" },
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
 * brain gateway setup, agent-ears, agent-mouth) is in infra/bootstrap/prime-bootstrap.sh.
 *
 * Why: embedding 230 lines of bash inside a JS template literal
 * caused 5 consecutive deploy failures due to escape conflicts
 * (JS template → bash → python heredocs). Never again.
 */
const STARTUP_SCRIPT = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'exec > >(tee -a /var/log/prime-setup.log) 2>&1',
  '',
  '# Read repo coordinates from VM metadata',
  'META="http://metadata.google.internal/computeMetadata/v1"',
  'MH="Metadata-Flavor: Google"',
  'CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || echo main)"',
  'GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo Tachin-ai-Corporation)"',
  'GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo architect-prime-gcp-agent)"',
  '',
  '# Download and run the real bootstrap',
  'SCRIPT_URL="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}/infra/bootstrap/prime-bootstrap.sh"',
  'echo "==> Downloading bootstrap from: ${SCRIPT_URL}"',
  'curl -fsSL "${SCRIPT_URL}" -o /tmp/prime-bootstrap.sh',
  'chmod +x /tmp/prime-bootstrap.sh',
  'exec bash /tmp/prime-bootstrap.sh',
].join('\n');

