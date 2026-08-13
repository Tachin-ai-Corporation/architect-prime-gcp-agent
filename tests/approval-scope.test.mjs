// tests/approval-scope.test.mjs — pure tests for scopeApprovalsToAgent (approval-leakage fix)
//
// The pathology being prevented, live: a web-master agent (tom) was asked to promote the
// 1health site to production. When the operator replied "approve", the resolver queried
// approvals scoped ONLY by prime_id and surfaced a disambiguation of 7 "pending approvals"
// — mostly OTHER agents' / OLD missions' gates (a home.html review, a DESIGN_SYSTEM.md
// review, p-repo-improve proposals) accumulated over days/weeks. Owner scope (refined to the
// same conversation) collapses that back to just the resolving agent's own, in-context gate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scopeApprovalsToAgent } from '../corekit/lib/approvals.mjs';

const TOM = 'web-agent-tom@tachin.ag';
const SPACE_1HEALTH = 'spaces/AAQA2xzUYgM';

// Builds an approval doc as checkpoint-executor now stamps it.
const A = (o) => ({
  id: o.id,
  owner: o.owner,
  envelopeId: o.env || o.id,
  source_space: o.space,
  project_id: o.project,
  source_channel: o.channel,
  title: o.title,
});

describe('scopeApprovalsToAgent', () => {
  it('REPRODUCES the incident: tom\'s one prod gate survives; six cross-agent/old gates are dropped', () => {
    const pending = [
      A({ id: 'apr-prod', owner: TOM, space: SPACE_1HEALTH, project: '1health-website', channel: 'gchat', title: 'Promote 1health to production' }),
      A({ id: 'apr-old1', owner: 'devops-agent-stan@tachin.ag', channel: 'gchat', title: 'Report staging URL (old p-web-deploy)' }),
      A({ id: 'apr-old2', owner: 'design-agent-dot@tachin.ag', space: 'spaces/OTHER', title: 'Review DESIGN_SYSTEM.md' }),
      A({ id: 'apr-old3', owner: 'architect-agent-archie@tachin.ag', title: 'Push generic improvements (p-repo-improve)' }),
      A({ id: 'apr-old4', owner: 'devops-agent-stan@tachin.ag', channel: 'gchat', title: 'Report staging URL (dup)' }),
      A({ id: 'apr-legacy', owner: undefined, title: 'Pre-stamp gate with no owner' }),
    ];
    const scoped = scopeApprovalsToAgent(pending, { agentEmail: TOM, space: SPACE_1HEALTH, channel: 'gchat' });
    assert.deepEqual(scoped.map(a => a.id), ['apr-prod']);
  });

  it('owner scope is STRICT: another agent\'s gate is never returned', () => {
    const pending = [
      A({ id: 'a1', owner: 'devops-agent-stan@tachin.ag', channel: 'gchat' }),
      A({ id: 'a2', owner: 'architect-agent-archie@tachin.ag', channel: 'gchat' }),
    ];
    const scoped = scopeApprovalsToAgent(pending, { agentEmail: TOM, channel: 'gchat' });
    assert.deepEqual(scoped, []);
  });

  it('drops legacy owner-less docs when the agent identity is known (stale cross-mission residue)', () => {
    const pending = [
      A({ id: 'own', owner: TOM, channel: 'gchat', title: 'my gate' }),
      A({ id: 'legacy', owner: undefined, channel: 'gchat', title: 'pre-stamp gate' }),
    ];
    const scoped = scopeApprovalsToAgent(pending, { agentEmail: TOM, channel: 'gchat' });
    assert.deepEqual(scoped.map(a => a.id), ['own']);
  });

  it('SPACE refines: with two of my gates in different spaces, keep only the reply\'s space', () => {
    const pending = [
      A({ id: 'here', owner: TOM, space: SPACE_1HEALTH, channel: 'gchat' }),
      A({ id: 'elsewhere', owner: TOM, space: 'spaces/OTHER', channel: 'gchat' }),
    ];
    const scoped = scopeApprovalsToAgent(pending, { agentEmail: TOM, space: SPACE_1HEALTH, channel: 'gchat' });
    assert.deepEqual(scoped.map(a => a.id), ['here']);
  });

  it('PROJECT refines when space is absent on the reply', () => {
    const pending = [
      A({ id: 'p1', owner: TOM, project: '1health-website', channel: 'gchat' }),
      A({ id: 'p2', owner: TOM, project: 'other-site', channel: 'gchat' }),
    ];
    const scoped = scopeApprovalsToAgent(pending, { agentEmail: TOM, projectId: '1health-website', channel: 'gchat' });
    assert.deepEqual(scoped.map(a => a.id), ['p1']);
  });

  it('NEVER strands: a space discriminator that matches none of my (legacy) gates is skipped', () => {
    const pending = [
      A({ id: 'g1', owner: TOM, channel: 'gchat' }), // no source_space (legacy)
      A({ id: 'g2', owner: TOM, channel: 'gchat' }),
    ];
    // Reply carries a space, but my own gates predate space-stamping → keep the owner-scoped set.
    const scoped = scopeApprovalsToAgent(pending, { agentEmail: TOM, space: SPACE_1HEALTH, channel: 'gchat' });
    assert.deepEqual(scoped.map(a => a.id), ['g1', 'g2']);
  });

  it('single owned gate short-circuits (no refinement needed)', () => {
    const pending = [
      A({ id: 'only', owner: TOM, space: 'spaces/SOMETHING_ELSE' }),
      A({ id: 'other', owner: 'devops-agent-stan@tachin.ag' }),
    ];
    // Even though the reply space differs from the gate's space, my single owned gate is returned.
    const scoped = scopeApprovalsToAgent(pending, { agentEmail: TOM, space: SPACE_1HEALTH });
    assert.deepEqual(scoped.map(a => a.id), ['only']);
  });

  it('no agent identity → do NOT over-filter (safety fallback for a mis-provisioned agent)', () => {
    const pending = [A({ id: 'x', owner: 'a@b.c' }), A({ id: 'y', owner: 'd@e.f' })];
    const scoped = scopeApprovalsToAgent(pending, { space: SPACE_1HEALTH });
    assert.deepEqual(scoped.map(a => a.id), ['x', 'y']);
  });

  it('empty / non-array input → []', () => {
    assert.deepEqual(scopeApprovalsToAgent([], { agentEmail: TOM }), []);
    assert.deepEqual(scopeApprovalsToAgent(null, { agentEmail: TOM }), []);
    assert.deepEqual(scopeApprovalsToAgent(undefined, {}), []);
  });
});
