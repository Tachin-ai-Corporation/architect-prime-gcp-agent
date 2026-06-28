// API route: /api/telemetry/costs — Global LLM cost telemetry endpoint
// Reads telemetry data from Firestore and aggregates per-mission and per-organ costs.
// The brain daemon writes [TELEMETRY] llm_usage entries to envelope history.

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

interface LlmUsageEntry {
  organ: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  duration_ms: number;
  timestamp: string;
}

interface MissionCost {
  missionId: string;
  title: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalDurationMs: number;
  callCount: number;
  byOrgan: Record<string, { input: number; output: number; cached: number; calls: number }>;
}

export async function GET(req: NextRequest) {
  const primeId = req.nextUrl.searchParams.get("primeId");
  if (!primeId) {
    return NextResponse.json({ error: "primeId query param required" }, { status: 400 });
  }

  const agentFilter = req.nextUrl.searchParams.get("agent");

  try {
    const db = getDb();

    // Get recent completed missions (last 100 to allow client-side agent filtering)
    const query = db
      .collection("primes")
      .doc(primeId)
      .collection("work")
      .where("type", "==", "M")
      .where("status", "in", ["complete", "failed"])
      .orderBy("completed_at", "desc")
      .limit(100);

    const snap = await query.get();
    let docs = snap.docs;

    if (agentFilter) {
      const lowerAgent = agentFilter.toLowerCase();
      docs = docs.filter((doc) => {
        const owner = (doc.data().owner || "").toLowerCase();
        if (owner === lowerAgent) return true;
        const emailPrefix = owner.split("@")[0];
        if (emailPrefix === lowerAgent) return true;
        if (owner === "prime" && (lowerAgent === "prime" || lowerAgent.startsWith("prime-"))) {
          return true;
        }
        if ((lowerAgent === "prime" || lowerAgent.startsWith("prime-")) && (owner === "prime" || emailPrefix === "prime")) {
          return true;
        }
        const segments = emailPrefix.split(/[-_.]/);
        return segments.includes(lowerAgent);
      });
      // Limit to 50 after filtering
      docs = docs.slice(0, 50);
    }
    const missions: MissionCost[] = [];

    for (const doc of docs) {
      const data = doc.data();

      // Parse token_usage from the mission envelope
      const tokenUsage = data.token_usage;
      if (!tokenUsage) continue;

      const missionCost: MissionCost = {
        missionId: doc.id,
        title: data.title || data.instruction || data.intent || doc.id,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalDurationMs: 0,
        callCount: 0,
        byOrgan: {},
      };

      // tokenUsage may be an object with per-call entries or aggregated totals
      if (typeof tokenUsage === "object") {
        // Check for aggregated format: { total_input, total_output, calls: [...] }
        if (tokenUsage.total_input !== undefined) {
          missionCost.totalInputTokens = tokenUsage.total_input || 0;
          missionCost.totalOutputTokens = tokenUsage.total_output || 0;
          missionCost.totalCachedTokens = tokenUsage.total_cached || 0;
        }

        // Process individual calls if available
        const calls: LlmUsageEntry[] = Array.isArray(tokenUsage.calls) ? tokenUsage.calls : [];
        missionCost.callCount = calls.length || tokenUsage.call_count || 0;
        missionCost.totalDurationMs = tokenUsage.total_duration_ms || 0;

        for (const call of calls) {
          const organ = call.organ || "unknown";
          if (!missionCost.byOrgan[organ]) {
            missionCost.byOrgan[organ] = { input: 0, output: 0, cached: 0, calls: 0 };
          }
          missionCost.byOrgan[organ].input += call.input_tokens || 0;
          missionCost.byOrgan[organ].output += call.output_tokens || 0;
          missionCost.byOrgan[organ].cached += call.cached_tokens || 0;
          missionCost.byOrgan[organ].calls += 1;
        }
      }

      // Only include missions with actual cost data
      if (missionCost.totalInputTokens > 0 || missionCost.totalOutputTokens > 0 || missionCost.callCount > 0) {
        missions.push(missionCost);
      }
    }

    return NextResponse.json({ missions });
  } catch (err) {
    console.error("[api/telemetry/costs] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch telemetry" }, { status: 500 });
  }
}
