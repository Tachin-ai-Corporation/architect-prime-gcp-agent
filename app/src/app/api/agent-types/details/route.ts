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

/** Fetch text from GitHub, return null on failure */
async function ghText(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${getGhRaw()}/${path}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
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
 * Count unique skill IDs from manifest files.
 * Matches skill.json lines under skills/ and specialties/ directories.
 */
function countSkillsInManifest(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const baseMatch = trimmed.match(/^skills\/([a-z0-9-]+)\/skill\.json\s/);
    if (baseMatch) { ids.add(baseMatch[1]); continue; }
    const specMatch = trimmed.match(/^specialties\/[a-z0-9-]+\/skills\/([a-z0-9-]+)\/skill\.json\s/);
    if (specMatch) ids.add(specMatch[1]);
  }
  return ids;
}

/**
 * GET /api/agent-types/details
 *
 * Fetches kit.json + responsibilities from GitHub raw for ALL specialties.
 * Specialty list is driven by agent-types.json — no hardcoded list.
 * Skill counts are derived from manifest files (base.txt + role-fleet.txt + job-{type}.txt).
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

    // Fetch shared manifests once (base + fleet are the same for all specialties)
    const [baseManifest, fleetManifest] = await Promise.all([
      ghText("infra/manifests/base.txt"),
      ghText("infra/manifests/role-fleet.txt"),
    ]);

    // Fetch all kit.json + job manifests in parallel
    const kitResults = await Promise.all(
      agentTypes.map(async (agentType) => {
        const id = agentType.id;
        const [kit, respData, jobManifest] = await Promise.all([
          ghJson<KitJson>(`specialties/${id}/kit.json`),
          ghJson<{ responsibilities: ResponsibilityEntry[] }>(
            `specialties/${id}/responsibilities-${id}.json`
          ),
          ghText(`infra/manifests/job-${id}.txt`),
        ]);
        if (!kit) return null;

        const theme = {
          glyph: agentType.glyph || DEFAULT_THEME.glyph,
          accent: agentType.accent || DEFAULT_THEME.accent,
        };

        const responsibilities = (respData?.responsibilities || []).map((r) => ({
          id: r.id,
          name: r.name,
          schedule: r.schedule,
          enabled: r.enabled,
        }));

        // Count total skills from all manifest layers
        const allSkillIds = new Set<string>();
        if (baseManifest) for (const sid of countSkillsInManifest(baseManifest)) allSkillIds.add(sid);
        if (fleetManifest) for (const sid of countSkillsInManifest(fleetManifest)) allSkillIds.add(sid);
        if (jobManifest) for (const sid of countSkillsInManifest(jobManifest)) allSkillIds.add(sid);

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
          totalSkills: allSkillIds.size,
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

