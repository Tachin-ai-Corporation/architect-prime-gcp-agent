import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, isAuthConfigured } from "@/lib/auth";

/**
 * Check auth on an API route. Returns the session if authenticated,
 * or a 401 NextResponse if not.
 *
 * If OAuth is not yet configured (GOOGLE_CLIENT_ID not set),
 * allows unauthenticated access for backward compat with
 * existing installs that haven't set up OAuth yet.
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
