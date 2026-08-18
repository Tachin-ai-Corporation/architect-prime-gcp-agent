import { getToken } from "next-auth/jwt";
import { setupGate, bootstrapTokenMatches, presentedToken } from "@/lib/setup-gate";
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

  // Setup mode: OAuth not yet configured. Narrow, TOKEN-GATED, and lockable.
  //
  // Narrow was not enough. With no OAuth the setup surface had no credential at
  // all, so `POST /api/setup/oauth` accepted caller-supplied OAuth credentials,
  // touched Secret Manager and updated the running service — a control-plane
  // takeover for whoever reached an unconfigured deployment first. Missing auth
  // configuration must LOCK the app, not open an administrative mode.
  const gate = setupGate({
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    SETUP_BOOTSTRAP_TOKEN: process.env.SETUP_BOOTSTRAP_TOKEN,
  });

  if (gate.state !== "configured") {
    // No bootstrap token means nothing is reachable — including the wizard.
    if (gate.state === "locked") {
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: gate.reason }, { status: 503 })
        : new NextResponse(gate.reason, { status: 503, headers: { "content-type": "text/plain" } });
    }
    // Bootstrap: the wizard is reachable only with the token the installer printed.
    if (isSetupSurface(pathname)) {
      if (bootstrapTokenMatches(presentedToken(request), process.env.SETUP_BOOTSTRAP_TOKEN)) {
        return NextResponse.next();
      }
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: "Setup requires the one-time token printed by the installer." }, { status: 401 })
        : new NextResponse("Setup requires the one-time token printed by the installer.", {
            status: 401, headers: { "content-type": "text/plain" },
          });
    }
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
