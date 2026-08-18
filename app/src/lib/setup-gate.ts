/**
 * Who may reach the first-run setup surface.
 *
 * The setup wizard exists because a fresh deployment has no OAuth yet, so it
 * cannot be protected by a session. It was therefore reachable by anyone: on an
 * `--allow-unauthenticated` Cloud Run service with `GOOGLE_CLIENT_ID` absent,
 * `POST /api/setup/oauth` accepted caller-supplied OAuth credentials, read and
 * wrote Secret Manager, and updated the running service — a control-plane
 * takeover for whoever found the URL first. This deployment happens to have
 * OAuth configured, so the window was closed here; it is open on every fork and
 * every fresh install until setup completes.
 *
 * The rule, from which everything below follows: **missing authentication
 * configuration must LOCK the application, not open an administrative mode.**
 *
 * So the setup surface is gated on a bootstrap token that `install.sh` generates
 * and prints to the installing operator's own terminal. Holding it proves access
 * to the deploying environment, which is exactly the authority first-run setup
 * needs and precisely what an internet caller lacks. No token configured means
 * locked — never open.
 */

export type SetupGate =
  /** OAuth is configured; normal session auth applies and setup is closed. */
  | { state: 'configured' }
  /** No OAuth and no bootstrap token: nothing is reachable. Fail closed. */
  | { state: 'locked'; reason: string }
  /** No OAuth, bootstrap token configured: the wizard is reachable WITH the token. */
  | { state: 'bootstrap' };

export function setupGate(env: {
  GOOGLE_CLIENT_ID?: string;
  SETUP_BOOTSTRAP_TOKEN?: string;
}): SetupGate {
  if (env.GOOGLE_CLIENT_ID) return { state: 'configured' };
  const token = (env.SETUP_BOOTSTRAP_TOKEN ?? '').trim();
  if (!token) {
    return {
      state: 'locked',
      reason:
        'Sign-in is not configured and no setup bootstrap token is set. This deployment is ' +
        'locked. Re-run the installer, which prints a one-time setup token.',
    };
  }
  return { state: 'bootstrap' };
}

/** Where a caller may present the bootstrap token. Header first; query is a fallback for the browser wizard's first hop. */
export const BOOTSTRAP_HEADER = 'x-setup-token';
export const BOOTSTRAP_QUERY = 'setup_token';

/**
 * Compare in constant time for equal-length inputs, and reject anything short.
 *
 * A trivially guessable token is worse than none, because it reads as protection.
 */
export function bootstrapTokenMatches(provided: string | null | undefined, expected: string | null | undefined): boolean {
  const a = (provided ?? '').trim();
  const b = (expected ?? '').trim();
  if (a.length < 24 || b.length < 24) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pull the token off a request, header before query. */
export function presentedToken(req: { headers: { get(name: string): string | null }; nextUrl?: { searchParams: URLSearchParams } }): string | null {
  return req.headers.get(BOOTSTRAP_HEADER) ?? req.nextUrl?.searchParams.get(BOOTSTRAP_QUERY) ?? null;
}
