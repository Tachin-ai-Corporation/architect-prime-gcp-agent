// corekit/system/identity-scan.mjs — no operator identity in files every fork receives
//
// This repo is a PUBLIC template: anyone forks it and bootstraps their own
// deployment. A concrete address in a shipped platform file hands one operator's
// identity to every fork, and unlike a project id it is a person's contact
// details rather than a config value.
//
// Stated as a POSITIVE rule, like the project-id check beside it: an
// email-shaped literal in these positions must use a sanctioned placeholder
// domain, or be a structural cloud identity rather than a human one. Phrasing it
// positively means the check itself leaks nothing — there is no list of real
// domains to read out of the source.
//
// Repo-only tooling, like compile-contracts: it is invoked by
// `validate-contracts --repo` and is not installed onto any VM.

/** Domains that are placeholders by convention — safe to ship. */
export const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net',
  'domain.tld', 'yourcompany.com', 'your-domain.com', 'yourdomain.com',
  'local', 'localhost', 'test',
]);

/**
 * Addresses that are machine identities, not people.
 *
 * A GCP service account is an address in shape only — it is derived from a
 * project or a role, carries no personal information, and is usually built from
 * a variable at that. Flagging it would train people to ignore the check.
 */
const MACHINE_ADDRESS = /@[A-Za-z0-9.-]*\.?gserviceaccount\.com$/;

/** An email-shaped literal. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Files whose addresses are not ours to control or not shipped as our content.
 *
 * `.github/CODEOWNERS` is exempt TEMPORARILY. It is the one file whose owner
 * must resolve to a real GitHub identity or every rule in it silently becomes a
 * no-op — a placeholder there would leave branch protection configured and
 * unenforced, which is worse than the address it replaced. The exemption is
 * removed in the same commit that moves the file to a team handle, at which
 * point it holds no address at all.
 */
export const EXEMPT = [
  /(^|\/)package-lock\.json$/,   // third-party author metadata, not ours
  /(^|\/)node_modules\//,
  /^operator\//,                 // charter-exempt: operator-specific by design
  /^\.github\/CODEOWNERS$/,      // temporary — see above
];

const SCANNED = /^(infra|corekit|app|\.github)\//;
const EXT = /\.(ts|tsx|js|mjs|cjs|sh|json|md|txt|ya?ml)$|CODEOWNERS$/;

/** Should this file be scanned at all? */
export function inScope(path) {
  if (!SCANNED.test(path)) return false;
  if (!EXT.test(path)) return false;
  return !EXEMPT.some((rx) => rx.test(path));
}

/** Is this particular address acceptable to ship? */
export function isAllowedAddress(address) {
  if (MACHINE_ADDRESS.test(address)) return true;
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return PLACEHOLDER_DOMAINS.has(domain);
}

/**
 * Scan a set of files for shippable-looking addresses that are not placeholders.
 *
 * @param {string[]} files - repo-relative paths
 * @param {(path: string) => string} readFile
 * @returns {{ ok: boolean, scanned: number, hits: Array<{file,line,address}>, reason?: string }}
 */
export function scanOperatorIdentity(files, readFile) {
  const scoped = files.filter(inScope);

  // Never pass vacuously. An empty file list means the scope broke, not that the
  // repo is clean — a check that tests nothing is worse than no check, because
  // it reads as proof. (The dead secret-scanner shipped exactly this way.)
  if (scoped.length === 0) {
    return { ok: false, scanned: 0, hits: [], reason: 'no files matched the scan scope — the scope is broken' };
  }

  const hits = [];
  for (const file of scoped) {
    let src;
    try {
      src = readFile(file);
    } catch {
      continue; // a listed-but-unreadable file is not a violation
    }
    for (const [i, line] of src.split('\n').entries()) {
      for (const m of line.match(EMAIL) || []) {
        if (!isAllowedAddress(m)) hits.push({ file, line: i + 1, address: m });
      }
    }
  }

  return { ok: hits.length === 0, scanned: scoped.length, hits };
}

// ---- CLI: reads a NUL- or newline-separated file list on stdin ----
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { readFileSync } = await import('node:fs');
  const files = readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
  const result = scanOperatorIdentity(files, (f) => readFileSync(f, 'utf8'));
  if (result.ok) {
    console.log('OK');
  } else if (result.reason) {
    console.log(`ERROR: ${result.reason}`);
  } else {
    for (const h of result.hits.slice(0, 8)) console.log(`${h.file}:${h.line}: ${h.address}`);
  }
}
