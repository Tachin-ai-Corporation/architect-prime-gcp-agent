// lib/require-auth.ts — Server-side auth guard for API routes
// Original module
// Used by all protected API routes
//
// Returns a discriminated union: authenticated routes get the session,
// unauthenticated get a pre-built 401 response. Allows unauthenticated
// access when OAuth is not yet configured (setup mode).

import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, isAuthConfigured } from "@/lib/auth";

/**
 * Check auth on an API route. Returns the session if authenticated,
 * or a 401 NextResponse if not.
 */
export async function requireAuth(): Promise<
  | { authenticated: true; session: Awaited<ReturnType<typeof getServerSession>> }
  | { authenticated: false; response: NextResponse }
> {
  // If OAuth isn't configured, allow through (setup mode)
  if (!isAuthConfigured()) {
    return { authenticated: true, session: null };
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return {
      authenticated: false,
      response: NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 }
      ),
    };
  }

  return { authenticated: true, session };
}
