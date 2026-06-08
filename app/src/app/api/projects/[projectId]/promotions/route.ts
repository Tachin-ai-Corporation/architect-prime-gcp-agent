import { NextRequest, NextResponse } from "next/server";
import { promotionsCol, projectsCol } from "@/lib/firestore";
import { requireAuth } from "@/lib/require-auth";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

/**
 * GET /api/projects/[projectId]/promotions — List promotion candidates
 *
 * Query params:
 *   ?status=pending — filter by status
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { projectId } = await ctx.params;
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status");

    let query = promotionsCol(projectId)
      .orderBy("suggested_at", "desc");

    if (statusFilter) {
      query = promotionsCol(projectId)
        .where("status", "==", statusFilter)
        .orderBy("suggested_at", "desc");
    }

    const snap = await query.get();
    const promotions = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        key: data.key || null,
        entry: data.entry || null,
        source_mission_id: data.source_mission_id || null,
        suggested_at: data.suggested_at?.toDate?.()?.toISOString() || data.suggested_at || null,
        status: data.status,
        resolved_at: data.resolved_at?.toDate?.()?.toISOString() || data.resolved_at || null,
      };
    });

    return NextResponse.json({ promotions });
  } catch (err) {
    console.error(`[api/projects/promotions] GET error:`, err);
    return NextResponse.json({ error: "Failed to list promotions" }, { status: 500 });
  }
}

/**
 * POST /api/projects/[projectId]/promotions — Accept or dismiss
 *
 * Body: { promotionId, action: 'accept'|'dismiss' }
 * On accept: merges entry into parent project's context field.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { projectId } = await ctx.params;

  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { promotionId, action } = body;

    if (!promotionId || !action) {
      return NextResponse.json(
        { error: "Missing required fields: promotionId, action" },
        { status: 400 }
      );
    }

    if (action !== "accept" && action !== "dismiss") {
      return NextResponse.json(
        { error: "Invalid action. Must be 'accept' or 'dismiss'" },
        { status: 400 }
      );
    }

    const promoRef = promotionsCol(projectId).doc(promotionId);
    const promoDoc = await promoRef.get();

    if (!promoDoc.exists) {
      return NextResponse.json({ error: "Promotion not found" }, { status: 404 });
    }

    const promoData = promoDoc.data() || {};
    const status = action === "accept" ? "accepted" : "dismissed";

    await promoRef.update({
      status,
      resolved_at: new Date().toISOString(),
    });

    // On accept: deep-merge entry into parent project's context
    if (action === "accept" && promoData.key && promoData.entry) {
      const projectRef = projectsCol().doc(projectId);
      const projectDoc = await projectRef.get();

      if (projectDoc.exists) {
        const existingData = projectDoc.data() || {};
        const existingContext = existingData.context || {};

        const mergedContext = {
          ...existingContext,
          [promoData.key]: promoData.entry,
        };

        await projectRef.update({
          context: mergedContext,
          updated_at: new Date().toISOString(),
        });
      }
    }

    return NextResponse.json({
      id: promotionId,
      status,
    });
  } catch (err) {
    console.error(`[api/projects/promotions] POST error:`, err);
    return NextResponse.json(
      { error: "Failed to update promotion" },
      { status: 500 }
    );
  }
}
