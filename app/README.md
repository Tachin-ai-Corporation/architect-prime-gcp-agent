# Architect Prime — Dashboard

Next.js 16 control plane for managing Architect Prime agent fleets.

## Tech Stack

- **Framework:** Next.js 16.2 (App Router, Turbopack)
- **Auth:** NextAuth.js v4 with Google Workspace OAuth
- **Database:** Google Cloud Firestore
- **Hosting:** Google Cloud Run
- **Secrets:** Google Secret Manager

## Getting Started

### Prerequisites

- Node.js 20+
- A GCP project with Firestore enabled
- Google OAuth Client ID (for authentication)

### Local Development

```bash
npm install
cp .env.example .env.local
# Fill in your env vars
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment Variables

See [.env.example](.env.example) for all required variables.

| Variable | Required | Description |
|----------|----------|-------------|
| `GCP_PROJECT_ID` | Yes | Google Cloud project ID |
| `GOOGLE_CLIENT_ID` | Yes* | OAuth Client ID for Google sign-in |
| `GOOGLE_CLIENT_SECRET` | Yes* | OAuth Client Secret (stored in Secret Manager in prod) |
| `NEXTAUTH_SECRET` | Yes* | Random secret for JWT encryption |
| `NEXTAUTH_URL` | Yes* | Dashboard URL (e.g., `http://localhost:3000`) |
| `ALLOWED_DOMAIN` | No | Restrict sign-in to this Google Workspace domain |

\* Required when auth is enabled. Dashboard runs in setup mode without these.

## Authentication

The dashboard uses Google Workspace OAuth with domain restriction:

1. **Middleware** blocks unauthenticated requests (except auth flow + fleet callbacks)
2. **`requireAuth()`** provides defense-in-depth on all mutating API routes
3. **Domain enforcement** validates the Google `hd` claim server-side
4. **Graceful degradation** — runs without auth until OAuth is configured

### First-time Setup

Run `install.sh` which prompts for OAuth credentials, or configure via **Settings → Security** in the dashboard UI.

## Deployment

The dashboard deploys to Cloud Run via the **Upgrade** button in the UI, which triggers a Cloud Build pipeline:

1. Clones `main` from GitHub
2. Builds Docker image
3. Pushes to Artifact Registry
4. Deploys to Cloud Run (preserving env vars)

## Project Structure

```
src/
├── app/
│   ├── api/          # API routes (primes, fleet, auth, setup, upgrade)
│   ├── auth/         # Sign-in and error pages
│   └── page.tsx      # Main dashboard page
├── components/       # React components (settings, auth provider)
├── lib/              # Auth config, require-auth helper
└── middleware.ts     # Route protection
public/
└── app-icon.png      # Application icon
```
