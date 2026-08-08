// tests/deploy-target.test.mjs — pure-core tests for corekit/lib/deploy-target.mjs (B-19)
//
// The pathology being prevented, from the live 1health delivery: a devops agent confused
// the GCP project id (tachin-website) with the Hosting site id (1health-website) and a
// bare deploy hit the project default site; a second deploy shipped a placeholder because
// the Drive source was never placed in the deploy dir. The descriptor makes site≠project
// explicit and names the source, and the render states the exact --site/--project command.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeployDescriptor, validateDeployDescriptor, renderDeployBlock, deployTargetLine,
} from '../corekit/lib/deploy-target.mjs';

const FULL = {
  platform: 'firebase-hosting',
  gcp_project: 'tachin-website',
  hosting_site: '1health-website',
  source: { kind: 'drive', ref: '1OJ9F6M9' },
  flow: 'Flow: staging → approval → live',
};

describe('normalizeDeployDescriptor', () => {
  it('keeps site and project as DISTINCT fields', () => {
    const n = normalizeDeployDescriptor(FULL);
    assert.equal(n.hosting_site, '1health-website');
    assert.equal(n.gcp_project, 'tachin-website');
    assert.notEqual(n.hosting_site, n.gcp_project, 'site must never collapse into project');
    assert.deepEqual(n.source, { kind: 'drive', ref: '1OJ9F6M9' });
  });

  it('accepts alias keys (site/project/gcpProject) and repo→git', () => {
    const n = normalizeDeployDescriptor({ site: 'sX', project: 'pY', source: { kind: 'repo', ref: 'r1' } });
    assert.equal(n.hosting_site, 'sX');
    assert.equal(n.gcp_project, 'pY');
    assert.equal(n.source.kind, 'git', 'repo is an alias for git');
    assert.equal(n.platform, 'firebase-hosting', 'defaults platform');
  });

  it('drops a malformed source but keeps the target', () => {
    const n = normalizeDeployDescriptor({ site: 'sX', project: 'pY', source: { kind: 'ftp', ref: 'x' } });
    assert.equal(n.source, null);
    assert.equal(n.hosting_site, 'sX');
  });

  it('returns null when there is nothing usable', () => {
    assert.equal(normalizeDeployDescriptor(null), null);
    assert.equal(normalizeDeployDescriptor({}), null);
    assert.equal(normalizeDeployDescriptor({ platform: 'firebase-hosting' }), null);
  });
});

describe('validateDeployDescriptor', () => {
  it('passes a complete firebase-hosting target', () => {
    assert.equal(validateDeployDescriptor(FULL).ok, true);
  });
  it('fails firebase-hosting missing the site (the deploy TARGET)', () => {
    const r = validateDeployDescriptor({ platform: 'firebase-hosting', gcp_project: 'tachin-website' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /hosting_site/);
  });
  it('fails firebase-hosting missing the project', () => {
    const r = validateDeployDescriptor({ platform: 'firebase-hosting', hosting_site: '1health-website' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /gcp_project/);
  });
  it('fails an empty descriptor', () => {
    assert.equal(validateDeployDescriptor({}).ok, false);
  });
});

describe('renderDeployBlock', () => {
  it('labels site vs project distinctly and states the --site/--project command', () => {
    const md = renderDeployBlock(FULL);
    assert.match(md, /## Deployment \(authoritative/);
    assert.match(md, /Hosting site \(deploy TARGET — firebase `--site`\): `1health-website`/);
    assert.match(md, /GCP project \(firebase `--project`\): `tachin-website`.*NOT the deploy site/);
    assert.match(md, /firebase hosting:channel:deploy staging --site 1health-website --project tachin-website/);
  });
  it('tells a drive source to be fetched INTO the deploy dir (the placeholder bug)', () => {
    assert.match(renderDeployBlock(FULL), /Google Drive file `1OJ9F6M9`.*fetch it INTO the clean deploy dir/);
  });
  it('renders a git source as a clone', () => {
    const md = renderDeployBlock({ ...FULL, source: { kind: 'git', ref: 'tachin-web' } });
    assert.match(md, /git repo `tachin-web`.*clone it/);
  });
  it('returns empty string for an invalid/absent descriptor (safe to concat)', () => {
    assert.equal(renderDeployBlock(null), '');
    assert.equal(renderDeployBlock({ platform: 'firebase-hosting', gcp_project: 'p' }), '');
  });
});

describe('deployTargetLine', () => {
  it('is a compact site/project/source one-liner for a delegated instruction', () => {
    assert.equal(deployTargetLine(FULL), 'site=1health-website project=tachin-website source=drive:1OJ9F6M9');
  });
  it('is empty when absent', () => {
    assert.equal(deployTargetLine(null), '');
  });
});
