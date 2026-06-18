import { NextResponse } from "next/server";
import { getGitHubRawBase } from "@/lib/github";

/**
 * GET /api/agent-types -- Return available agent types for hiring
 *
 * Fetches agent-types.json from the live repo on GitHub so the hire
 * modal always reflects the current available specialties without
 * needing a dashboard redeploy.
 */
export async function GET() {
  try {
    const githubRawUrl = `${getGitHubRawBase()}/main/corekit/config/agent-types.json`;
    const res = await fetch(githubRawUrl, {
      next: { revalidate: 300 }, // Cache for 5 minutes
    });

    if (!res.ok) {
      throw new Error(`GitHub fetch failed: ${res.status}`);
    }

    const data = await res.json();

    // Return simplified list for the hire modal
    const types = (data.types || []).map(
      (t: { id: string; title: string; specialty: string; emailPattern: string; skills: string[]; glyph?: string; accent?: string; aliases?: string[] }) => ({
        id: t.id,
        title: t.title,
        specialty: t.specialty,
        emailPattern: t.emailPattern,
        skills: t.skills,
        glyph: t.glyph || "🔹",
        accent: t.accent || "#94a3b8",
        aliases: t.aliases || [],
      })
    );

    return NextResponse.json({ types });
  } catch (err) {
    console.error("[api/agent-types] Failed to fetch agent-types.json:", err);
    return NextResponse.json(
      { error: "Failed to load agent types" },
      { status: 500 }
    );
  }
}
