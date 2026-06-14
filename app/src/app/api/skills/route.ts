import { NextResponse } from "next/server";

/* ---- Types ---- */
interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  origin: "core" | "specialty" | "learned";
  category: string;
  agent_part: string | string[];
  scripts: string[];
  dependencies: string[];
  when_to_use: string;
}

const GITHUB_RAW =
  "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/main";

/* 5-minute cache */
let catalogCache: { skills: SkillManifest[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

/**
 * GET /api/skills — Returns the full skill catalog from repo skill.json manifests.
 * Fetches skill.json from each known skill directory in the repo.
 */

/* Static list of skill IDs — these are the known skill packages in the repo.
 * When the public skill registry is built (Phase 4), this will become dynamic. */
const CORE_SKILLS = [
  "web-search",
  "workspace-drive",
  "workspace-gmail",
  "workspace-calendar",
  "workspace-docs",
  "workspace-sheets",
  "fleet-hire",
  "fleet-fire",
  "fleet-status",
  "fleet-upgrade",
  "fleet-verify",
  "memory-consolidate",
];

const SPECIALTY_SKILLS: { type: string; id: string }[] = [
  { type: "devops", id: "gcp-devops" },
];

async function fetchSkillJson(path: string): Promise<SkillManifest | null> {
  try {
    const res = await fetch(`${GITHUB_RAW}/${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as SkillManifest;
  } catch {
    return null;
  }
}

async function loadCatalog(): Promise<SkillManifest[]> {
  if (catalogCache && Date.now() - catalogCache.ts < CACHE_TTL) {
    return catalogCache.skills;
  }

  const fetches: Promise<SkillManifest | null>[] = [];

  // Core skills
  for (const id of CORE_SKILLS) {
    fetches.push(fetchSkillJson(`skills/${id}/skill.json`));
  }

  // Specialty skills
  for (const { type, id } of SPECIALTY_SKILLS) {
    fetches.push(fetchSkillJson(`specialties/${type}/skills/${id}/skill.json`));
  }

  const results = await Promise.all(fetches);
  const skills = results.filter((s): s is SkillManifest => s !== null);

  catalogCache = { skills, ts: Date.now() };
  return skills;
}

export async function GET() {
  try {
    const skills = await loadCatalog();
    return NextResponse.json({ skills });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to load skill catalog", details: String(e) },
      { status: 500 }
    );
  }
}
