// tests/delegation-capability.test.mjs — pure tests for checkDelegationCapability (B-19, Item 2)
//
// The pathology being prevented, live: a devops agent delegated a Firebase DEPLOY (its own
// specialty's work) to an engineer with no deploy skill; the engineer could only block
// ("Unknown blocker") and the mission failed. The guard fires ONLY when work is sent AWAY
// from the agent that can do it, and only when the instruction explicitly invokes a
// distinctive capability the target lacks but the delegator owns.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDelegationCapability } from '../corekit/lib/delegation.mjs';

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
