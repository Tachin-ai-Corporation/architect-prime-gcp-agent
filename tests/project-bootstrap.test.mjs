// tests/project-bootstrap.test.mjs — pure tests for the fleet project-bootstrap core.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectBootstrapEnabled, missionOriginSpace, slugifyProjectId,
  findProjectBySpace, resolveTeam, membershipGap, buildProjectDoc,
  teammatesMissingResponsibilities,
} from '../corekit/lib/project-bootstrap.mjs';

const ROSTER = [
  { email: 'product-architect-agent-archie@tachin.ag', specialty: 'product-architect', status: 'online' },
  { email: 'engineer-agent-bobby@tachin.ag', specialty: 'engineer', status: 'online' },
  { email: 'devops-agent-stan@tachin.ag', specialty: 'devops', status: 'online' },
  { email: 'designer-agent-dot@tachin.ag', specialty: 'designer', status: 'offline' },
];

describe('teammatesMissingResponsibilities', () => {
  it('flags agent teammates with no responsibilities, excluding lead/owner by role', () => {
    const team = [
      { email: 'lead@x', role: 'lead', type: 'agent' },                                  // excluded (lead)
      { email: 'owner@x', role: 'owner', type: 'human', name: 'op' },                     // excluded (owner/human)
      { email: 'eng@x', role: 'engineer', type: 'agent' },                               // flagged (no resp)
      { email: 'dev@x', role: 'devops', type: 'agent', responsibilities: 'deploys' },    // ok
      { email: 'des@x', role: 'designer', type: 'agent', responsibilities: '   ' },      // flagged (blank)
    ];
    assert.deepEqual(teammatesMissingResponsibilities(team), ['eng@x', 'des@x']);
  });
  it('returns [] for a fully-specified team and for empty/undefined input', () => {
    assert.deepEqual(teammatesMissingResponsibilities([{ email: 'a@x', role: 'engineer', type: 'agent', responsibilities: 'x' }]), []);
    assert.deepEqual(teammatesMissingResponsibilities([]), []);
    assert.deepEqual(teammatesMissingResponsibilities(undefined), []);
  });
  it('ignores string/emailless members and honors excludeRoles override', () => {
    const team = ['legacy-id', { role: 'engineer', type: 'agent' }, { email: 'e@x', role: 'engineer', type: 'agent' }];
    assert.deepEqual(teammatesMissingResponsibilities(team), ['e@x']);
    assert.deepEqual(teammatesMissingResponsibilities(team, { excludeRoles: ['engineer'] }), []);
  });
});

describe('projectBootstrapEnabled', () => {
  it('is off unless dispatch.project_bootstrap.enabled === true', () => {
    assert.equal(projectBootstrapEnabled({ dispatch: { project_bootstrap: { enabled: true } } }), true);
    assert.equal(projectBootstrapEnabled({ dispatch: { project_bootstrap: { enabled: false } } }), false);
    assert.equal(projectBootstrapEnabled({ dispatch: {} }), false);
    assert.equal(projectBootstrapEnabled(undefined), false);
  });
});

describe('missionOriginSpace', () => {
  it('reads the space the mission arrived on, in priority order', () => {
    assert.equal(missionOriginSpace({ source_meta: { space: 'spaces/XYZ' } }), 'spaces/XYZ');
    assert.equal(missionOriginSpace({ source_meta: { spaceName: 'spaces/ABC' } }), 'spaces/ABC');
    assert.equal(missionOriginSpace({ source_meta: { address: { space: 'spaces/Q' } } }), 'spaces/Q');
    assert.equal(missionOriginSpace({ source_meta: {} }), '');
    assert.equal(missionOriginSpace({}), '');
  });
});

describe('slugifyProjectId', () => {
  it('derives a kebab id and avoids collisions', () => {
    assert.equal(slugifyProjectId('1health Website'), '1health-website');
    assert.equal(slugifyProjectId('  Fancy, Name!!  '), 'fancy-name');
    assert.equal(slugifyProjectId('1health Website', ['1health-website']), '1health-website-2');
    assert.equal(slugifyProjectId('', []), 'project');
  });
});

describe('findProjectBySpace (idempotent adopt)', () => {
  const projects = {
    'tachin-web': { id: 'tachin-web', gchat_space_id: 'spaces/AAA', status: 'active' },
    'old': { id: 'old', gchat_space_id: 'spaces/BBB', status: 'archived' },
  };
  it('finds a live project bound to the space', () => {
    assert.equal(findProjectBySpace(projects, 'spaces/AAA'), 'tachin-web');
  });
  it('ignores archived + returns null when unbound', () => {
    assert.equal(findProjectBySpace(projects, 'spaces/BBB'), null);
    assert.equal(findProjectBySpace(projects, 'spaces/NEW'), null);
    assert.equal(findProjectBySpace(projects, ''), null);
  });
});

describe('resolveTeam', () => {
  it('resolves specialties to REAL roster emails; never invents', () => {
    const spec = [
      { role: 'engineer', specialty: 'engineer', responsibilities: 'code' },
      { role: 'devops', specialty: 'devops' },
    ];
    const { team, unresolved } = resolveTeam(spec, ROSTER);
    assert.equal(team[0].email, 'engineer-agent-bobby@tachin.ag');
    assert.equal(team[0].responsibilities, 'code');
    assert.equal(team[1].email, 'devops-agent-stan@tachin.ag');
    assert.deepEqual(unresolved, []);
  });
  it('leaves an unmatchable specialty unresolved (never fabricates an email)', () => {
    const { team, unresolved } = resolveTeam([{ role: 'lawyer', specialty: 'legal' }], ROSTER);
    assert.equal(team.length, 0);
    assert.deepEqual(unresolved, ['legal']);
  });
  it('passes a human owner through by email without a roster match', () => {
    const { team } = resolveTeam([{ type: 'human', role: 'owner', email: 'chill@tachin.ai', name: 'Chris' }], ROSTER);
    assert.equal(team[0].type, 'human');
    assert.equal(team[0].email, 'chill@tachin.ai');
  });
  it('offline agents are excluded by default, included with anyStatus', () => {
    assert.deepEqual(resolveTeam([{ specialty: 'designer' }], ROSTER).unresolved, ['designer']);
    assert.equal(resolveTeam([{ specialty: 'designer' }], ROSTER, { anyStatus: true }).team[0].email, 'designer-agent-dot@tachin.ag');
  });
});

describe('membershipGap', () => {
  it('returns required emails not present in the space (localpart-compared)', () => {
    const req = ['engineer-agent-bobby@tachin.ag', 'devops-agent-stan@tachin.ag'];
    const members = ['engineer-agent-bobby@tachin.ag'];
    assert.deepEqual(membershipGap(req, members), ['devops-agent-stan@tachin.ag']);
    assert.deepEqual(membershipGap(req, req), []);
    assert.deepEqual(membershipGap([], ['x@y.z']), []);
  });
});

describe('buildProjectDoc', () => {
  it('assembles a full project doc bound to the origin space', () => {
    const doc = buildProjectDoc({
      id: '1health-website', name: '1health Website', description: 'd', goal: 'g',
      spaceId: 'spaces/XYZ',
      team: [{ email: 'engineer-agent-bobby@tachin.ag', role: 'engineer', type: 'agent' }],
      canon: [{ key: 'deploy-flow', text: 'staging then prod' }],
      context: [{ key: 'source', kind: 'drive', ref: '1OJ...', summary: 'HTML' }],
      owner: 'chill@tachin.ai', createdBy: 'archie', now: '2026-08-07T00:00:00Z',
    });
    assert.equal(doc.gchat_space_id, 'spaces/XYZ');
    assert.equal(doc.status, 'active');
    assert.equal(doc.team[0].email, 'engineer-agent-bobby@tachin.ag');
    assert.equal(doc.canon.entries[0].key, 'deploy-flow');
    assert.deepEqual(doc.canon.authority, ['chill@tachin.ai']);
    assert.equal(doc.context.source.kind, 'drive');
    assert.equal(doc.context.source.ref, '1OJ...');
    assert.equal(doc.created_at, '2026-08-07T00:00:00Z');
  });
  it('omits canon/context when not provided', () => {
    const doc = buildProjectDoc({ id: 'p', spaceId: 'spaces/Z', now: 'T' });
    assert.equal('canon' in doc, false);
    assert.equal('context' in doc, false);
    assert.deepEqual(doc.team, []);
  });
});
