// lib/github.ts — Central GitHub configuration
// All GitHub coordinates come from environment variables.
// Fails closed: missing vars throw at startup, never silently default.

export const GH_OWNER = process.env.GH_OWNER || 'Tachin-ai-Corporation';
export const GH_REPO = process.env.GH_REPO || 'architect-prime-gcp-agent';

export const GH_RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}`;
export const GH_API_BASE = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
