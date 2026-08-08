import { NextRequest, NextResponse } from "next/server";
import { getGitHubRawBase } from "@/lib/github";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id: primeId } = await ctx.params;
    const url = new URL(req.url);
    const agent = url.searchParams.get("agent") || "cortex";

    // 1. Fetch contracts.json for default subagent model
    const contractsUrl = `${getGitHubRawBase()}/main/infra/contracts.json`;
    let defaultDaemonModel = "gemini-3.5-flash";
    try {
      const contractsRes = await fetch(contractsUrl, { next: { revalidate: 300 } });
      if (contractsRes.ok) {
        const contracts = await contractsRes.json();
        const subagentRaw = contracts.vertex?.models?.subagent || "";
        // Extract bare ID (e.g. vertex-google/gemini-3.5-flash -> gemini-3.5-flash)
        const slashIdx = subagentRaw.indexOf("/");
        defaultDaemonModel = slashIdx >= 0 ? subagentRaw.slice(slashIdx + 1) : subagentRaw || defaultDaemonModel;
      }
    } catch (err) {
      console.warn("[api/brain-config] Failed to fetch contracts.json, using fallback default:", err);
    }

    // 2. Fetch agent registry based on target agentName
    const registryName = agent === "prime" ? "agent-registry-prime.json" : "agent-registry.json";
    const registryUrl = `${getGitHubRawBase()}/main/corekit/config/${registryName}`;
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

    return NextResponse.json({
      slots,
      defaultDaemonModel,
    });
  } catch (err) {
    console.error("[api/brain-config] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load brain config details" },
      { status: 500 }
    );
  }
}
