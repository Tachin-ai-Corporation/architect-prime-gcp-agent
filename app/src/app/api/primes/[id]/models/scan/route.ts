import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";

/**
 * POST /api/primes/[id]/models/scan — Scan Model Garden directly from Cloud Run.
 *
 * No VM involvement. Probes Vertex AI endpoints using the Cloud Run SA token.
 * Returns results synchronously and writes to Firestore.
 */

/* ---- Model catalog ---- */

interface ModelDef {
  id: string;
  provider: string;
  tier: "ga" | "preview";
  probeType: "google" | "anthropic" | "openai-maas";
}

/**
 * Curated model catalog.
 *
 * Google/Anthropic models come from `gcloud ai model-garden models list` (openGenerationAiStudio).
 * Meta/Mistral models are NOT in that listing — they use the OpenAI-compatible MaaS endpoint.
 * Update this list when new models appear in Model Garden.
 */
const MODEL_CATALOG: ModelDef[] = [
  // Google — generateContent
  { id: "gemini-3.1-pro-preview",        provider: "google",    tier: "preview", probeType: "google" },
  { id: "gemini-3.1-flash-lite-preview",  provider: "google",    tier: "preview", probeType: "google" },
  { id: "gemini-3.1-flash-lite",          provider: "google",    tier: "ga",      probeType: "google" },
  { id: "gemini-3.5-flash",              provider: "google",    tier: "preview", probeType: "google" },
  { id: "gemini-2.5-pro",                provider: "google",    tier: "ga",      probeType: "google" },
  { id: "gemini-2.5-flash",              provider: "google",    tier: "ga",      probeType: "google" },
  { id: "gemini-2.0-flash-001",          provider: "google",    tier: "ga",      probeType: "google" },
  { id: "gemini-2.0-flash-lite-001",     provider: "google",    tier: "ga",      probeType: "google" },

  // Anthropic — rawPredict
  { id: "claude-sonnet-4-6",   provider: "anthropic", tier: "ga",      probeType: "anthropic" },
  { id: "claude-sonnet-4-5",   provider: "anthropic", tier: "ga",      probeType: "anthropic" },
  { id: "claude-opus-4-7",     provider: "anthropic", tier: "ga",      probeType: "anthropic" },
  { id: "claude-opus-4-6",     provider: "anthropic", tier: "ga",      probeType: "anthropic" },
  { id: "claude-opus-4-5",     provider: "anthropic", tier: "ga",      probeType: "anthropic" },
  { id: "claude-opus-4-1",     provider: "anthropic", tier: "ga",      probeType: "anthropic" },
  { id: "claude-haiku-4-5",    provider: "anthropic", tier: "ga",      probeType: "anthropic" },

  // Meta Llama — OpenAI-compatible MaaS endpoint
  { id: "llama-4-scout-17b-16e-instruct-maas",    provider: "meta",      tier: "preview", probeType: "openai-maas" },
  { id: "llama-4-maverick-17b-128e-instruct-maas", provider: "meta",      tier: "preview", probeType: "openai-maas" },
  { id: "llama-3.3-70b-instruct-maas",             provider: "meta",      tier: "ga",      probeType: "openai-maas" },
  { id: "llama-3.2-90b-vision-instruct-maas",      provider: "meta",      tier: "ga",      probeType: "openai-maas" },

  // Mistral — OpenAI-compatible MaaS endpoint
  { id: "mistral-large-2411",   provider: "mistralai", tier: "ga", probeType: "openai-maas" },
  { id: "mistral-small-2503",   provider: "mistralai", tier: "ga", probeType: "openai-maas" },
  { id: "mistral-nemo-2407",    provider: "mistralai", tier: "ga", probeType: "openai-maas" },
  { id: "codestral-2501",       provider: "mistralai", tier: "ga", probeType: "openai-maas" },
];

/* ---- Display name generator ---- */

function makeName(mid: string): string {
  // Strip -maas suffix for display
  const displayId = mid.replace(/-maas$/, "");
  const parts = displayId.split("-");
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    // Join consecutive digit groups with a dot: "2" + "5" -> "2.5"
    if (/^\d+$/.test(p) && i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
      out.push(`${p}.${parts[i + 1]}`);
      i += 2;
      continue;
    }
    // Keep 3-digit version numbers as-is (e.g., "001")
    out.push(/^\d{3}$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1));
    i++;
  }
  let name = out.join(" ");
  // Brand name casing
  const brands = [
    "Gemini", "Claude", "Flash", "Pro", "Opus", "Sonnet", "Haiku", "Lite", "Preview",
    "Llama", "Mistral", "Large", "Medium", "Small", "Nemo", "Codestral", "Pixtral",
    "Instruct", "Chat", "Maverick", "Scout", "Jamba", "Mini",
  ];
  for (const b of brands) {
    name = name.replace(new RegExp(`\\b${b}\\b`, "gi"), b);
  }
  return name;
}

/* ---- Probing ---- */

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error("Cannot get access token — not running on GCP");
  const data = await res.json();
  return data.access_token;
}

async function probeModel(
  model: ModelDef,
  token: string,
  projectId: string,
  location: string,
): Promise<number> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const timeout = 15_000;

  try {
    if (model.probeType === "openai-maas") {
      const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/endpoints/openapi/chat/completions`;
      const body = JSON.stringify({
        model: `${model.provider}/${model.id}`,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      });
      const res = await fetch(url, {
        method: "POST", headers, body,
        signal: AbortSignal.timeout(timeout),
      });
      return res.status;
    }

    if (model.probeType === "google") {
      // Regional first
      const regionalUrl = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/publishers/google/models/${model.id}:generateContent`;
      const body = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "pong" }] }],
        generationConfig: { maxOutputTokens: 5 },
      });
      const res = await fetch(regionalUrl, {
        method: "POST", headers, body,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 200 || res.status === 429) return res.status;

      // Global fallback for preview models
      if (model.tier === "preview") {
        const globalUrl = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model.id}:generateContent`;
        const gRes = await fetch(globalUrl, {
          method: "POST", headers, body,
          signal: AbortSignal.timeout(timeout),
        });
        if (gRes.status === 200 || gRes.status === 429) return gRes.status;
        return gRes.status || res.status;
      }
      return res.status;
    }

    // Anthropic — rawPredict
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/${model.provider}/models/${model.id}:rawPredict`;
    const body = JSON.stringify({
      anthropic_version: "vertex-2023-10-16",
      max_tokens: 5,
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await fetch(url, {
      method: "POST", headers, body,
      signal: AbortSignal.timeout(timeout),
    });
    return res.status;
  } catch {
    return 0; // timeout or network error
  }
}

/* ---- Route handler ---- */

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: primeId } = await params;
  try {
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const projectId = process.env.GCP_PROJECT_ID!;
    const location = process.env.GCP_REGION || "us-central1";
    const token = await getAccessToken();

    // Probe all models in parallel (batched to avoid overwhelming)
    const BATCH_SIZE = 8;
    const results: Array<{
      id: string;
      name: string;
      tier: string;
      provider: string;
      status: string;
      httpCode: number;
      openclawId: string;
    }> = [];

    for (let i = 0; i < MODEL_CATALOG.length; i += BATCH_SIZE) {
      const batch = MODEL_CATALOG.slice(i, i + BATCH_SIZE);
      const probes = batch.map(async (model) => {
        const code = await probeModel(model, token, projectId, location);
        let status: string;
        if (code === 200 || code === 429) status = "available";
        else if (code === 404) status = "not_found";
        else if (code === 401 || code === 403) status = "auth_error";
        else if (code === 0) status = "timeout";
        else status = "unknown";

        const openclawId = model.provider === "google"
          ? `google-vertex/${model.id}`
          : `vertex_ai/${model.id}`;

        return {
          id: model.id,
          name: makeName(model.id),
          tier: model.tier,
          provider: model.provider,
          status,
          httpCode: code,
          openclawId,
        };
      });
      const batchResults = await Promise.all(probes);
      results.push(...batchResults);
    }

    const available = results.filter((r) => r.status === "available");
    const bestModel = available.length > 0 ? available[0].id : "";

    // Write to Firestore
    const db = getDb();
    await db
      .collection("primes").doc(primeId)
      .collection("config").doc("settings")
      .set({
        modelCatalog: results,
        modelScannedAt: new Date().toISOString(),
        bestAvailableModel: bestModel,
      }, { merge: true });

    return NextResponse.json({
      models: results,
      bestModel,
      discovered: results.length,
      available: available.length,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[api/models/scan] POST error:", err);
    return NextResponse.json(
      { error: "Failed to scan models", details: String(err) },
      { status: 500 }
    );
  }
}
