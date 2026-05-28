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

/* ---- Helpers ---- */

async function ghText(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${GH_RAW}/${path}`, { next: { revalidate: 300 } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function ghJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${GH_RAW}/${path}`, { next: { revalidate: 300 } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
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
 * Returns full detail for a single specialty by fetching files from GitHub raw.
 * Works on Cloud Run (no filesystem dependency).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ specialty: string }> }
) {
  try {
    const { specialty } = await params;

    // Validate specialty name
    if (!/^[a-z0-9-]+$/.test(specialty) || !THEMES[specialty]) {
      return NextResponse.json({ error: "Invalid specialty" }, { status: 400 });
    }

    const base = `specialties/${specialty}`;

    // ---- Kit ----
    const kit = await ghJson<KitJson>(`${base}/kit.json`);
    if (!kit) {
      return NextResponse.json({ error: "kit.json not found" }, { status: 404 });
    }

    const theme = THEMES[kit.id] || { glyph: "🔹", accent: "#94a3b8" };

    // ---- Parallel fetches for all content ----
    const BRAIN_PARTS = ["cortex", "motor", "cerebellum"];
    const WORKSPACE_FILES = ["IDENTITY.md", "SOUL.md", "MEMORY.md"];

    const [
      soulContent,
      respData,
      ...brainAndWorkspace
    ] = await Promise.all([
      // SOUL.md
      ghText(`${base}/workspace/SOUL.md`),
      // Responsibilities
      ghJson<{ responsibilities: Responsibility[] }>(`${base}/responsibilities-${specialty}.json`),
      // Brain appends (3)
      ...BRAIN_PARTS.map((part) => ghText(`${base}/brain/${part}/SOUL_APPEND.md`)),
      // Workspace files (3)
      ...WORKSPACE_FILES.map((name) => ghText(`${base}/workspace/${name}`)),
    ]);

    // Parse brain appends (indices 0-2 of brainAndWorkspace)
    const brainAppends: BrainAppend[] = BRAIN_PARTS.map((part, i) => {
      const content = brainAndWorkspace[i] as string | null;
      return {
        part,
        exists: content !== null,
        content: content || "",
      };
    });

    // Parse workspace files (indices 3-5 of brainAndWorkspace)
    const workspaceFiles: WorkspaceFile[] = WORKSPACE_FILES.map((name, i) => {
      const content = brainAndWorkspace[BRAIN_PARTS.length + i] as string | null;
      return {
        name,
        exists: content !== null,
        sizeBytes: content ? new TextEncoder().encode(content).length : 0,
        preview: content ? content.slice(0, 200) : "",
      };
    });

    // Parse responsibilities
    const responsibilities: Responsibility[] = (respData?.responsibilities || []).map((r) => ({
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      enabled: r.enabled,
      min_spacing_minutes: r.min_spacing_minutes,
      instruction: r.instruction,
      context: r.context,
    }));

    // ---- Skills (fetch each specialty skill's metadata + content) ----
    const skills: SkillManifest[] = [];
    for (const skillId of kit.specialty_skills) {
      const [manifest, skillMd] = await Promise.all([
        ghJson<SkillManifest>(`${base}/skills/${skillId}/skill.json`),
        ghText(`${base}/skills/${skillId}/SKILL.md`),
      ]);
      if (manifest) {
        skills.push({
          id: manifest.id || skillId,
          name: manifest.name || skillId,
          description: manifest.description || "",
          category: manifest.category,
          agent_part: manifest.agent_part,
          version: manifest.version,
          skillMdContent: skillMd || undefined,
        });
      }
    }

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
        soulContent: soulContent || "",
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
