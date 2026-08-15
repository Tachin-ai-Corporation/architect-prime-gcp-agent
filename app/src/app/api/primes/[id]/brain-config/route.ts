import { NextRequest, NextResponse } from "next/server";
import { getGitHubRawBase } from "@/lib/github";
import { primesCol } from "@/lib/firestore";
import { resolveDeployedRef, contentUrlAt } from "@/lib/deployed-ref";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id: primeId } = await ctx.params;
    const url = new URL(req.url);
    const agent = url.searchParams.get("agent") || "cortex";

    // Read the prime's OWN deployed commit, not the tip of main. Which model a
    // brain slot uses is a fact about the code that is running; answering from
    // main means the panel can disagree with the daemon and be believed.
    const primeDoc = await primesCol().doc(primeId).get();
    const source = resolveDeployedRef(primeDoc.exists ? (primeDoc.data()?.coreRef as string | undefined) : undefined);

    // 1. Fetch contracts.json for default subagent model
    const contractsUrl = contentUrlAt(getGitHubRawBase(), source, "infra/contracts.json");
    let defaultDaemonModel = "gemini-3.6-flash";
    try {
      const contractsRes = await fetch(contractsUrl, { next: { revalidate: 300 } });
      if (contractsRes.ok) {
        const contracts = await contractsRes.json();
        const subagentRaw = contracts.vertex?.models?.subagent || "";
        // Extract bare ID (e.g. vertex-google/gemini-3.6-flash -> gemini-3.6-flash)
        const slashIdx = subagentRaw.indexOf("/");
        defaultDaemonModel = slashIdx >= 0 ? subagentRaw.slice(slashIdx + 1) : subagentRaw || defaultDaemonModel;
      }
    } catch (err) {
      console.warn("[api/brain-config] Failed to fetch contracts.json, using fallback default:", err);
    }

    // 2. Fetch agent registry based on target agentName
    const registryName = agent === "prime" ? "agent-registry-prime.json" : "agent-registry.json";
    const registryUrl = contentUrlAt(getGitHubRawBase(), source, `corekit/config/${registryName}`);
    const registryRes = await fetch(registryUrl, { next: { revalidate: 300 } });
    if (!registryRes.ok) {
      throw new Error(`Failed to fetch ${registryName}: ${registryRes.status}`);
    }

    const registry = await registryRes.json();
    const registryAgents = registry.agents || {};

    const slots = Object.entries(registryAgents).map(([key, data]: [string, any]) => {
      // Map Cortex role to "Decision authority", Prefrontal to "Decomposition" specifically as per D2.2/D4.6
      let desc = data.description || "";
      if (key === "cortex") desc = "Decision authority";
      else if (key === "prefrontal") desc = "Decomposition";

      return {
        key,
        desc,
        defaultModel: data.model || "",
        tools: data.tools || [],
      };
    });

    // Provenance rides with the payload: an unpinned prime still gets an answer,
    // and the caller can show it as "from main" rather than as fact.
    return NextResponse.json({
      slots,
      defaultDaemonModel,
      _source: source,
    });
  } catch (err) {
    console.error("[api/brain-config] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load brain config details" },
      { status: 500 }
    );
  }
}
