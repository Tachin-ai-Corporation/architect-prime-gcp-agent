// deploy-target.mjs — a prime-project's authoritative deployment target.
//
// A mission scoped to a project must deploy THAT project's content to THAT project's
// site — not guess. In a live delivery a devops agent confused the GCP/Firebase project
// id (`marketing-site`) with the Hosting site id (`acme-www`) and a bare deploy
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
 * A drive source may optionally declare its SHAPE — a single `file` (one self-contained page →
 * the site's index.html) or a `folder` (a tree of pages + assets). This removes a real
 * failure: a devops agent treated a single-FILE Drive source as an incomplete folder and its
 * cortex wrote a "download all files from the folder" criterion that could never pass. Shape is
 * optional and drive-only; when absent the deploying agent inspects what the download yields.
 * `drive_file`/`drive_folder` are accepted as friendly kind aliases for `drive` + a shape.
 *
 * @param {object} input - { platform?, gcp_project?, hosting_site?, source?:{kind,ref,shape?}, flow? }
 * @returns {null | {platform:string, gcp_project:string, hosting_site:string, source:({kind:string,ref:string,shape?:string}|null), flow:string}}
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
    let shape = s(rawSrc.shape).toLowerCase();
    if (kind === 'drive_file') { kind = 'drive'; shape = shape || 'file'; }
    else if (kind === 'drive_folder') { kind = 'drive'; shape = shape || 'folder'; }
    if (shape !== 'file' && shape !== 'folder') shape = '';   // only file|folder are meaningful
    if (kind !== 'drive') shape = '';                          // shape is drive-only (git is always a tree)
    const ref = s(rawSrc.ref || rawSrc.id || rawSrc.url);
    if (SOURCE_KINDS.has(kind) && ref) source = shape ? { kind, ref, shape } : { kind, ref };
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
      let how;
      if (n.source.kind === 'drive') {
        if (n.source.shape === 'folder') {
          how = `Google Drive FOLDER \`${n.source.ref}\` — \`drive-download ${n.source.ref}\` ALL its files into the clean deploy dir, preserving structure (a multi-page site: pages + assets)`;
        } else if (n.source.shape === 'file') {
          how = `Google Drive FILE \`${n.source.ref}\` — a single self-contained page; \`drive-download ${n.source.ref}\` and place it as \`index.html\` in the clean deploy dir. A one-page site is COMPLETE with just that file — do NOT treat a missing \`images/\` as incomplete`;
        } else {
          how = `Google Drive source \`${n.source.ref}\` — \`drive-download ${n.source.ref}\` into the clean deploy dir, then INSPECT what landed: a single file IS the site (place as \`index.html\`); a folder is the whole tree. Deploy what the source actually contains — do not assume a folder`;
        }
      } else {
        how = `git repo \`${n.source.ref}\` — clone it into a clean dir and deploy that`;
      }
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
 * "site=acme-www project=marketing-site source=drive:1OJ9…". '' when absent.
 * @param {object} d
 * @returns {string}
 */
export function deployTargetLine(d) {
  const n = (d && d.platform && d.hosting_site !== undefined) ? d : normalizeDeployDescriptor(d);
  if (!n) return '';
  const parts = [];
  if (n.hosting_site) parts.push(`site=${n.hosting_site}`);
  if (n.gcp_project) parts.push(`project=${n.gcp_project}`);
  if (n.source) {
    parts.push(`source=${n.source.kind}:${n.source.ref}`);
    if (n.source.shape) parts.push(`shape=${n.source.shape}`);
  }
  return parts.join(' ');
}
