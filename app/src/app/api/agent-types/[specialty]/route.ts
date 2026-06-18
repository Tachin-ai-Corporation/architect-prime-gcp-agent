import { NextResponse } from "next/server";
import { GH_RAW_BASE } from "@/lib/github";

const GH_RAW = `${GH_RAW_BASE}/main`;

/** Default theme for types without explicit glyph/accent */
const DEFAULT_THEME = { glyph: "🔹", accent: "#94a3b8" };

interface AgentType {
  id: string;
  title: string;
  glyph?: string;
  accent?: string;
  aliases?: string[];
}

/**
 * Canon B-9 organ metadata — the single source of truth for organ display.
 * nature: deterministic | judgment | judgment+effects | etc.
 */
const CANON_ORGANS: {
  key: string;
  label: string;
  icon: string;
  nature: string;
  role: string;
  never: string;
  sourceType: "specialty-append" | "base-brain";
  /** Path pattern — {specialty} is replaced at runtime */
  repoPath: string;
}[] = [
  {
    key: "cortex",
    label: "Cortex",
    icon: "🧠",
    nature: "Judgment",
    role: "Classify intakes, choose decisions, synthesize outcomes",
    never: "Executes tools; holds the loop; verifies itself",
    sourceType: "specialty-append",
    repoPath: "specialties/{specialty}/brain/cortex/SOUL_APPEND.md",
  },
  {
    key: "prefrontal",
    label: "Prefrontal",
    icon: "🏗️",
    nature: "Judgment",
    role: "Turn intent into structure: M→C→T blueprints",
    never: "Executes; decides; freelances beyond the blueprint schema",
    sourceType: "base-brain",
    repoPath: "brain/fleet/_brain/prefrontal/SOUL.md",
  },
  {
    key: "motor",
    label: "Motor",
    icon: "⚡",
    nature: "Judgment + effects",
    role: "Act: tools, exec, files — the only mutator",
    never: "Verifies its own work; runs two hands at once; sends messages",
    sourceType: "specialty-append",
    repoPath: "specialties/{specialty}/brain/motor/SOUL_APPEND.md",
  },
  {
    key: "cerebellum",
    label: "Cerebellum",
    icon: "🔄",
    nature: "Judgment, read-only",
    role: "Verify results against accept criteria, independently",
    never: "Verifies anything it produced; executes fixes",
    sourceType: "specialty-append",
    repoPath: "specialties/{specialty}/brain/cerebellum/SOUL_APPEND.md",
  },
  {
    key: "temporal-memory",
    label: "Temporal-Memory",
    icon: "💾",
    nature: "Judgment, read-only",
    role: "Recall what the agent already knows",
    never: "Touches external APIs; invents facts",
    sourceType: "base-brain",
    repoPath: "brain/fleet/_brain/temporal-memory/SOUL.md",
  },
  {
    key: "temporal-research",
    label: "Temporal-Research",
    icon: "🔍",
    nature: "Judgment, read-only",
    role: "Bring in what the world knows: search + fetch",
    never: "Mutates state; substitutes for memory",
    sourceType: "base-brain",
    repoPath: "brain/fleet/_brain/temporal-research/SOUL.md",
  },
];

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
  agent_part?: string | string[];
  version?: string;
  origin?: string;
  skillMdContent?: string;
}

interface OrganDetail {
  key: string;
  label: string;
  icon: string;
  nature: string;
  role: string;
  never: string;
  sourceType: "specialty-append" | "base-brain";
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
 * Now includes all 6 canon B-9 organs with role/never metadata.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ specialty: string }> }
) {
  try {
    const { specialty } = await params;

    // Validate specialty name format
    if (!/^[a-z0-9-]+$/.test(specialty)) {
      return NextResponse.json({ error: "Invalid specialty" }, { status: 400 });
    }

    // Fetch agent-types.json for validation and theme data
    const agentTypesData = await ghJson<{ types: AgentType[] }>(
      "corekit/config/agent-types.json"
    );
    const agentType = agentTypesData?.types?.find((t) => t.id === specialty);
    if (!agentType) {
      return NextResponse.json({ error: "Unknown specialty" }, { status: 404 });
    }

    const base = `specialties/${specialty}`;

    // ---- Kit ----
    const kit = await ghJson<KitJson>(`${base}/kit.json`);
    if (!kit) {
      return NextResponse.json({ error: "kit.json not found" }, { status: 404 });
    }

    const theme = {
      glyph: agentType.glyph || DEFAULT_THEME.glyph,
      accent: agentType.accent || DEFAULT_THEME.accent,
    };

    // ---- Parallel fetches ----
    const WORKSPACE_FILES = ["IDENTITY.md", "SOUL.md", "MEMORY.md"];

    const [
      soulContent,
      respData,
      ...organAndWorkspace
    ] = await Promise.all([
      // SOUL.md (specialty workspace)
      ghText(`${base}/workspace/SOUL.md`),
      // Responsibilities
      ghJson<{ responsibilities: Responsibility[] }>(`${base}/responsibilities-${specialty}.json`),
      // All 6 organs
      ...CANON_ORGANS.map((org) =>
        ghText(org.repoPath.replace("{specialty}", specialty))
      ),
      // Workspace files (3)
      ...WORKSPACE_FILES.map((name) => ghText(`${base}/workspace/${name}`)),
    ]);

    // Parse organs (indices 0-5 of organAndWorkspace)
    const organs: OrganDetail[] = CANON_ORGANS.map((org, i) => {
      const content = organAndWorkspace[i] as string | null;
      return {
        key: org.key,
        label: org.label,
        icon: org.icon,
        nature: org.nature,
        role: org.role,
        never: org.never,
        sourceType: org.sourceType,
        exists: content !== null,
        content: content || "",
      };
    });

    // Parse workspace files (indices 6-8 of organAndWorkspace)
    const workspaceFiles: WorkspaceFile[] = WORKSPACE_FILES.map((name, i) => {
      const content = organAndWorkspace[CANON_ORGANS.length + i] as string | null;
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

    // ---- Skills ----
    const skills: SkillManifest[] = [];

    // Base skills: skills/{id}/ at repo root
    for (const skillId of kit.base_skills) {
      const [manifest, skillMd] = await Promise.all([
        ghJson<SkillManifest>(`skills/${skillId}/skill.json`),
        ghText(`skills/${skillId}/SKILL.md`),
      ]);
      if (manifest) {
        skills.push({
          id: manifest.id || skillId,
          name: manifest.name || skillId,
          description: manifest.description || "",
          category: manifest.category,
          agent_part: manifest.agent_part,
          version: manifest.version,
          origin: "base",
          skillMdContent: skillMd || undefined,
        });
      }
    }

    // Specialty skills: specialties/{type}/skills/{id}/
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
          origin: "specialty",
          skillMdContent: skillMd || undefined,
        });
      }
    }

    // ---- Assemble response ----
    // Keep backwards-compatible brainAppends for any legacy consumers
    const brainAppends = organs
      .filter((o) => o.sourceType === "specialty-append")
      .map((o) => ({ part: o.key, exists: o.exists, content: o.content }));

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
        organs,
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
