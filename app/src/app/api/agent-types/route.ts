import { NextResponse } from "next/server";

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/main/corekit/config/agent-types.json";

/**
 * GET /api/agent-types -- Return available agent types for hiring
 *
 * Fetches agent-types.json from the live repo on GitHub so the hire
 * modal always reflects the current available specialties without
 * needing a dashboard redeploy.
 */
export async function GET() {
  try {
    const res = await fetch(GITHUB_RAW_URL, {
      next: { revalidate: 300 }, // Cache for 5 minutes
    });

    if (!res.ok) {
      throw new Error(`GitHub fetch failed: ${res.status}`);
    }

    const data = await res.json();

    // Return simplified list for the hire modal
    const types = (data.types || []).map(
      (t: { id: string; title: string; specialty: string; emailPattern: string; skills: string[] }) => ({
        id: t.id,
        title: t.title,
        specialty: t.specialty,
        emailPattern: t.emailPattern,
        skills: t.skills,
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
