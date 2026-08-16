import { NextRequest, NextResponse } from "next/server";
import { getGitHubRawBase } from "@/lib/github";
import { primesCol } from "@/lib/firestore";
import { resolveDeployedRef, contentUrlAt } from "@/lib/deployed-ref";

/**
 * GET /api/agent-types?primeId=<id> — agent types this Prime can actually hire.
 *
 * This used to read `main` unconditionally, with the stated reason that the hire
 * modal should "reflect the current available specialties without needing a
 * dashboard redeploy". That is the wrong question. A specialty on main is one
 * the repo offers; a specialty this Prime can install is one that exists at the
 * ref the Prime is running. Offering the first while hiring against the second
 * lets an operator pick a type whose skills and job manifest are not in the
 * deployed release — the hire then fails on the VM, long after the choice.
 *
 * Resolved against the Prime's `coreRef`, like /api/contracts and
 * /api/primes/[id]/brain-config. Without a primeId it still answers from main,
 * because some callers legitimately ask "what does the platform offer" — but the
 * answer says so in `_source` rather than implying it describes a deployment.
 */
export async function GET(req: NextRequest) {
  const primeId = req.nextUrl.searchParams.get("primeId");

  try {
    let coreRef: string | undefined;
    if (primeId) {
      const doc = await primesCol().doc(primeId).get();
      coreRef = doc.exists ? (doc.data()?.coreRef as string | undefined) : undefined;
    }
    const resolved = resolveDeployedRef(coreRef);

    const url = contentUrlAt(getGitHubRawBase(), resolved, "corekit/config/agent-types.json");
    const res = await fetch(url, { next: { revalidate: 300 } });

    if (!res.ok) {
      throw new Error(`Failed to fetch agent-types.json at ${resolved.ref}: ${res.status}`);
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

    // Provenance rides with the payload so a caller can render the caveat rather
    // than presenting a floating ref as though it were the deployed one.
    return NextResponse.json({ types, _source: resolved });
  } catch (err) {
    console.error("[api/agent-types] Failed to fetch agent-types.json:", err);
    return NextResponse.json(
      { error: "Failed to load agent types" },
      { status: 500 }
    );
  }
}
