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
 * Uses the proven Docker-based OpenClaw setup from phase2-vm.sh:
 * - Reads config from VM metadata
 * - Installs CoreKit via manifest
 * - Clones OpenClaw repo, builds Docker image, runs container
 * - Applies bootstrap config via docker exec RPC (with retry + baseHash)
 * - Starts control-daemon as systemd service (bridges Firestore → OpenClaw)
 */
const STARTUP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="/var/log/prime-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; exit 1' ERR

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

MY_TOKEN="$(openssl rand -hex 16)"
OC_HOST_ROOT="/opt/openclaw"
OC_HOST_DIR="$OC_HOST_ROOT/.openclaw"
CORE_BASE="https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/$CORE_REF"

echo "Prime ID: $PRIME_ID | Agent: $AGENT_ID | CoreRef: $CORE_REF"

# ---- Install system packages ----
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git python3 ca-certificates gnupg jq openssl docker.io
systemctl enable docker
systemctl start docker
DOCKER_GID="$(getent group docker | cut -d: -f3)"

# ---- Install CoreKit via manifest ----
echo "===> Installing CoreKit"
mkdir -p "$OC_HOST_DIR"
curl -sfL "$CORE_BASE/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
CORE_REF="$CORE_REF" GH_OWNER="$GH_OWNER" GH_REPO="$GH_REPO" OC_HOST_ROOT="$OC_HOST_ROOT" \\
  bash /tmp/install.sh

# ---- Save gateway token for control-daemon ----
mkdir -p /root/.openclaw
echo "$MY_TOKEN" > /root/.openclaw/.gateway-token
chmod 600 /root/.openclaw/.gateway-token

# ---- Clone + build OpenClaw Docker image ----
echo "===> Building OpenClaw Docker image"
cd /root
git clone https://github.com/openclaw/openclaw.git
cd openclaw
STABLE_COMMIT="$(git rev-parse origin/main)"
git checkout "$STABLE_COMMIT"
echo "Using OpenClaw commit: $STABLE_COMMIT"

cat > .env <<ENVEOF
GATEWAY_BIND=loopback
GATEWAY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=$MY_TOKEN
OPENCLAW_CONFIG_DIR=/home/node/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace
OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json
GOOGLE_CLOUD_PROJECT=$GCP_PROJECT_ID
GCLOUD_PROJECT=$GCP_PROJECT_ID
CLOUDSDK_CORE_PROJECT=$GCP_PROJECT_ID
GOOGLE_GENAI_USE_VERTEXAI=True
GOOGLE_CLOUD_LOCATION=global
ENVEOF

DOCKER_BUILDKIT=1 docker build -t openclaw:local .
docker rm -f openclaw-gateway > /dev/null 2>&1 || true

echo "===> Starting OpenClaw container"
docker run -d \\
  --name openclaw-gateway \\
  --network host \\
  --restart always \\
  --env-file .env \\
  -v "$OC_HOST_DIR:/home/node/.openclaw" \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  --group-add "$DOCKER_GID" \\
  openclaw:local

# ---- Wait for gateway readiness ----
echo "===> Waiting for OpenClaw gateway"
READY=false
MAX_WAIT=180
WAITED=0
while [[ "$WAITED" -lt "$MAX_WAIT" ]]; do
  if docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.get --json --params '{}' > /dev/null 2>&1; then
    READY=true
    break
  fi
  echo "  Gateway not ready yet (\${WAITED}s)..."
  sleep 5
  WAITED=$((WAITED + 5))
done
[[ "$READY" == "true" ]] || { echo "[ERROR] Gateway not ready after \${MAX_WAIT}s"; exit 1; }
echo "Gateway ready (took ~\${WAITED}s)"

# ---- Harden container perms ----
docker exec -u 0 openclaw-gateway bash -lc '
set -e
mkdir -p /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw
chmod 700 /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw/bin 2>/dev/null || true
chmod 700 /home/node/.openclaw/bin/oc 2>/dev/null || true
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
chown -R node:node /home/node/.openclaw
'

# ---- Render bootstrap config ----
echo "===> Rendering OpenClaw config"
python3 - <<PY
import pathlib
oc = pathlib.Path("$OC_HOST_DIR")
tmpl_path = oc / "corekit" / "openclaw-bootstrap.json5.tmpl"
out_path = pathlib.Path("/tmp/openclaw-bootstrap.json5")
tmpl = tmpl_path.read_text(encoding="utf-8")
tmpl = tmpl.replace("\$\{GCP_PROJECT_ID}", "$GCP_PROJECT_ID")
tmpl = tmpl.replace("\$\{MY_TOKEN}", "$MY_TOKEN")
out_path.write_text(tmpl, encoding="utf-8")
print("Wrote", out_path)
PY

# ---- Apply config via RPC (with retry + fresh baseHash) ----
echo "===> Applying config via RPC"
APPLY_OK=false
for attempt in 1 2 3 4 5; do
  CONFIG_GET_RAW="$(docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.get --json --params '{}' 2>&1)" || true
  BASE_HASH="$(python3 -c '
import json,sys,re
raw=sys.stdin.read()
m=re.search(r"\\{.*\\}", raw, re.S)
raw_json=m.group(0) if m else raw
try:
  j=json.loads(raw_json)
except Exception:
  sys.exit(0)
print(j.get("hash") or (j.get("payload") or {}).get("hash") or ((j.get("result") or {}).get("payload") or {}).get("hash") or "")
' <<<"$CONFIG_GET_RAW")"

  if [[ -z "$BASE_HASH" ]]; then
    echo "[WARN] config.get attempt $attempt: no baseHash. Retrying in 15s..."
    sleep 15
    continue
  fi
  echo "baseHash (attempt $attempt): $BASE_HASH"

  PARAMS="$(python3 - <<PYAPPLY
import json
raw=open("/tmp/openclaw-bootstrap.json5","r",encoding="utf-8").read()
print(json.dumps({"raw": raw, "baseHash": "$BASE_HASH", "note": "bootstrap"}))
PYAPPLY
)"

  if docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.apply --json --params "$PARAMS" 2>&1; then
    APPLY_OK=true
    break
  fi
  echo "[WARN] config.apply attempt $attempt failed. Retrying in 15s..."
  sleep 15
done

if [[ "$APPLY_OK" != "true" ]]; then
  echo "Checking if config was written despite errors..."
  sleep 10
  if docker exec openclaw-gateway test -f /home/node/.openclaw/openclaw.json 2>/dev/null; then
    echo "openclaw.json exists — config.apply likely succeeded."
    APPLY_OK=true
  else
    echo "[ERROR] config.apply failed after 5 attempts"
    exit 1
  fi
fi

# ---- Post-apply harden + inject Docker CLI ----
docker exec -u 0 openclaw-gateway bash -lc '
set -e
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
chmod 700 /home/node/.openclaw/bin/oc 2>/dev/null || true
chown -R node:node /home/node/.openclaw
' || true
docker cp "$(which docker)" openclaw-gateway:/usr/local/bin/docker || true
docker exec -u 0 openclaw-gateway chmod +x /usr/local/bin/docker || true
docker exec -u 0 openclaw-gateway groupadd -g "$DOCKER_GID" -o -r docker 2>/dev/null || true
docker exec -u 0 openclaw-gateway chown -R node:node /home/node/.openclaw || true

# ---- Write prime-config.json ----
cat > "$OC_HOST_DIR/corekit/prime-config.json" <<PCFG
{
  "primeId": "$PRIME_ID",
  "projectId": "$GCP_PROJECT_ID",
  "role": "prime"
}
PCFG

# ---- Install control-daemon as systemd service ----
echo "===> Installing control-daemon"
cat > /etc/systemd/system/control-daemon.service <<UNIT
[Unit]
Description=Architect Prime Control Daemon (Firestore Polling)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=OC_HOST_ROOT=$OC_HOST_ROOT
Environment=AGENT_ID=$AGENT_ID
Environment=GCP_PROJECT_ID=$GCP_PROJECT_ID
Environment=PRIME_ID=$PRIME_ID
Environment=POLL_INTERVAL=5
ExecStart=$OC_HOST_DIR/bin/control-daemon
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable control-daemon
systemctl start control-daemon

echo "===> PRIME VM SETUP COMPLETE"
echo "Gateway token: $MY_TOKEN"
echo "OpenClaw commit: $STABLE_COMMIT"
`;
