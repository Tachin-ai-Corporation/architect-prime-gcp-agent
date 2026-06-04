import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";

/**
 * POST /api/primes/[id]/models/scan — Live model discovery from Cloud Run.
 *
 * 1. Queries Model Garden REST API for ALL models (publishers/*)
 * 2. Filters for text generation MaaS models
 * 3. Probes each model's endpoint to determine availability
 * 4. Returns results synchronously + writes to Firestore
 *
 * Zero curation — discovers everything Model Garden exposes.
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
  openclawId: string;
}

/* ---- Constants ---- */

// Keywords that indicate non-text models (image, video, audio, etc.)
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

// Models that are known to be discontinued
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
  // Fix "Deepseek" -> "DeepSeek"
  name = name.replace(/\bDeepseek\b/g, "DeepSeek");
  return name;
}

/* ---- Auth ---- */

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error("Cannot get access token — not running on GCP");
  const data = await res.json();
  return data.access_token;
}

/* ---- Model Garden API ---- */

async function fetchModelGarden(
  token: string,
  location: string,
): Promise<GardenModel[]> {
  // This is the same endpoint gcloud ai model-garden models list calls
  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/*/models?filter=is_hf_wildcard(false)&listAllVersions=True`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.error(`[models/scan] Model Garden API returned ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.publisherModels || [];
}

/* ---- Filter logic ---- */

interface ModelCandidate {
  id: string;
  provider: string;
  tier: string;
  probeType: "google-generate" | "anthropic-raw" | "openai-maas";
}

function filterModels(gardenModels: GardenModel[]): ModelCandidate[] {
  const candidates: Map<string, ModelCandidate> = new Map();

  for (const m of gardenModels) {
    const parts = (m.name || "").split("/");
    if (parts.length < 4) continue;
    const publisher = parts[1];
    const modelId = parts[3];

    // Exclude non-text models
    const lower = modelId.toLowerCase();
    if (EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw))) continue;

    // Exclude discontinued
    if (DISCONTINUED.has(modelId)) continue;

    // Determine if this model has MaaS access
    const actions = m.supportedActions || {};
    const hasAiStudio = "openGenerationAiStudio" in actions;
    const hasMaas = "openMaas" in actions;

    if (!hasAiStudio && !hasMaas) continue; // deploy-only, skip

    // Dedup: prefer base over -maas variant
    const baseId = modelId.replace(/-maas$/, "");
    if (modelId !== baseId && candidates.has(baseId)) continue;
    if (modelId === baseId && candidates.has(baseId + "-maas")) continue;
    if (candidates.has(modelId)) continue;

    // Determine probe type
    let probeType: ModelCandidate["probeType"];
    if (publisher === "google" && hasAiStudio) {
      probeType = "google-generate";
    } else if (publisher === "anthropic" && hasAiStudio) {
      probeType = "anthropic-raw";
    } else {
      // All third-party MaaS: Meta, Mistral, xAI, DeepSeek, AI21, etc.
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

    if (model.probeType === "google-generate") {
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

    // anthropic-raw
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

    // Step 1: Query Model Garden API for ALL models
    console.log("[models/scan] Querying Model Garden API...");
    const gardenModels = await fetchModelGarden(token, location);
    console.log(`[models/scan] Model Garden returned ${gardenModels.length} models`);

    // Step 2: Filter for text LLM MaaS candidates
    const candidates = filterModels(gardenModels);
    console.log(`[models/scan] Filtered to ${candidates.length} text LLM candidates`);

    // Step 3: Probe all models in parallel batches
    const BATCH_SIZE = 10;
    const results: ProbeResult[] = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const probes = batch.map(async (model) => {
        const code = await probeModel(model, token, projectId, location);
        let status: string;
        if (code === 200 || code === 429) status = "available";
        else if (code === 404) status = "not_found";
        else if (code === 401 || code === 403) status = "auth_error";
        else if (code === 0) status = "timeout";
        else status = "unknown";

        const openclawId = `google-vertex/${model.id}`;

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

    // Step 4: Write to Firestore
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
      gardenTotal: gardenModels.length,
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
