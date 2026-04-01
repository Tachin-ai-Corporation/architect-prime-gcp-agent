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

    // Build the startup script that installs CoreKit + control-daemon
    const startupScript = buildStartupScript(projectId, id, vmName);

    // Create the VM via Compute Engine REST API
    const token = await getAccessToken();
    const vmResult = await createVM(token, projectId, zone, vmName, startupScript);

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
  // On Cloud Run, use the metadata server
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) {
    // Fallback: try gcloud for local dev
    throw new Error("Cannot get access token — not running on GCP");
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Create a GCE VM via the Compute Engine REST API.
 */
async function createVM(
  token: string,
  projectId: string,
  zone: string,
  vmName: string,
  startupScript: string
): Promise<Response> {
  const machineType = `zones/${zone}/machineTypes/e2-small`;
  const sourceImage = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts";

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
      ],
    },
    tags: { items: ["architect-prime"] },
    serviceAccounts: [
      {
        scopes: [
          "https://www.googleapis.com/auth/cloud-platform",
        ],
      },
    ],
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
 * Build the VM startup script that installs OpenClaw + CoreKit
 * and starts the control-daemon (Firestore polling).
 */
function buildStartupScript(projectId: string, primeId: string, vmName: string): string {
  const REPO = "https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent";
  const CORE_REF = "main";

  return `#!/usr/bin/env bash
set -euo pipefail
exec > /var/log/prime-setup.log 2>&1

echo "==> Phase 2: Prime VM Setup"
echo "Project: ${projectId}"
echo "Prime ID: ${primeId}"
echo "VM: ${vmName}"

# ---- Install Docker ----
echo "==> Installing Docker..."
apt-get update -qq
apt-get install -y -qq docker.io curl python3 jq
systemctl enable docker
systemctl start docker

# ---- Install CoreKit ----
echo "==> Installing CoreKit..."
export OC_HOST_ROOT=/opt/openclaw
mkdir -p "\$OC_HOST_ROOT/.openclaw/bin"
curl -fsSL "${REPO}/raw/${CORE_REF}/install.sh" | bash -s -- ${CORE_REF}

# ---- Build OpenClaw container ----
echo "==> Building OpenClaw container..."
cd "\$OC_HOST_ROOT"
docker build -t openclaw -f .openclaw/Dockerfile . 2>/dev/null || true

# ---- Install control-daemon as systemd service ----
echo "==> Installing control-daemon..."
cat > /etc/systemd/system/control-daemon.service << 'UNIT'
[Unit]
Description=Architect Prime Control Daemon (Firestore Polling)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=OC_HOST_ROOT=/opt/openclaw
Environment=AGENT_ID=prime
Environment=GCP_PROJECT_ID=${projectId}
Environment=PRIME_ID=${primeId}
Environment=POLL_INTERVAL=5
ExecStart=/opt/openclaw/.openclaw/bin/control-daemon
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable control-daemon
systemctl start control-daemon

echo "==> DONE"
`;
}
