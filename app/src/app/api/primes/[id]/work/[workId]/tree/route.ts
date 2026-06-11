import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; workId: string }>;
}

/**
 * GET /api/primes/[id]/work/[workId]/tree
 * Returns the full descendant tree for a work envelope.
 * Used for lazy-loading completed mission trees.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { id, workId } = await ctx.params;
    const db = getDb();
    const workCol = db.collection("primes").doc(id).collection("work");

    const rootDoc = await workCol.doc(workId).get();
    if (!rootDoc.exists) {
      return NextResponse.json({ error: "Envelope not found" }, { status: 404 });
    }

    const root = { id: rootDoc.id, ...rootDoc.data() } as any;
    const descendants: any[] = [];
    const seenIds = new Set([root.id]);

    // BFS through children arrays
    let currentLevel = [root];
    while (currentLevel.length > 0) {
      const childIds = currentLevel.flatMap((node: any) => node.children || []);
      const newIds = childIds.filter((cid: string) => !seenIds.has(cid));
      if (newIds.length === 0) break;

      const refs = newIds.map((cid: string) => workCol.doc(cid));
      const nextLevel: any[] = [];

      for (let i = 0; i < refs.length; i += 500) {
        const batch = refs.slice(i, i + 500);
        const docs = await db.getAll(...batch);
        for (const doc of docs) {
          if (doc.exists && !seenIds.has(doc.id)) {
            const data = { id: doc.id, ...doc.data() };
            descendants.push(data);
            nextLevel.push(data);
            seenIds.add(doc.id);
          }
        }
      }

      currentLevel = nextLevel;
    }

    return NextResponse.json({ envelopes: descendants });
  } catch (err) {
    console.error(`[api/primes/work/tree] GET error:`, err);
    return NextResponse.json({ error: "Failed to load tree" }, { status: 500 });
  }
}
