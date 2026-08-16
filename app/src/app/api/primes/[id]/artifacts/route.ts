import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ARTIFACTS_PREFIX = "artifacts/";

async function getGceToken(): Promise<string | null> {
  if (process.env.GCP_TOKEN) return process.env.GCP_TOKEN;
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
    // fall through
  }
  return null;
}

async function getProjectId(): Promise<string> {
  if (process.env.GCP_PROJECT_ID) return process.env.GCP_PROJECT_ID;
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/project/project-id",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
    );
    if (res.ok) return (await res.text()).trim();
  } catch {
    // fall through
  }
  return "unknown-project";
}

/**
 * GET /api/primes/[id]/artifacts?gcsPath=<object>
 * Streams a mission artifact. Session auth required; the object MUST live
 * under artifacts/primes/{id}/ — per-prime isolation is enforced here and
 * guaranteed by the upload layout in platform/persistence/artifact-share.mjs.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  const { id: primeId } = await ctx.params;
  try {
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const url = new URL(req.url);
    const gcsPath = url.searchParams.get("gcsPath");
    if (!gcsPath) {
      return NextResponse.json({ error: "Missing gcsPath parameter" }, { status: 400 });
    }

    const requiredPrefix = `${ARTIFACTS_PREFIX}primes/${primeId}/`;
    if (!gcsPath.startsWith(requiredPrefix) || gcsPath.includes("..")) {
      return NextResponse.json(
        { error: "Access denied: object outside this prime's artifact space" },
        { status: 403 }
      );
    }

    const gcpProject = await getProjectId();
    const bucket = (process.env.ARTIFACTS_BUCKET || "${TENANT}-agent-git").replace(
      "${TENANT}",
      gcpProject
    );

    const token = await getGceToken();
    if (!token) {
      return NextResponse.json(
        { error: "Unauthorized (no metadata credentials)" },
        { status: 401 }
      );
    }

    const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(gcsPath)}?alt=media`;
    const res = await fetch(gcsUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      return NextResponse.json(
        { error: `GCS retrieve failed: HTTP ${res.status}` },
        { status: res.status }
      );
    }

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
      "video/mp4",
    ];
    const disposition = safeInlineTypes.includes(contentType) ? "inline" : "attachment";
    headers.set(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(filename)}"`
    );

    const contentLength = res.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(res.body, { headers });
  } catch (err) {
    // `catch (err: any)` let `err.message` compile on a value that is not
    // required to have one. Anything can be thrown, so narrow before reading.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/primes/${primeId}/artifacts] Error streaming artifact:`, err);
    return NextResponse.json(
      { error: `Internal server error: ${message}` },
      { status: 500 }
    );
  }
}
