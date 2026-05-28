import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

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

interface SpecialtyDetail {
  id: string;
  name: string;
  version: string;
  description: string;
  glyph: string;
  accent: string;
  base_skills: string[];
  specialty_skills: string[];
  brain_appends: string[];
  totalSkills: number;
  hasResponsibilities: boolean;
  responsibilityCount: number;
  responsibilities: { id: string; name: string; schedule: string; enabled: boolean }[];
}

/**
 * GET /api/agent-types/details
 *
 * Reads kit.json files from the specialties/ directory in the repo root
 * and returns detailed data for the Agent Type Explorer page.
 */
export async function GET() {
  try {
    // Resolve the specialties directory relative to the project root
    const specialtiesDir = path.resolve(process.cwd(), "..", "specialties");

    if (!fs.existsSync(specialtiesDir)) {
      return NextResponse.json(
        { error: "Specialties directory not found", path: specialtiesDir },
        { status: 500 }
      );
    }

    const dirs = fs.readdirSync(specialtiesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const specialties: SpecialtyDetail[] = [];

    for (const dir of dirs) {
      const kitPath = path.join(specialtiesDir, dir, "kit.json");
      if (!fs.existsSync(kitPath)) continue;

      const kit: KitJson = JSON.parse(fs.readFileSync(kitPath, "utf-8"));
      const theme = THEMES[kit.id] || { glyph: "🔹", accent: "#94a3b8" };

      // Check for responsibilities file
      const respFileName = `responsibilities-${kit.id}.json`;
      const respPath = path.join(specialtiesDir, dir, respFileName);
      let responsibilities: ResponsibilityEntry[] = [];
      let hasResponsibilities = false;

      if (fs.existsSync(respPath)) {
        hasResponsibilities = true;
        try {
          const respData = JSON.parse(fs.readFileSync(respPath, "utf-8"));
          responsibilities = (respData.responsibilities || []).map(
            (r: ResponsibilityEntry) => ({
              id: r.id,
              name: r.name,
              schedule: r.schedule,
              enabled: r.enabled,
            })
          );
        } catch {
          // If parsing fails, still mark as having responsibilities
        }
      }

      specialties.push({
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
        hasResponsibilities,
        responsibilityCount: responsibilities.length,
        responsibilities,
      });
    }

    // Sort by the order in THEMES to maintain consistent display order
    const order = Object.keys(THEMES);
    specialties.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    return NextResponse.json({ specialties });
  } catch (err) {
    console.error("[api/agent-types/details] Error:", err);
    return NextResponse.json(
      { error: "Failed to load specialty details" },
      { status: 500 }
    );
  }
}
