import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * NextAuth config — Google OAuth restricted to Workspace domain.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   NEXTAUTH_SECRET
 *   ALLOWED_DOMAIN  (e.g. "tachin.ai")
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          // Restrict to Workspace org
          hd: process.env.ALLOWED_DOMAIN || undefined,
          prompt: "select_account",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const domain = process.env.ALLOWED_DOMAIN;
      if (!domain) return true; // No restriction if not set
      return profile?.hd === domain;
    },
    async session({ session }) {
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
