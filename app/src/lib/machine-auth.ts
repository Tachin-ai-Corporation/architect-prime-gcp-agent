// lib/machine-auth.ts — Workload authentication for VM → control-plane callbacks
//
// The one caller that is a machine rather than a browser is a fleet VM reporting
// its own bootstrap outcome. Its route previously *documented* a gateway-token
// check and performed none, so any caller who could reach the Cloud Run URL could
// set any agent's status and inject an arbitrary `actionRequired` banner.
//
// The fix is GCP-native and secret-free (C-8): the VM mints a Google-signed OIDC
// identity token from its own metadata server, audience-bound to this service.
// We verify the signature against Google's keys, pin the audience, and require
// the asserted identity to be a service account **inside the operator's own
// project** (C-2). No shared secret exists to leak, rotate, or log.
//
// Fails closed (C-19): an unverifiable caller is rejected, never waved through.

import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

// One client per process — it caches Google's public keys across requests.
let client: OAuth2Client | null = null;
function oauthClient(): OAuth2Client {
  if (!client) client = new OAuth2Client();
  return client;
}

/** The GCP project this control plane belongs to. */
function tenantProject(): string {
  return process.env.GCP_PROJECT_ID || process.env.GCP_PROJECT || "";
}

/**
 * The audience a caller must have minted its token for.
 *
 * Pinned to configuration rather than the inbound Host header: a Host header is
 * attacker-controlled, and accepting it would let a token minted for a different
 * audience be replayed here.
 */
function expectedAudience(): string {
  return (process.env.NEXTAUTH_URL || "").replace(/\/+$/, "");
}

export type MachineAuthResult =
  | { authenticated: true; serviceAccount: string }
  | { authenticated: false; response: NextResponse };

function deny(reason: string, log: string): MachineAuthResult {
  console.warn(`[machine-auth] denied: ${log}`);
  return {
    authenticated: false,
    response: NextResponse.json({ error: `Unauthorized: ${reason}` }, { status: 401 }),
  };
}

/**
 * Verify that a request carries a valid GCE workload identity token issued to a
 * service account in this deployment's own GCP project.
 *
 * @param req - the inbound request
 * @param opts.allowServiceAccount - optional extra predicate on the SA email
 */
export async function requireMachineAuth(
  req: NextRequest,
  opts: { allowServiceAccount?: (email: string) => boolean } = {}
): Promise<MachineAuthResult> {
  const project = tenantProject();
  if (!project) {
    // Without a tenant project we cannot express "an identity inside our own
    // project", and a check we cannot express must not pass.
    return deny("workload identity unavailable", "GCP_PROJECT_ID is not configured");
  }

  const audience = expectedAudience();
  if (!audience) {
    return deny("workload identity unavailable", "NEXTAUTH_URL is not configured (no audience to pin)");
  }

  const header = req.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) {
    return deny("missing workload identity token", "no Bearer token on the request");
  }

  let payload;
  try {
    const ticket = await oauthClient().verifyIdToken({ idToken: match[1], audience });
    payload = ticket.getPayload();
  } catch (err) {
    return deny("invalid workload identity token", `verifyIdToken failed: ${(err as Error).message}`);
  }

  if (!payload) {
    return deny("invalid workload identity token", "token carried no payload");
  }
  if (!GOOGLE_ISSUERS.has(payload.iss || "")) {
    return deny("invalid workload identity token", `unexpected issuer ${payload.iss}`);
  }
  if (payload.email_verified !== true) {
    return deny("invalid workload identity token", "email is not verified");
  }

  const email = payload.email || "";
  const tenantSuffix = `@${project}.iam.gserviceaccount.com`;
  if (!email.endsWith(tenantSuffix)) {
    // C-2: only identities inside the operator's own project may report fleet state.
    return deny("caller is not a tenant workload", `service account ${email} is outside ${project}`);
  }
  if (opts.allowServiceAccount && !opts.allowServiceAccount(email)) {
    return deny("caller is not permitted for this route", `service account ${email} rejected by route policy`);
  }

  return { authenticated: true, serviceAccount: email };
}

/**
 * Route policy for fleet self-report: only a fleet or prime agent's own service
 * account may report agent status. `fleet-deploy` creates `fleet-<agent>`;
 * `prime-bootstrap` creates `prime-<id>`.
 */
export function isAgentServiceAccount(email: string): boolean {
  return /^(fleet|prime)-[a-z0-9][a-z0-9-]*@/.test(email);
}
