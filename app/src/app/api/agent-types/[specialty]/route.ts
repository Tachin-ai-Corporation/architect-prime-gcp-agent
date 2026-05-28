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

/* ---- Helpers ---- */

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function safeJsonParse<T>(filePath: string): T | null {
  const content = safeRead(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function fileMeta(filePath: string): { exists: boolean; sizeBytes: number; preview: string } {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      exists: true,
      sizeBytes: stat.size,
      preview: content.slice(0, 200),
    };
  } catch {
    return { exists: false, sizeBytes: 0, preview: "" };
  }
}

/* ---- Types ---- */

interface KitJson {
  id: string;
  name: string;
  version: string;
  description: string;
  base_skills: string[];
  specialty_skills: string[];
  brain_appends: string[];
}

interface ResponsibilityContext {
  purpose?: string;
  process?: string[];
  reference_files?: string[];
  success_criteria?: string;
  prior_learnings?: string;
}

interface Responsibility {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  min_spacing_minutes?: number;
  instruction: string;
  context?: ResponsibilityContext;
}

interface SkillManifest {
  id: string;
  name: string;
  description: string;
  category?: string;
  agent_part?: string;
  version?: string;
  skillMdContent?: string;
}

interface BrainAppend {
  part: string;
  exists: boolean;
  content: string;
}

interface WorkspaceFile {
  name: string;
  exists: boolean;
  sizeBytes: number;
  preview: string;
}

/**
 * GET /api/agent-types/[specialty]
 *
 * Returns full detail for a single specialty: kit, SOUL, brain appends,
 * responsibilities, skills, workspace files.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ specialty: string }> }
) {
  try {
    const { specialty } = await params;

    // Validate specialty name (alphanumeric + dash only)
    if (!/^[a-z0-9-]+$/.test(specialty)) {
      return NextResponse.json({ error: "Invalid specialty" }, { status: 400 });
    }

    const specialtiesDir = path.resolve(process.cwd(), "..", "specialties");
    const specDir = path.join(specialtiesDir, specialty);

    if (!fs.existsSync(specDir)) {
      return NextResponse.json({ error: "Specialty not found" }, { status: 404 });
    }

    // ---- Kit ----
    const kitPath = path.join(specDir, "kit.json");
    const kit = safeJsonParse<KitJson>(kitPath);
    if (!kit) {
      return NextResponse.json({ error: "kit.json not found or invalid" }, { status: 404 });
    }

    const theme = THEMES[kit.id] || { glyph: "🔹", accent: "#94a3b8" };

    // ---- SOUL.md ----
    const soulContent = safeRead(path.join(specDir, "workspace", "SOUL.md")) || "";

    // ---- Brain SOUL appends ----
    const BRAIN_PARTS = ["cortex", "motor", "cerebellum"];
    const brainAppends: BrainAppend[] = BRAIN_PARTS.map((part) => {
      const appendPath = path.join(specDir, "brain", part, "SOUL_APPEND.md");
      const content = safeRead(appendPath);
      return {
        part,
        exists: content !== null,
        content: content || "",
      };
    });

    // ---- Responsibilities ----
    const respPath = path.join(specDir, `responsibilities-${specialty}.json`);
    const respData = safeJsonParse<{ responsibilities: Responsibility[] }>(respPath);
    const responsibilities: Responsibility[] = (respData?.responsibilities || []).map((r) => ({
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      enabled: r.enabled,
      min_spacing_minutes: r.min_spacing_minutes,
      instruction: r.instruction,
      context: r.context,
    }));

    // ---- Skills ----
    const skillsDir = path.join(specDir, "skills");
    const skills: SkillManifest[] = [];
    if (fs.existsSync(skillsDir)) {
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      for (const dir of skillDirs) {
        const skillJsonPath = path.join(skillsDir, dir.name, "skill.json");
        const skillMdPath = path.join(skillsDir, dir.name, "SKILL.md");
        const manifest = safeJsonParse<SkillManifest>(skillJsonPath);
        const skillMd = safeRead(skillMdPath);

        if (manifest) {
          skills.push({
            id: manifest.id || dir.name,
            name: manifest.name || dir.name,
            description: manifest.description || "",
            category: manifest.category,
            agent_part: manifest.agent_part,
            version: manifest.version,
            skillMdContent: skillMd || undefined,
          });
        }
      }
    }

    // ---- Workspace files ----
    const WORKSPACE_FILES = ["IDENTITY.md", "SOUL.md", "MEMORY.md"];
    const workspaceFiles: WorkspaceFile[] = WORKSPACE_FILES.map((name) => {
      const meta = fileMeta(path.join(specDir, "workspace", name));
      return { name, ...meta };
    });

    // ---- Assemble response ----
    return NextResponse.json({
      specialty: {
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
        soulContent,
        brainAppends,
        responsibilities,
        skills,
        workspaceFiles,
      },
    });
  } catch (err) {
    console.error("[api/agent-types/[specialty]] Error:", err);
    return NextResponse.json(
      { error: "Failed to load specialty detail" },
      { status: 500 }
    );
  }
}
