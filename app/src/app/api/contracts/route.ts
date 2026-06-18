// API route: /api/contracts
// Global route — reads contracts.json from the prime VM via SSH or from the GitHub repo.
// Returns the parsed contracts data for the ContractsViewer component.

import { NextResponse, NextRequest } from "next/server";
import { GH_RAW_BASE } from "@/lib/github";

export async function GET(req: NextRequest) {
  const primeId = req.nextUrl.searchParams.get("primeId");
  if (!primeId) {
    return NextResponse.json({ error: "primeId query param required" }, { status: 400 });
  }

  try {
    // Read contracts.json from the repository (canonical source)
    // The daemon validates this at bootstrap, so the repo version is authoritative.
    const url = `${GH_RAW_BASE}/main/infra/contracts.json`;
    const res = await fetch(url, {
      next: { revalidate: 300 }, // Cache for 5 minutes
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch contracts.json: ${res.status}`);
    }

    const contracts = await res.json();
    return NextResponse.json(contracts);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
