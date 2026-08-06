// tests/delegation-capability.test.mjs — pure tests for checkDelegationCapability (B-19, Item 2)
//
// The pathology being prevented, live: a devops agent delegated a Firebase DEPLOY (its own
// specialty's work) to an engineer with no deploy skill; the engineer could only block
// ("Unknown blocker") and the mission failed. The guard fires ONLY when work is sent AWAY
// from the agent that can do it, and only when the instruction explicitly invokes a
// distinctive capability the target lacks but the delegator owns.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDelegationCapability, summarizeDelegationResult, delegationResultAgent } from '../corekit/lib/delegation.mjs';

// Mirrors corekit/config/agent-types.json.
const specialtySkills = {
  devops: ['web-search', 'workspace-drive', 'skill-introspect', 'memory-consolidate', 'gcloud', 'gsutil', 'docker', 'firebase'],
  engineer: ['web-search', 'workspace-drive', 'skill-introspect', 'memory-consolidate', 'coding', 'code-review'],
};

describe('checkDelegationCapability', () => {
  it('FIRES on the observed failure: devops delegating a firebase deploy to engineer', () => {
    const r = checkDelegationCapability({
      instruction: 'Deploy the updated website to the tachin-website.web.app Firebase Hosting channel using p-web-deploy.',
      delegatorSpecialty: 'devops', targetSpecialty: 'engineer', specialtySkills,
    });
    assert.equal(r.ok, false);
    assert.equal(r.selfCapable, true);
    assert.deepEqual(r.offending, ['firebase']);
  });

  it('is direction-aware: engineer delegating a firebase deploy TO devops is fine', () => {
    const r = checkDelegationCapability({
      instruction: 'Deploy the site to Firebase hosting.',
      delegatorSpecialty: 'engineer', targetSpecialty: 'devops', specialtySkills,
    });
    assert.equal(r.ok, true); // firebase is not in the engineer's gap — devops has it
  });

  it('does NOT fire when the delegated work is genuinely cross-specialty (no capability token)', () => {
    const r = checkDelegationCapability({
      instruction: 'Write the website source code: add a robots.txt and noindex meta tags to every page.',
      delegatorSpecialty: 'devops', targetSpecialty: 'engineer', specialtySkills,
    });
    assert.equal(r.ok, true); // coding work → correctly delegated to the engineer
  });

  it('does NOT fire on a filename that merely contains a skill id (firebase.json)', () => {
    const r = checkDelegationCapability({
      instruction: 'Engineer: update the firebase.json hosting rewrites in the repo.',
      delegatorSpecialty: 'devops', targetSpecialty: 'engineer', specialtySkills,
    });
    assert.equal(r.ok, true); // "firebase.json" is a file, not an invocation of the firebase CLI
  });

  it('collects multiple offending capabilities', () => {
    const r = checkDelegationCapability({
      instruction: 'Use gcloud and docker to build and push the image, then deploy.',
      delegatorSpecialty: 'devops', targetSpecialty: 'engineer', specialtySkills,
    });
    assert.equal(r.ok, false);
    assert.ok(r.offending.includes('gcloud') && r.offending.includes('docker'));
  });

  it('same specialty is a no-op (self-delegation guard handles that)', () => {
    const r = checkDelegationCapability({
      instruction: 'Deploy via firebase.', delegatorSpecialty: 'devops', targetSpecialty: 'devops', specialtySkills,
    });
    assert.equal(r.ok, true);
  });

  it('degrades to a no-op on missing inputs (guard skipped, never throws)', () => {
    assert.equal(checkDelegationCapability({}).ok, true);
    assert.equal(checkDelegationCapability({ instruction: 'deploy via firebase', delegatorSpecialty: 'devops', targetSpecialty: 'engineer' }).ok, true); // no map
    assert.equal(checkDelegationCapability({ instruction: 'x', delegatorSpecialty: 'unknown', targetSpecialty: 'engineer', specialtySkills }).ok, true); // unknown delegator caps
  });
});

// Regression guard for the delegation-result-misread bug: a completed delegation was
// labelled by the envelope's `owner` (= the DELEGATOR), so cortex read a teammate's
// finished work as a failed "self-delegation" and re-planned / self-executed.
describe('delegationResultAgent', () => {
  it('labels by the DELEGATE email (source_meta.target_agent_email), NOT owner=delegator', () => {
    const env = { owner: 'product-architect-agent-archie@x', source_meta: { target_agent_email: 'engineer-agent-bobby@x' } };
    assert.equal(delegationResultAgent(env), 'engineer-agent-bobby@x');
  });
  it('falls back to owner when there is no delegate email', () => {
    assert.equal(delegationResultAgent({ owner: 'devops-agent-stan@x', source_meta: {} }), 'devops-agent-stan@x');
    assert.equal(delegationResultAgent({ owner: 'devops-agent-stan@x' }), 'devops-agent-stan@x');
  });
  it("returns 'unknown' for a null/empty envelope", () => {
    assert.equal(delegationResultAgent(null), 'unknown');
    assert.equal(delegationResultAgent({}), 'unknown');
  });
});

describe('summarizeDelegationResult', () => {
  const toStr = (v) => (v == null ? '' : String(v));
  it('a completed delegation is SUCCESS, labelled by the delegate, carrying its output', () => {
    const env = { status: 'complete', owner: 'delegator@x', source_meta: { target_agent_email: 'bobby@x' }, instruction: 'edit index.html', output: 'done: The proof' };
    assert.deepEqual(summarizeDelegationResult(env, toStr), { agent: 'bobby@x', task: 'edit index.html', result: 'done: The proof', success: true });
  });
  it("treats 'archived' as terminal success (a delivered result the sweeper archived)", () => {
    const r = summarizeDelegationResult({ status: 'archived', source_meta: { target_agent_email: 'bobby@x' }, output: 'ok' }, toStr);
    assert.equal(r.success, true);
    assert.equal(r.result, 'ok');
  });
  it('a failed delegation carries [FAILED] + the error, not the output', () => {
    const r = summarizeDelegationResult({ status: 'failed', owner: 'delegator@x', error: 'boom', output: 'ignored' }, toStr);
    assert.equal(r.success, false);
    assert.equal(r.result, '[FAILED] boom');
    assert.equal(r.agent, 'delegator@x'); // no delegate email → owner fallback
  });
  it('truncates task and result to their caps', () => {
    const r = summarizeDelegationResult({ status: 'complete', instruction: 'x'.repeat(500), output: 'y'.repeat(9000), source_meta: { target_agent_email: 'b@x' } }, toStr);
    assert.equal(r.task.length, 200);
    assert.equal(r.result.length, 4000);
  });
  it('works without a toStr (defaults to String coercion)', () => {
    const r = summarizeDelegationResult({ status: 'complete', instruction: 42, output: 7, source_meta: { target_agent_email: 'b@x' } });
    assert.equal(r.task, '42');
    assert.equal(r.result, '7');
  });
});
