import { NextResponse } from "next/server";
import { getGitHubRawBase, getGitHubApiBase } from "@/lib/github";

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

interface AgentType {
  id: string;
  title: string;
  specialty: string;
  skills: string[];
  glyph?: string;
}

const getGitHubRaw = () => `${getGitHubRawBase()}/main`;
const getGitHubApi = () => `${getGitHubApiBase()}/contents`;

/* 5-minute cache */
let catalogCache: { skills: SkillManifest[]; agentTypes: AgentType[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

/**
 * List subdirectories in a repo path via GitHub Contents API.
 */
async function listRepoDirs(path: string): Promise<string[]> {
  try {
    const res = await fetch(`${getGitHubApi()}/${path}`, {
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

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${getGitHubRaw()}/${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Build the full skill catalog and agent type mapping.
 * Auto-discovers skills and fetches agent-types.json for role mapping.
 */
async function loadCatalog(): Promise<{ skills: SkillManifest[]; agentTypes: AgentType[] }> {
  if (catalogCache && Date.now() - catalogCache.ts < CACHE_TTL) {
    return { skills: catalogCache.skills, agentTypes: catalogCache.agentTypes };
  }

  const fetches: Promise<SkillManifest | null>[] = [];

  // Discover core skills
  const coreDirs = await listRepoDirs("skills");
  for (const dir of coreDirs) {
    fetches.push(fetchJson<SkillManifest>(`skills/${dir}/skill.json`));
  }

  // Discover specialty skills
  const specialtyTypes = await listRepoDirs("specialties");
  for (const type of specialtyTypes) {
    const skillDirs = await listRepoDirs(`specialties/${type}/skills`);
    for (const dir of skillDirs) {
      fetches.push(fetchJson<SkillManifest>(`specialties/${type}/skills/${dir}/skill.json`));
    }
  }

  // Fetch agent types for role→skill mapping
  const agentTypesData = await fetchJson<{ types: AgentType[] }>("corekit/config/agent-types.json");
  const agentTypes = (agentTypesData?.types || []).map((t) => ({
    id: t.id,
    title: t.title,
    specialty: t.specialty,
    skills: t.skills || [],
    glyph: t.glyph || "🔹",
  }));

  const results = await Promise.all(fetches);
  const skills = results.filter((s): s is SkillManifest => s !== null);

  catalogCache = { skills, agentTypes, ts: Date.now() };
  return { skills, agentTypes };
}

/**
 * GET /api/skills — Returns the full skill catalog and agent type mapping.
 * Auto-discovers all skill packages — no hardcoded list.
 */
export async function GET() {
  try {
    const { skills, agentTypes } = await loadCatalog();
    return NextResponse.json({ skills, agentTypes });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to load skill catalog", details: String(e) },
      { status: 500 }
    );
  }
}
