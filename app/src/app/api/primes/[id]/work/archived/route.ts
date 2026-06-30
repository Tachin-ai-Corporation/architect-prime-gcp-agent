import { NextRequest, NextResponse } from "next/server";
import { workCol } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/primes/[id]/work/archived — Paginated archived/completed work
 *
 * Query params:
 *   agent    — filter by owner email prefix
 *   search   — text filter on title/intent (client-side after fetch)
 *   limit    — page size (default 20, max 100)
 *   startAfter — Firestore doc ID for cursor pagination
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const agentFilter = url.searchParams.get("agent");
    const search = url.searchParams.get("search")?.toLowerCase() || "";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
    const startAfterDocId = url.searchParams.get("startAfter");

    const wCol = workCol();

    const DONE_STATUSES = new Set([
      "complete",
      "failed",
      "cancelled",
      "archived",
      "rejected",
      "timed_out",
    ]);

    // Build query — root envelopes only, ordered by created_at desc
    // Note: Firestore doesn't support two `in` filters, so we filter status client-side
    // Using created_at to reuse existing composite index (type + created_at)
    let query = wCol
      .where("type", "in", ["M", "R"])
      .orderBy("created_at", "desc")
      .limit((limit + 1) * 3); // over-fetch to account for client-side status filter

    // Cursor pagination: startAfter a specific document
    if (startAfterDocId) {
      const cursorDoc = await wCol.doc(startAfterDocId).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snap = await query.get();

    let envelopes = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        type: d.type,
        parent_id: d.parent_id ?? null,
        owner: d.owner ?? "",
        status: d.status,
        intent: d.intent ?? "",
        title: d.title ?? null,
        instruction: d.instruction ?? "",
        accept_criteria: d.accept_criteria ?? "",
        context_summary: d.context_summary ?? null,
        output: d.output ?? null,
        error: d.error ?? null,
        children: d.children ?? [],
        depends_on: d.depends_on ?? [],
        source_channel: d.source_channel ?? "",
        source_meta: d.source_meta ?? {},
        created_at: d.created_at ?? null,
        started_at: d.started_at ?? null,
        completed_at: d.completed_at ?? null,
        updated_at: d.updated_at ?? null,
        iteration: d.iteration ?? 0,
        project_id: d.project_id ?? null,
        plan_id: d.plan_id ?? null,
      };
    });

    // Filter to terminal statuses only (client-side since Firestore doesn't allow two `in` clauses)
    envelopes = envelopes.filter((e) => DONE_STATUSES.has(e.status));

    // Agent filter (client-side — match short name against owner)
    if (agentFilter) {
      const lowerAgent = agentFilter.toLowerCase();
      envelopes = envelopes.filter((e) => {
        const owner = e.owner.toLowerCase();
        if (owner === lowerAgent) return true;
        const emailPrefix = owner.split("@")[0];
        if (emailPrefix === lowerAgent) return true;
        if (owner === "prime" && (lowerAgent === "prime" || lowerAgent.startsWith("prime-"))) {
          return true;
        }
        if ((lowerAgent === "prime" || lowerAgent.startsWith("prime-")) && (owner === "prime" || emailPrefix === "prime")) {
          return true;
        }
        const segments = emailPrefix.split(/[-_.]/);
        return segments.includes(lowerAgent);
      });
    }

    // Text search filter (client-side)
    if (search) {
      envelopes = envelopes.filter((e) => {
        const titleMatch = (e.title || "").toLowerCase().includes(search);
        const intentMatch = (e.intent || "").toLowerCase().includes(search);
        const instrMatch = (e.instruction || "").toLowerCase().includes(search);
        return titleMatch || intentMatch || instrMatch;
      });
    }

    // Determine if there are more results
    const hasMore = envelopes.length > limit;
    if (hasMore) {
      envelopes = envelopes.slice(0, limit);
    }

    const nextCursor = hasMore && envelopes.length > 0
      ? envelopes[envelopes.length - 1].id
      : null;

    return NextResponse.json({ envelopes, nextCursor });
  } catch (err) {
    console.error(`[api/primes/work/archived] GET error:`, err);
    return NextResponse.json({ error: "Failed to fetch archived work" }, { status: 500 });
  }
}
