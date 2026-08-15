import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Paths reachable without a user session.
 *
 * `/api/primes/*​/fleet/update-status` is the one machine caller: a fleet VM
 * reporting its own bootstrap outcome. It is NOT unauthenticated — the route
 * itself verifies a Google-signed GCE workload identity token
 * (`lib/machine-auth.ts`). It is exempted here only because it carries a
 * workload identity instead of a browser session.
 */
function isSessionExempt(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/auth") ||
    pathname === "/favicon.ico" ||
    /\.(png|jpg|jpeg|gif|svg|ico|webp)$/.test(pathname) ||
    pathname.endsWith("/fleet/update-status")
  );
}

/**
 * The one-time onboarding surface, reachable before OAuth exists.
 *
 * Setup mode used to allow *everything* — a deployment that had not yet
 * configured OAuth exposed every tenant read and every mutation to the open
 * internet for as long as it stayed unconfigured. It is now bounded to the
 * wizard that configures OAuth and the config it reads; everything else fails
 * closed (C-19, C-30).
 */
function isSetupSurface(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/api/setup") ||
    pathname === "/api/contracts"
  );
}

/**
 * Next.js middleware — runs on every request.
 *
 * Requires a valid NextAuth session. Before OAuth is configured, only the
 * bounded setup surface is reachable.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isSessionExempt(pathname)) {
    return NextResponse.next();
  }

  // Setup mode: OAuth not yet configured. Narrow, not open.
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    if (isSetupSurface(pathname)) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Unavailable until sign-in is configured. Complete setup first." },
        { status: 401 }
      );
    }
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Check for valid session token
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  if (!token) {
    // API routes return 401, pages redirect to sign-in
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in." },
        { status: 401 }
      );
    }
    const signInUrl = new URL("/auth/signin", request.url);
    signInUrl.searchParams.set("callbackUrl", request.url);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
