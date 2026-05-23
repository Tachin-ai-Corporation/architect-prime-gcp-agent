import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js middleware — runs on every request.
 *
 * If OAuth is configured (GOOGLE_CLIENT_ID is set), requires a valid
 * NextAuth session. If not configured, allows all requests through
 * so existing installs can access the setup UI.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow auth routes, static assets, and fleet callbacks
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/auth") ||
    pathname === "/favicon.ico" ||
    // Public static assets (images, icons)
    /\.(png|jpg|jpeg|gif|svg|ico|webp)$/.test(pathname) ||
    // Fleet VMs call this during bootstrap — no user session
    pathname.endsWith("/fleet/update-status")
  ) {
    return NextResponse.next();
  }

  // If OAuth isn't configured, allow everything (setup mode)
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.next();
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
