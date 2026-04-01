import { NextRequest, NextResponse } from "next/server";
import { primesCol } from "@/lib/firestore";

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
 *   3. Installs CoreKit (agent-ask, control-daemon, etc.)
 *   4. Writes prime-config.json with the Prime ID + project
 *   5. Installs control-daemon as a systemd service
 *   6. control-daemon starts → writes status:"online" to Firestore
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

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
  const machineType = `zones/${zone}/machineTypes/e2-small`;
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
 * Follows the same pattern as fleet-deploy:
 * - Reads ALL config from VM metadata attributes (no template vars)
 * - Downloads install.sh from the repo
 * - Installs CoreKit via manifest
 * - Sets up control-daemon as a systemd service
 */
const STARTUP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="/var/log/prime-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "===> Prime VM Phase 2: $(date -Is)"

# ---- Read config from VM metadata ----
META="http://metadata.google.internal/computeMetadata/v1"
MH="Metadata-Flavor: Google"
PRIME_ID="$(curl -sf -H "$MH" "$META/instance/attributes/prime_id" || echo 'unknown')"
AGENT_ID="$(curl -sf -H "$MH" "$META/instance/attributes/agent_id" || echo 'prime')"
CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || echo 'main')"
GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo 'Tachin-ai-Corporation')"
GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo 'architect-prime-gcp-agent')"
GCP_PROJECT_ID="$(curl -sf -H "$MH" "$META/project/project-id")"

echo "Prime ID: $PRIME_ID | Agent: $AGENT_ID | CoreRef: $CORE_REF"

# ---- Install packages ----
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq jq curl python3

# ---- Install CoreKit via manifest ----
OC_HOST_ROOT="/opt/openclaw"
mkdir -p "$OC_HOST_ROOT/.openclaw"

CORE_BASE="https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/$CORE_REF"
curl -sfL "$CORE_BASE/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
CORE_REF="$CORE_REF" GH_OWNER="$GH_OWNER" GH_REPO="$GH_REPO" OC_HOST_ROOT="$OC_HOST_ROOT" \\
  bash /tmp/install.sh

# ---- Write prime-config.json ----
cat > "$OC_HOST_ROOT/.openclaw/corekit/prime-config.json" <<PCFG
{
  "primeId": "$PRIME_ID",
  "projectId": "$GCP_PROJECT_ID",
  "role": "prime"
}
PCFG

# ---- Install control-daemon as systemd service ----
echo "===> Installing control-daemon systemd service"
cat > /etc/systemd/system/control-daemon.service <<UNIT
[Unit]
Description=Architect Prime Control Daemon (Firestore Polling)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=OC_HOST_ROOT=$OC_HOST_ROOT
Environment=AGENT_ID=$AGENT_ID
Environment=GCP_PROJECT_ID=$GCP_PROJECT_ID
Environment=PRIME_ID=$PRIME_ID
Environment=POLL_INTERVAL=5
ExecStart=$OC_HOST_ROOT/.openclaw/bin/control-daemon
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable control-daemon
systemctl start control-daemon

echo "===> PRIME VM SETUP COMPLETE"
`;
