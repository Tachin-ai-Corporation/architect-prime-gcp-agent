import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore";

interface RouteContext {
  params: Promise<{ id: string; agent: string }>;
}

/**
 * GET /api/primes/[id]/fleet/[agent]/logs — Get fleet agent activity log
 *
 * Reads the last N messages that the fleet agent processed from Firestore.
 * Also returns heartbeat/health info from the fleet record.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { id, agent } = await ctx.params;
    const db = getDb();

    // Get fleet agent record
    const agentDoc = await db
      .collection("primes")
      .doc(id)
      .collection("fleet")
      .doc(agent)
      .get();

    if (!agentDoc.exists) {
      return NextResponse.json(
        { error: "Fleet agent not found" },
        { status: 404 }
      );
    }

    const agentData = agentDoc.data()!;

    // Get recent activity log entries (stored by the agent's inbox-daemon)
    const activitySnap = await db
      .collection("primes")
      .doc(id)
      .collection("fleet")
      .doc(agent)
      .collection("activity")
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();

    const activity = activitySnap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        type: data.type || "message",
        summary: data.summary || "",
        timestamp: data.timestamp?.toDate?.()?.toISOString() || data.timestamp || "",
        sender: data.sender || "",
      };
    });

    // Compute health from fleet record
    const lastHeartbeat = agentData.lastHeartbeat?.toDate?.()?.toISOString() ||
                          agentData.lastHeartbeat || null;
    const deployedAt = agentData.deployedAt || null;

    // Calculate uptime
    let uptimeMinutes = null;
    if (deployedAt) {
      const deployed = new Date(deployedAt);
      uptimeMinutes = Math.floor((Date.now() - deployed.getTime()) / 60000);
    }

    // Determine if agent is stale (no heartbeat in 2 minutes)
    let healthy = agentData.status === "online";
    if (lastHeartbeat) {
      const hbAge = Date.now() - new Date(lastHeartbeat).getTime();
      if (hbAge > 120000) healthy = false; // >2 min stale
    }

    return NextResponse.json({
      agent: agent,
      status: agentData.status,
      specialty: agentData.specialty || "",
      email: agentData.email || "",
      vm: agentData.vm || "",
      zone: agentData.zone || "",
      deployedAt,
      lastHeartbeat,
      uptimeMinutes,
      healthy,
      activity,
    });
  } catch (err) {
    console.error(`[api/fleet/${(await ctx.params).agent}/logs] Error:`, err);
    return NextResponse.json(
      { error: "Failed to fetch agent logs" },
      { status: 500 }
    );
  }
}
