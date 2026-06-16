import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Status sets */
const ACTIVE_STATUSES = ["active", "waiting", "needs_input", "awaiting_approval", "blocked"];

/**
 * GET /api/primes/[id]/work — List work envelopes for a Prime
 *
 * Mission-first architecture:
 * 1. Query M/R roots (using type+created_at composite index)
 * 2. For active roots, fetch full descendant tree via getAll()
 * 3. Return roots + active trees (completed missions return root-only)
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status");
    const typeFilter = url.searchParams.get("type");

    const db = getDb();
    const workCol = db.collection("primes").doc(id).collection("work");

    // 7-day cutoff
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = sevenDaysAgo.toISOString();

    // Phase 1: Get root envelopes (M and R types) — very few (~10-20)
    const rootSnap = await workCol
      .where("type", "in", ["M", "R"])
      .where("created_at", ">=", cutoff)
      .orderBy("created_at", "desc")
      .limit(50)
      .get();

    const roots = rootSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as any[];

    // Phase 2: For active/R roots, fetch full descendant tree via getAll()
    const allEnvelopes: any[] = [...roots];
    const seenIds = new Set(roots.map(r => r.id));

    for (const root of roots) {
      if (!ACTIVE_STATUSES.includes(root.status) && root.type !== "R") continue;

      // Level 1: root.children → C envelopes
      const childIds: string[] = root.children || [];
      if (childIds.length === 0) continue;

      const childRefs = childIds
        .filter(cid => !seenIds.has(cid))
        .map(cid => workCol.doc(cid));

      if (childRefs.length === 0) continue;

      const childDocs = await db.getAll(...childRefs);
      const children: any[] = [];
      for (const doc of childDocs) {
        if (doc.exists) {
          const data = { id: doc.id, ...doc.data() };
          if (!seenIds.has(doc.id)) {
            children.push(data);
            allEnvelopes.push(data);
            seenIds.add(doc.id);
          }
        }
      }

      // Level 2: C.children → T envelopes
      const grandchildIds: string[] = children.flatMap((c: any) => c.children || []);
      if (grandchildIds.length === 0) continue;

      const gcRefs = grandchildIds
        .filter(gid => !seenIds.has(gid))
        .map(gid => workCol.doc(gid));

      if (gcRefs.length === 0) continue;

      // Firestore getAll() supports up to 500 refs per call
      for (let i = 0; i < gcRefs.length; i += 500) {
        const batch = gcRefs.slice(i, i + 500);
        const gcDocs = await db.getAll(...batch);
        for (const doc of gcDocs) {
          if (doc.exists && !seenIds.has(doc.id)) {
            allEnvelopes.push({ id: doc.id, ...doc.data() });
            seenIds.add(doc.id);
          }
        }
      }
    }

    // Phase 3: Safety net — catch any active orphans not yet in our results
    // (e.g., active C/T whose parent M was just created and not in our root query)
    const activeSnap = await workCol
      .where("status", "in", ACTIVE_STATUSES)
      .limit(20)
      .get();

    for (const doc of activeSnap.docs) {
      if (!seenIds.has(doc.id)) {
        allEnvelopes.push({ id: doc.id, ...doc.data() });
        seenIds.add(doc.id);

        // Backfill parent if missing
        const data = doc.data();
        if (data.parent_id && !seenIds.has(data.parent_id)) {
          try {
            const parentDoc = await workCol.doc(data.parent_id).get();
            if (parentDoc.exists) {
              allEnvelopes.push({ id: parentDoc.id, ...parentDoc.data() });
              seenIds.add(parentDoc.id);
            }
          } catch { /* ignore */ }
        }
      }
    }

    // Apply client-side filters
    let envelopes = allEnvelopes;
    if (statusFilter) {
      envelopes = envelopes.filter((e: any) => e.status === statusFilter);
    }
    if (typeFilter) {
      envelopes = envelopes.filter((e: any) => e.type === typeFilter);
    }
    envelopes = envelopes.filter((e: any) => e.status !== "archived");

    return NextResponse.json({ envelopes });
  } catch (err) {
    console.error(`[api/primes/work] GET error:`, err);
    return NextResponse.json({ error: "Failed to list work envelopes" }, { status: 500 });
  }
}
