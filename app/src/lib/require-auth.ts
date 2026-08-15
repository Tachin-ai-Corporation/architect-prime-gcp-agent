// lib/require-auth.ts — Server-side auth guard for API routes
// Used by protected API routes as defense in depth.
//
// The *structural* gate is `src/middleware.ts`: it fails closed for every path
// that is not explicitly exempt, so a new route is protected the moment it
// exists rather than when someone remembers to call this. This helper adds a
// second check inside the handler.
//
// Returns a discriminated union: authenticated routes get the session,
// unauthenticated get a pre-built 401 response.
//
// The setup-mode allowance below is safe only because middleware narrows
// unauthenticated access to the onboarding surface (`isSetupSurface`). If that
// narrowing is ever removed, this allowance becomes a fail-open hole again.

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
