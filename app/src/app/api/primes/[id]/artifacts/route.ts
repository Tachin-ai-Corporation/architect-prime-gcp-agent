import { NextRequest, NextResponse } from "next/server";
import { getGitHubRawBase } from "@/lib/github";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function getGceToken(): Promise<string | null> {
  if (process.env.GCP_TOKEN) {
    return process.env.GCP_TOKEN;
  }
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
    );
    if (res.ok) {
      const data = await res.json();
      return data.access_token || null;
    }
  } catch {
    // fallback
  }
  return null;
}

async function getProjectId(): Promise<string> {
  if (process.env.GCP_PROJECT_ID) {
    return process.env.GCP_PROJECT_ID;
  }
  if (process.env.GCP_PROJECT) {
    return process.env.GCP_PROJECT;
  }
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/project/project-id",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
    );
    if (res.ok) {
      return (await res.text()).trim();
    }
  } catch {
    // fallback
  }
  return "unknown-project";
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id: primeId } = await ctx.params;
    const url = new URL(req.url);
    const gcsPath = url.searchParams.get("gcsPath");

    if (!gcsPath) {
      return NextResponse.json({ error: "Missing gcsPath parameter" }, { status: 400 });
    }

    // Security check: restrict path traversal, must stay inside artifacts/ prefix
    const contractsUrl = `${getGitHubRawBase()}/main/infra/contracts.json`;
    let contracts: any = {};
    try {
      const contractsRes = await fetch(contractsUrl, { next: { revalidate: 300 } });
      if (contractsRes.ok) {
        contracts = await contractsRes.json();
      }
    } catch (err) {
      console.warn("[artifacts-api] Failed to fetch contracts.json, using defaults:", err);
    }

    const gitConfig = contracts.git || {};
    const artifactsPrefix = gitConfig.artifacts_prefix || "artifacts/";

    if (!gcsPath.startsWith(artifactsPrefix)) {
      return NextResponse.json({ error: "Access Denied: Path outside artifacts workspace" }, { status: 403 });
    }

    const gcpProject = await getProjectId();
    const bucketTemplate = gitConfig.bucket || "${TENANT}-agent-git";
    const bucket = bucketTemplate.replace("${TENANT}", gcpProject);

    const encodedPath = encodeURIComponent(gcsPath);
    const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodedPath}?alt=media`;

    const token = await getGceToken();
    if (!token) {
      return NextResponse.json({ error: "Unauthorized (no metadata credentials)" }, { status: 401 });
    }

    const res = await fetch(gcsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `GCS retrieve failed: HTTP ${res.status}` }, { status: res.status });
    }

    const stream = res.body;
    const headers = new Headers();
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    headers.set("Content-Type", contentType);

    const filename = gcsPath.split("/").pop() || "artifact";
    const safeInlineTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "audio/mpeg",
      "video/mp4"
    ];
    const disposition = safeInlineTypes.includes(contentType) ? "inline" : "attachment";
    headers.set("Content-Disposition", `${disposition}; filename="${encodeURIComponent(filename)}"`);

    const contentLength = res.headers.get("content-length");
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new Response(stream, { headers });
  } catch (err: any) {
    console.error("[artifacts-api] Error streaming artifact:", err);
    return NextResponse.json({ error: `Internal server error: ${err.message}` }, { status: 500 });
  }
}
