export { auth as middleware } from "@/lib/auth";

export const config = {
  // Protect all routes except login, api/auth, and static assets
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
