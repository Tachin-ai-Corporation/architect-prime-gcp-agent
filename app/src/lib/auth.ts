// lib/auth.ts — NextAuth configuration with Google OAuth + domain restriction
// Original module
// Used by all API routes (via require-auth.ts) and middleware.ts

import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";

// ---- Constants ----

const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "";

// ---- Public API ----

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      authorization: {
        params: {
          prompt: "select_account",
          ...(ALLOWED_DOMAIN ? { hd: ALLOWED_DOMAIN } : {}),
        },
      },
    }),
  ],

  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60, // 24 hours
  },

  callbacks: {
    async signIn({ profile }) {
      // Enforce domain restriction server-side (hd param is only a UI hint)
      if (ALLOWED_DOMAIN) {
        const hd = (profile as Record<string, unknown>)?.hd as string | undefined;
        if (hd !== ALLOWED_DOMAIN) return false;
      }
      return true;
    },

    async jwt({ token, profile }) {
      if (profile) {
        token.picture = (profile as Record<string, unknown>).picture as string;
        token.hd = (profile as Record<string, unknown>).hd as string;
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        (session.user as Record<string, unknown>).id = token.sub;
        session.user.image = token.picture as string;
      }
      return session;
    },
  },

  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
};

/**
 * Returns true if OAuth is configured (client ID is set).
 * Used to enable graceful degradation for existing installs
 * that upgrade before configuring OAuth.
 */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}
