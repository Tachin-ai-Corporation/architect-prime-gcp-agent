// deploy-target.mjs — a prime-project's authoritative deployment target.
//
// A mission scoped to a project must deploy THAT project's content to THAT project's
// site — not guess. In a live delivery a devops agent confused the GCP/Firebase project
// id (`tachin-website`) with the Hosting site id (`1health-website`) and a bare deploy
// hit the project's default site, then shipped a placeholder because the source was
// never placed in the deploy dir. The fix is a first-class, unambiguous deploy target on
// the project doc that renders to the deploying agent and is read as authoritative.
//
// The descriptor is a top-level project field (NOT a context-packet entry): the packet
// render only surfaces kind/name/ref/url/summary, so structured hosting_site/gcp_project
// would be dropped and never reach the brain.
//
// Pure: no I/O, no clock, no randomness (B-19).

const SOURCE_KINDS = new Set(['drive', 'git', 'repo']);

function s(v) { return (v == null ? '' : String(v)).trim(); }

/**
 * Coerce loosely-shaped input (from a bootstrap decision, project-manage JSON, or a
 * project doc) into a clean descriptor. Returns null when there is nothing usable.
 *
 * @param {object} input - { platform?, gcp_project?, hosting_site?, source?:{kind,ref}, flow? }
 * @returns {null | {platform:string, gcp_project:string, hosting_site:string, source:({kind:string,ref:string}|null), flow:string}}
 */
export function normalizeDeployDescriptor(input) {
  if (!input || typeof input !== 'object') return null;
  const platform = s(input.platform) || 'firebase-hosting';
  const gcp_project = s(input.gcp_project || input.gcpProject || input.project);
  const hosting_site = s(input.hosting_site || input.hostingSite || input.site);
  const flow = s(input.flow);

  let source = null;
  const rawSrc = input.source;
  if (rawSrc && typeof rawSrc === 'object') {
    let kind = s(rawSrc.kind).toLowerCase();
    if (kind === 'repo') kind = 'git';               // repo is an alias for git
    const ref = s(rawSrc.ref || rawSrc.id || rawSrc.url);
    if (SOURCE_KINDS.has(kind) && ref) source = { kind, ref };
  }

  // Nothing meaningful → no descriptor.
  if (!gcp_project && !hosting_site && !source) return null;
  return { platform, gcp_project, hosting_site, source, flow };
}

/**
 * Validate a descriptor for the deploy path. For firebase-hosting the deploy TARGET is
 * ambiguous without BOTH the hosting site (`--site`) and the GCP project (`--project`),
 * which is the exact confusion this field exists to remove.
 *
 * @param {object} d - a normalized descriptor (or raw input; it is normalized first)
 * @returns {{ok: boolean, reason: string}}
 */
export function validateDeployDescriptor(d) {
  const n = (d && d.platform && d.hosting_site !== undefined) ? d : normalizeDeployDescriptor(d);
  if (!n) return { ok: false, reason: 'empty or unusable deploy descriptor' };
  if (n.platform === 'firebase-hosting') {
    if (!n.hosting_site) return { ok: false, reason: 'firebase-hosting requires hosting_site (the --site deploy target)' };
    if (!n.gcp_project) return { ok: false, reason: 'firebase-hosting requires gcp_project (the --project)' };
  } else if (!n.platform) {
    return { ok: false, reason: 'platform is required' };
  }
  if (n.source && !SOURCE_KINDS.has(n.source.kind)) {
    return { ok: false, reason: `source.kind must be one of ${[...SOURCE_KINDS].join('|')}` };
  }
  return { ok: true, reason: '' };
}

/**
 * Render the authoritative Deployment block for the project-context the brain reads.
 * Labels the site and the project DISTINCTLY so neither is mistaken for the other, and
 * states the exact command shape. Returns '' when there is no valid descriptor (so the
 * caller can concatenate unconditionally).
 *
 * @param {object} d
 * @returns {string}
 */
export function renderDeployBlock(d) {
  const n = (d && d.platform && d.hosting_site !== undefined) ? d : normalizeDeployDescriptor(d);
  if (!n) return '';
  const { ok } = validateDeployDescriptor(n);
  if (!ok) return '';
  const lines = ['## Deployment (authoritative — how THIS project ships; do not infer the site)'];
  if (n.platform === 'firebase-hosting') {
    lines.push(`- Hosting site (deploy TARGET — firebase \`--site\`): \`${n.hosting_site}\``);
    lines.push(`- Firebase/GCP project (firebase \`--project\`): \`${n.gcp_project}\`   ← NOT the deploy site`);
    if (n.source) {
      const how = n.source.kind === 'drive'
        ? `Google Drive file \`${n.source.ref}\` — fetch it INTO the clean deploy dir before deploying`
        : `git repo \`${n.source.ref}\` — clone it into a clean dir and deploy that`;
      lines.push(`- Source content: ${how}`);
    }
    lines.push(`- ${n.flow || 'Flow: staging channel → share URL → owner approval → promote to live (hosting:clone)'}`);
    lines.push(`- Deploy to staging with: \`firebase hosting:channel:deploy staging --site ${n.hosting_site} --project ${n.gcp_project}\``);
  } else {
    lines.push(`- Platform: ${n.platform}`);
    if (n.gcp_project) lines.push(`- Project: \`${n.gcp_project}\``);
    if (n.hosting_site) lines.push(`- Target: \`${n.hosting_site}\``);
    if (n.source) lines.push(`- Source: ${n.source.kind} \`${n.source.ref}\``);
    if (n.flow) lines.push(`- ${n.flow}`);
  }
  return lines.join('\n');
}

/**
 * One-line target for a delegated instruction / telemetry, e.g.
 * "site=1health-website project=tachin-website source=drive:1OJ9…". '' when absent.
 * @param {object} d
 * @returns {string}
 */
export function deployTargetLine(d) {
  const n = (d && d.platform && d.hosting_site !== undefined) ? d : normalizeDeployDescriptor(d);
  if (!n) return '';
  const parts = [];
  if (n.hosting_site) parts.push(`site=${n.hosting_site}`);
  if (n.gcp_project) parts.push(`project=${n.gcp_project}`);
  if (n.source) parts.push(`source=${n.source.kind}:${n.source.ref}`);
  return parts.join(' ');
}
