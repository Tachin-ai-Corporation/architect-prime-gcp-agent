// lib/github.ts — Central GitHub configuration
// All GitHub coordinates come from environment variables.
// Fails closed: missing vars throw at runtime in production, never silently default.

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

export function getGitHubOwner(): string {
  return resolveEnv("GH_OWNER", process.env.NEXT_PUBLIC_GITHUB_ORG || 'YOUR_GITHUB_ORG');
}

export function getGitHubRepo(): string {
  return resolveEnv("GH_REPO", "architect-prime-gcp-agent");
}

export function getGitHubRawBase(): string {
  return `https://raw.githubusercontent.com/${getGitHubOwner()}/${getGitHubRepo()}`;
}

export function getGitHubApiBase(): string {
  return `https://api.github.com/repos/${getGitHubOwner()}/${getGitHubRepo()}`;
}

