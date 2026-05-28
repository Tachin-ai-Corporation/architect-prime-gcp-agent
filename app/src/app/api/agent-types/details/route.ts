import { NextResponse } from "next/server";

const GH_RAW =
  "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/main";

/** Theme data per specialty */
const THEMES: Record<string, { glyph: string; accent: string }> = {
  devops:    { glyph: "⚙️", accent: "#38bdf8" },
  engineer:  { glyph: "🧪", accent: "#a78bfa" },
  qa:        { glyph: "🧭", accent: "#2dd4bf" },
  pm:        { glyph: "🗂️", accent: "#fbbf24" },
  finance:   { glyph: "📊", accent: "#34d399" },
  data:      { glyph: "🧮", accent: "#818cf8" },
  security:  { glyph: "🛡️", accent: "#fb7185" },
  assistant: { glyph: "🎯", accent: "#94a3b8" },
};

const SPECIALTY_IDS = Object.keys(THEMES);

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
    const res = await fetch(`${GH_RAW}/${path}`, {
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
 * Fetches kit.json + responsibilities from GitHub raw for all 8 specialties.
 * Works on Cloud Run (no filesystem dependency).
 */
export async function GET() {
  try {
    // Fetch all kit.json files in parallel
    const kitResults = await Promise.all(
      SPECIALTY_IDS.map(async (id) => {
        const kit = await ghJson<KitJson>(`specialties/${id}/kit.json`);
        if (!kit) return null;

        const theme = THEMES[id] || { glyph: "🔹", accent: "#94a3b8" };

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

    // Filter out any that failed to load, maintain THEMES order
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
