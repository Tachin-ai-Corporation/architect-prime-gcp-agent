// lib/github.ts — Central GitHub configuration
// All GitHub coordinates come from environment variables.
// Fails closed: missing vars throw at startup in production runtime, never silently default.

function resolveEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) {
    // Prevent Next.js build crashes by allowing fallback during build phase and dev mode
    const isBuild = process.env.NEXT_PHASE === "phase-production-build" || process.env.NODE_ENV !== "production";
    if (isBuild) {
      return fallback;
    }
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value;
}

export const GH_OWNER = resolveEnv("GH_OWNER", "Tachin-ai-Corporation");
export const GH_REPO = resolveEnv("GH_REPO", "architect-prime-gcp-agent");

export const GH_RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}`;
export const GH_API_BASE = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
