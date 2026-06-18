import { NextResponse } from "next/server";
import { getGitHubRawBase } from "@/lib/github";

const getGhRaw = () => `${getGitHubRawBase()}/main`;

/** Default theme for types without explicit glyph/accent */
const DEFAULT_THEME = { glyph: "🔹", accent: "#94a3b8" };

interface AgentType {
  id: string;
  title: string;
  glyph?: string;
  accent?: string;
}

interface KitJson {
  id: string;
  name: string;
  version: string;
  description: string;
  base_skills: string[];
  specialty_skills: string[];
  brain_appends: string[];
}

interface ResponsibilityEntry {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
}

/** Fetch JSON from GitHub, return null on failure */
async function ghJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${getGhRaw()}/${path}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * GET /api/agent-types/details
 *
 * Fetches kit.json + responsibilities from GitHub raw for ALL specialties.
 * Specialty list is driven by agent-types.json — no hardcoded list.
 */
export async function GET() {
  try {
    // Fetch the canonical agent type list — single source of truth
    const agentTypesData = await ghJson<{ types: AgentType[] }>(
      "corekit/config/agent-types.json"
    );
    if (!agentTypesData?.types?.length) {
      return NextResponse.json(
        { error: "Failed to load agent-types.json" },
        { status: 500 }
      );
    }

    const agentTypes = agentTypesData.types;

    // Fetch all kit.json files in parallel
    const kitResults = await Promise.all(
      agentTypes.map(async (agentType) => {
        const id = agentType.id;
        const kit = await ghJson<KitJson>(`specialties/${id}/kit.json`);
        if (!kit) return null;

        const theme = {
          glyph: agentType.glyph || DEFAULT_THEME.glyph,
          accent: agentType.accent || DEFAULT_THEME.accent,
        };

        // Fetch responsibilities
        const respData = await ghJson<{ responsibilities: ResponsibilityEntry[] }>(
          `specialties/${id}/responsibilities-${id}.json`
        );
        const responsibilities = (respData?.responsibilities || []).map((r) => ({
          id: r.id,
          name: r.name,
          schedule: r.schedule,
          enabled: r.enabled,
        }));

        return {
          id: kit.id,
          name: kit.name,
          version: kit.version,
          description: kit.description,
          glyph: theme.glyph,
          accent: theme.accent,
          base_skills: kit.base_skills,
          specialty_skills: kit.specialty_skills,
          brain_appends: kit.brain_appends,
          totalSkills: kit.base_skills.length + kit.specialty_skills.length,
          hasResponsibilities: responsibilities.length > 0,
          responsibilityCount: responsibilities.length,
          responsibilities,
        };
      })
    );

    // Filter out any that failed to load
    const specialties = kitResults.filter(Boolean);

    return NextResponse.json({ specialties });
  } catch (err) {
    console.error("[api/agent-types/details] Error:", err);
    return NextResponse.json(
      { error: "Failed to load specialty details" },
      { status: 500 }
    );
  }
}
