// API route: /api/contracts
//
// The contract a PRIME IS RUNNING, not the one on the tip of main.
//
// This route already required `primeId` and then ignored it, fetching
// `main/infra/contracts.json` with a comment asserting the repo version was
// authoritative. It is authoritative about what a fresh install would get today
// — a different question from what this deployment is running, and the two look
// identical until they diverge. A dashboard that answers the easy question in
// the place the hard one was asked is how an operator debugs against config the
// agent does not have.
//
// When no deployed commit is recorded, the fallback to main is still taken —
// but the response says so, so the caller can show it as unpinned rather than
// as fact.

import { NextResponse, NextRequest } from "next/server";
import { getGitHubRawBase } from "@/lib/github";
import { primesCol } from "@/lib/firestore";
import { resolveDeployedRef, contentUrlAt } from "@/lib/deployed-ref";

export async function GET(req: NextRequest) {
  const primeId = req.nextUrl.searchParams.get("primeId");
  if (!primeId) {
    return NextResponse.json({ error: "primeId query param required" }, { status: 400 });
  }

  try {
    const doc = await primesCol().doc(primeId).get();
    const resolved = resolveDeployedRef(doc.exists ? (doc.data()?.coreRef as string | undefined) : undefined);

    const url = contentUrlAt(getGitHubRawBase(), resolved, "infra/contracts.json");
    const res = await fetch(url, { next: { revalidate: 300 } });
    if (!res.ok) {
      throw new Error(`Failed to fetch contracts.json at ${resolved.ref}: ${res.status}`);
    }

    const contracts = await res.json();
    // The provenance rides with the payload rather than replacing it, so an
    // existing consumer keeps working and a caveat is available to render.
    return NextResponse.json({ ...contracts, _source: resolved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
