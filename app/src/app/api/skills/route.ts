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
  requires: Record<string, string>;
  when_to_use: string;
}

const GITHUB_RAW =
  "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/main";
const GITHUB_API =
  "https://api.github.com/repos/Tachin-ai-Corporation/architect-prime-gcp-agent/contents";

/* 5-minute cache */
let catalogCache: { skills: SkillManifest[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

/**
 * List subdirectories in a repo path via GitHub Contents API.
 * Returns an array of directory names.
 */
async function listRepoDirs(path: string): Promise<string[]> {
  try {
    const res = await fetch(`${GITHUB_API}/${path}`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "architect-prime-dashboard",
      },
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const items = (await res.json()) as { name: string; type: string }[];
    return items.filter((i) => i.type === "dir").map((i) => i.name);
  } catch {
    return [];
  }
}

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

/**
 * Build the full skill catalog by discovering all skill directories in the repo.
 * Scans skills and specialties directories for skill.json manifests.
 */
async function loadCatalog(): Promise<SkillManifest[]> {
  if (catalogCache && Date.now() - catalogCache.ts < CACHE_TTL) {
    return catalogCache.skills;
  }

  const fetches: Promise<SkillManifest | null>[] = [];

  // Discover core skills
  const coreDirs = await listRepoDirs("skills");
  for (const dir of coreDirs) {
    fetches.push(fetchSkillJson(`skills/${dir}/skill.json`));
  }

  // Discover specialty skills
  const specialtyTypes = await listRepoDirs("specialties");
  for (const type of specialtyTypes) {
    const skillDirs = await listRepoDirs(`specialties/${type}/skills`);
    for (const dir of skillDirs) {
      fetches.push(fetchSkillJson(`specialties/${type}/skills/${dir}/skill.json`));
    }
  }

  const results = await Promise.all(fetches);
  const skills = results.filter((s): s is SkillManifest => s !== null);

  catalogCache = { skills, ts: Date.now() };
  return skills;
}

/**
 * GET /api/skills — Returns the full skill catalog from repo.
 * Auto-discovers all skill packages — no hardcoded list.
 */
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
