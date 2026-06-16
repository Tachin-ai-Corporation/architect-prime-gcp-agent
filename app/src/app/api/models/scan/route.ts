import { NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";

/**
 * POST /api/models/scan — Live model discovery from Cloud Run.
 *
 * Project-scoped: queries Model Garden for the GCP project, not tied to any Prime.
 * Results stored in Firestore at config/models for project-wide access.
 *
 * 1. Queries Model Garden REST API for ALL models (publishers/*)
 * 2. Filters for text generation MaaS models
 * 3. Probes each model's endpoint to determine availability
 * 4. Returns results synchronously + writes to Firestore
 */

/* ---- Types ---- */

interface GardenModel {
  name: string; // "publishers/google/models/gemini-2.5-pro"
  supportedActions?: Record<string, unknown>;
  launchStage?: string;
}

interface ProbeResult {
  id: string;
  name: string;
  tier: string;
  provider: string;
  status: string;
  httpCode: number;
  brainModelId: string;
}

/* ---- Constants ---- */

const EXCLUDE_KEYWORDS = [
  "image", "video", "veo", "lyria", "tts", "try-on", "embed",
  "segment", "detect", "vision", "translate", "shield", "weather",
  "path-foundation", "derm", "hear", "medasr", "medsiglip", "ocr",
  "computer-use", "virtual", "sam3", "reward", "guard", "safety",
  "speech", "cxr-foundation", "prompt-optimizer", "code-gecko",
  "code-bison", "text-bison", "chat-bison", "text-unicorn",
  "efficientnet", "vit", "paligemma", "controlnet", "diffusion",
  "whisper", "bert", "t5-", "flan-t5", "chirp", "musicgen",
  "encoder", "decoder-only-tokenizer", "classification",
  "summarization", "nllb", "madlad", "timesfm", "tapas",
  "byot5", "ul2", "switch-", "palm-", "gecko-", "moirai",
  "imagegen", "imagen", "stable-diffusion", "sdxl", "sana",
  "flux", "hunyuan", "ltx-video", "wan", "cosmos",
  "grounding-dino", "owlv2", "detr", "yolo",
  "molmo", "patchscopes", "sparsetsr",
];

const DISCONTINUED = new Set([
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
]);

/* ---- Display name generator ---- */

function makeName(mid: string): string {
  const displayId = mid.replace(/-maas$/, "");
  const parts = displayId.split("-");
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (/^\d+$/.test(p) && i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
      out.push(`${p}.${parts[i + 1]}`);
      i += 2;
      continue;
    }
    out.push(/^\d{3,4}$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1));
    i++;
  }
  let name = out.join(" ");
  const brands = [
    "Gemini", "Claude", "Flash", "Pro", "Opus", "Sonnet", "Haiku", "Lite", "Preview",
    "Llama", "Mistral", "Large", "Medium", "Small", "Nemo", "Codestral", "Pixtral",
    "Instruct", "Chat", "Maverick", "Scout", "Jamba", "Mini",
    "Grok", "Deepseek", "DeepSeek",
  ];
  for (const b of brands) {
    name = name.replace(new RegExp(`\\b${b}\\b`, "gi"), b);
  }
  name = name.replace(/\bDeepseek\b/g, "DeepSeek");
  return name;
}

/* ---- Brain model ID helpers ---- */

function toBrainModelId(modelId: string, provider: string): string {
  if (provider === "anthropic") return `vertex-anthropic/${modelId}`;
  if (provider === "google")    return `vertex-google/${modelId}`;
  return `vertex-maas/${provider}/${modelId}`;
}

/** Vertex AI hostname — global endpoint has no region prefix */
function vertexHost(location: string): string {
  if (location === "global") return "https://aiplatform.googleapis.com";
  return `https://${location}-aiplatform.googleapis.com`;
}

/* ---- Auth ---- */

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cannot get access token (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

/* ---- Model Garden API ---- */

async function fetchModelGarden(
  token: string,
  location: string,
): Promise<{ models: GardenModel[]; error?: string }> {
  // Same endpoint gcloud ai model-garden models list calls,
  // including alt=json that gcloud adds
  const baseUrl = `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/*/models`;
  const allModels: GardenModel[] = [];
  let pageToken: string | undefined;

  // Paginate through all results
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      alt: "json",
      filter: "is_hf_wildcard(false)",
      listAllVersions: "True",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `${baseUrl}?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const errMsg = `Model Garden API returned ${res.status}: ${body.slice(0, 500)}`;
      console.error(`[models/scan] ${errMsg}`);
      return { models: [], error: errMsg };
    }

    const data = await res.json();
    const pageModels = data.publisherModels || [];
    allModels.push(...pageModels);

    // Check for next page
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
    } else {
      break;
    }
  }

  return { models: allModels };
}

/* ---- Filter logic ---- */

interface ModelCandidate {
  id: string;
  provider: string;
  tier: string;
  probeType: "google-generate" | "anthropic-raw" | "openai-maas";
}

/**
 * MaaS-only publishers NOT in the Model Garden API listing.
 * These are direct partners that only appear in the UI.
 * We add them as candidates and let probing determine availability.
 */
const MAAS_ONLY_MODELS: ModelCandidate[] = [
  // Anthropic — rawPredict
  { id: "claude-sonnet-4-6",   provider: "anthropic", tier: "ga", probeType: "anthropic-raw" },
  { id: "claude-sonnet-4-5",   provider: "anthropic", tier: "ga", probeType: "anthropic-raw" },
  { id: "claude-opus-4-7",     provider: "anthropic", tier: "ga", probeType: "anthropic-raw" },
  { id: "claude-opus-4-6",     provider: "anthropic", tier: "ga", probeType: "anthropic-raw" },
  { id: "claude-opus-4-5",     provider: "anthropic", tier: "ga", probeType: "anthropic-raw" },
  { id: "claude-opus-4-1",     provider: "anthropic", tier: "ga", probeType: "anthropic-raw" },
  { id: "claude-haiku-4-5",    provider: "anthropic", tier: "ga", probeType: "anthropic-raw" },
  // xAI — OpenAI-compatible
  { id: "grok-3",              provider: "xai", tier: "ga",      probeType: "openai-maas" },
  { id: "grok-3-mini",         provider: "xai", tier: "ga",      probeType: "openai-maas" },
  { id: "grok-4-20",           provider: "xai", tier: "preview", probeType: "openai-maas" },
  { id: "grok-4-20-reasoning", provider: "xai", tier: "preview", probeType: "openai-maas" },
];

/**
 * Publishers whose models should NOT be probed (deploy-only, not text LLMs, etc.)
 * These return hundreds of models in the API but none are MaaS text generation.
 */
const SKIP_PUBLISHERS = new Set([
  "advimman", "dandelin", "ifzhang", "impira", "intfloat",
  "liuhaotian", "lllyasviel", "lmsys", "openlm-research",
  "runwayml", "timbrooks", "tiiuae", "xiaomimimo",
  "stability-ai", "autogluon-ai",
]);

function filterModels(gardenModels: GardenModel[]): ModelCandidate[] {
  const candidates: Map<string, ModelCandidate> = new Map();

  for (const m of gardenModels) {
    const parts = (m.name || "").split("/");
    if (parts.length < 4) continue;
    const publisher = parts[1];
    const modelId = parts[3];

    // Skip known non-MaaS publishers
    if (SKIP_PUBLISHERS.has(publisher)) continue;

    const lower = modelId.toLowerCase();
    if (EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw))) continue;
    if (DISCONTINUED.has(modelId)) continue;

    const actions = m.supportedActions || {};
    const hasAiStudio = "openGenerationAiStudio" in actions;

    // For Google: require openGenerationAiStudio (avoids 100+ deploy-only models)
    if (publisher === "google" && !hasAiStudio) continue;

    // Dedup: prefer base over -maas variant
    const baseId = modelId.replace(/-maas$/, "");
    if (modelId !== baseId && candidates.has(baseId)) continue;
    if (modelId === baseId && candidates.has(baseId + "-maas")) continue;
    if (candidates.has(modelId)) continue;

    // Determine probe type
    let probeType: ModelCandidate["probeType"];
    if (publisher === "google" && hasAiStudio) {
      probeType = "google-generate";
    } else {
      // All non-Google models: try OpenAI-compatible endpoint
      probeType = "openai-maas";
    }

    const launch = (m.launchStage || "PREVIEW").toUpperCase();

    candidates.set(modelId, {
      id: modelId,
      provider: publisher,
      tier: launch === "GA" ? "ga" : "preview",
      probeType,
    });
  }

  // Add MaaS-only publishers not in the API
  for (const m of MAAS_ONLY_MODELS) {
    if (!candidates.has(m.id)) {
      candidates.set(m.id, m);
    }
  }

  return Array.from(candidates.values());
}

/* ---- Probing ---- */

async function probeModel(
  model: ModelCandidate,
  token: string,
  projectId: string,
  location: string,
): Promise<number> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const timeout = 10_000;

  try {
    if (model.probeType === "openai-maas") {
      const url = `${vertexHost(location)}/v1beta1/projects/${projectId}/locations/${location}/endpoints/openapi/chat/completions`;
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

    if (model.probeType === "google-generate") {
      const regionalUrl = `${vertexHost(location)}/v1beta1/projects/${projectId}/locations/${location}/publishers/google/models/${model.id}:generateContent`;
      const body = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "pong" }] }],
        generationConfig: { maxOutputTokens: 5 },
      });
      const res = await fetch(regionalUrl, {
        method: "POST", headers, body,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 200 || res.status === 429) return res.status;

      // Regional 404 → try global endpoint (some GA models like gemini-3.5-flash are global-only)
      const globalUrl = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model.id}:generateContent`;
      const gRes = await fetch(globalUrl, {
        method: "POST", headers, body,
        signal: AbortSignal.timeout(timeout),
      });
      if (gRes.status === 200 || gRes.status === 429) return gRes.status;
      return gRes.status || res.status;
    }

    // anthropic-raw
    const url = `${vertexHost(location)}/v1/projects/${projectId}/locations/${location}/publishers/${model.provider}/models/${model.id}:rawPredict`;
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
    return 0;
  }
}

/* ---- Route handler ---- */

export async function POST() {
  try {
    const auth = await requireAuth();
    if (!auth.authenticated) return auth.response;

    const projectId = process.env.GCP_PROJECT_ID!;
    const location = process.env.GCP_REGION || "us-central1";

    // Step 0: Get auth token
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      return NextResponse.json({
        error: "Failed to get access token",
        details: String(err),
        hint: "Cloud Run metadata server may not be available",
      }, { status: 500 });
    }

    // Step 1: Query Model Garden API
    console.log(`[models/scan] Querying Model Garden API (project=${projectId}, location=${location})...`);
    const gardenResult = await fetchModelGarden(token, location);

    if (gardenResult.error) {
      return NextResponse.json({
        error: "Model Garden API failed",
        details: gardenResult.error,
        models: [],
        discovered: 0,
        available: 0,
        gardenTotal: 0,
      }, { status: 200 }); // 200 so frontend can show the error
    }

    console.log(`[models/scan] Model Garden returned ${gardenResult.models.length} models`);

    // Step 2: Filter for text LLM MaaS candidates
    const candidates = filterModels(gardenResult.models);
    console.log(`[models/scan] Filtered to ${candidates.length} text LLM candidates`);

    // Step 3: Probe all models in parallel batches
    const BATCH_SIZE = 10;
    const results: ProbeResult[] = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const probes = batch.map(async (model) => {
        const code = await probeModel(model, token, projectId, location);
        let status: string;
        if (code === 200 || code === 429 || code === 400) status = "available"; // 400 = endpoint exists but probe payload rejected (e.g. old anthropic_version)
        else if (code === 404) status = "not_found";
        else if (code === 401 || code === 403) status = "auth_error";
        else if (code === 0) status = "timeout";
        else status = "unknown";

        const brainModelId = toBrainModelId(model.id, model.provider);

        return {
          id: model.id,
          name: makeName(model.id),
          tier: model.tier,
          provider: model.provider,
          status,
          httpCode: code,
          brainModelId,
        };
      });
      const batchResults = await Promise.all(probes);
      results.push(...batchResults);
    }

    // Sort: available first, then by provider, then by name
    results.sort((a, b) => {
      if (a.status === "available" && b.status !== "available") return -1;
      if (a.status !== "available" && b.status === "available") return 1;
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.name.localeCompare(b.name);
    });

    const available = results.filter((r) => r.status === "available");
    const bestModel = available.length > 0 ? available[0].id : "";

    console.log(`[models/scan] Discovered ${results.length} models, ${available.length} available`);

    // Step 4: Write to Firestore at project level
    const db = getDb();
    const scanData = {
      modelCatalog: results,
      modelScannedAt: new Date().toISOString(),
      bestAvailableModel: bestModel,
      gardenTotal: gardenResult.models.length,
    };

    // Write to project-level config
    await db.collection("config").doc("models").set(scanData, { merge: true });

    // Also write to each Prime's config for backward compat with Brain page
    const primesSnap = await db.collection("primes").get();
    const primeWrites = primesSnap.docs.map((doc) =>
      db.collection("primes").doc(doc.id)
        .collection("config").doc("settings")
        .set(scanData, { merge: true })
    );
    await Promise.all(primeWrites);

    return NextResponse.json({
      models: results,
      bestModel,
      discovered: results.length,
      available: available.length,
      gardenTotal: gardenResult.models.length,
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
