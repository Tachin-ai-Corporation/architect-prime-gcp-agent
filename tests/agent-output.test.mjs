// tests/agent-output.test.mjs — motor failure detection + recovered-tool-error classification
//
// detectMotorFailure matches a failure pattern ANYWHERE in the motor's output. That over-fires
// when a multi-command task has ONE sub-command error but the motor recovers and produces the
// full deliverable — a live discovery mission that gathered all its data was reported `blocked`
// because one count command printed "command failed". isRecoveredToolError distinguishes that
// recovered incident (annotate, let cerebellum arbitrate) from a real outcome failure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMotorFailure, isRecoveredToolError, toolLogShowsRetryRecovery, isDeliveryCriticalIntent } from '../corekit/lib/agent-output.mjs';

// A discovery that RECOVERED: a substantive clean answer, with the failure confined to one
// tool-log line (a fragile count command), and a follow-up command that got the data anyway.
const RECOVERED = `## Infrastructure Discovery

I completed the read-only discovery of the project. Compute Engine instances: fleet-stan (RUNNING) and fleet-millie (RUNNING). IAM service accounts: 18 total, including prime-runtime and chatbot-sa. The first firewall count attempt did not work, so I listed the rules directly and counted 7 firewall rules.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"gcloud compute instances list"}) → fleet-stan RUNNING
fleet-millie RUNNING
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list --format=value(name) | wc -l"}) → Error: command failed (exit code 2): bad quoting near unexpected token
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list"}) → default-allow-ssh
default-allow-icmp
default-allow-internal
[END TOOL LOG]`;

// An ACTION task (a deploy) that RECOVERED BY RETRY: the deliverable is the successful action,
// so the prose answer is legitimately SHORT (below minAnswerChars) — recovery is proven by the
// tool log alone (a failed command superseded by a successful retry of the same action).
const DEPLOY_RETRY = `Deployed the site to the staging preview channel and captured the URL.

---
[TOOL EXECUTION LOG]
[TOOL] runCommand({"command":"firebase hosting:channel:deploy staging --cwd=/x"}) → Error: command failed: unknown option --cwd
[TOOL] runCommand({"command":"cd /x && firebase hosting:channel:deploy staging"}) → Channel URL: https://tachin-web--staging-abc123.web.app [expires 7d]
[END TOOL LOG]`;

// Same discovery, but the failed command is the TERMINAL tool call — no later success — so the
// tool log shows no retry-recovery; only the answer-length path can recover it (isolates the gate).
const RECOVERED_NORETRY = `## Infrastructure Discovery

I completed the read-only discovery. Compute Engine instances: fleet-stan (RUNNING) and fleet-millie (RUNNING). IAM service accounts: 18 total. I attempted a firewall count last but the command did not work; the rest of the discovery is complete and reported above at length so this answer clears the minimum-length gate for the isolated test below.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"gcloud compute instances list"}) → fleet-stan RUNNING
fleet-millie RUNNING
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list --format=value(name) | wc -l"}) → Error: command failed (exit code 2): bad quoting near unexpected token
[END TOOL LOG]`;

describe('detectMotorFailure — unchanged strict behavior', () => {
  it('flags a bare "Error: command failed" as an exit_code failure', () => {
    const r = detectMotorFailure('Error: command failed (exit code 1)');
    assert.equal(r.failed, true);
    assert.equal(r.type, 'exit_code');
  });
  it('flags [ERROR] Permission denied as an auth failure', () => {
    const r = detectMotorFailure('[ERROR] Permission denied while calling the API');
    assert.equal(r.failed, true);
    assert.equal(r.type, 'auth');
  });
  it('passes clean output through as not-failed', () => {
    assert.equal(detectMotorFailure('Discovery complete. 18 service accounts found.').failed, false);
  });
  it('still fires on the RECOVERED text (the reason isRecoveredToolError is needed)', () => {
    assert.equal(detectMotorFailure(RECOVERED).failed, true);
  });
});

describe('isRecoveredToolError — recovered incident vs outcome failure', () => {
  it('TRUE: failure confined to the tool log, with a substantive clean answer beside it', () => {
    assert.equal(isRecoveredToolError(RECOVERED), true);
  });

  it('FALSE: no tool log at all — the failure IS the answer', () => {
    assert.equal(isRecoveredToolError('Error: command failed (exit code 1)'), false);
  });

  it('FALSE: thin answer (below minAnswerChars) even though the failure is in the log', () => {
    const thin = 'Done.\n\n---\n[TOOL EXECUTION LOG]\n[TOOL] shell({"cmd":"x"}) → Error: command failed\n[END TOOL LOG]';
    assert.equal(isRecoveredToolError(thin), false);
  });

  it('FALSE: the answer prose itself declares the failure', () => {
    const declared = 'I attempted the discovery but Error: command failed on the primary listing and I could '
      + 'not recover from it. Here is a long explanation of everything I tried and why none of it worked, '
      + 'written out at length so the answer clears the minimum-length gate and we isolate this branch.\n\n'
      + '---\n[TOOL EXECUTION LOG]\n[TOOL] shell({"cmd":"x"}) → Error: command failed\n[END TOOL LOG]';
    assert.ok(declared.replace(/\[TOOL EXECUTION LOG\][\s\S]*/, '').trim().length >= 200, 'fixture answer is long enough');
    assert.equal(isRecoveredToolError(declared), false);
  });

  it('FALSE: a clean tool log with no failure in it (nothing to recover from)', () => {
    const clean = RECOVERED.replace(/Error: command failed[^\n]*/, 'default-deny-all');
    assert.equal(detectMotorFailure(clean.match(/\[TOOL EXECUTION LOG\][\s\S]*/)[0]).failed, false);
    assert.equal(isRecoveredToolError(clean), false);
  });

  it('answer-length gate: an impossibly-high bar defeats the ANSWER path when the log shows no retry-recovery', () => {
    // RECOVERED_NORETRY's failure is the terminal tool call → no retry-recovery; only the answer
    // path can recover it, and an impossibly-high bar closes that path.
    assert.equal(isRecoveredToolError(RECOVERED_NORETRY, { minAnswerChars: 100000 }), false);
    assert.equal(isRecoveredToolError(RECOVERED_NORETRY), true); // default bar: its long answer recovers it
  });
});

describe('retry-recovery — a failed command superseded by a later success (action tasks)', () => {
  it('isRecoveredToolError TRUE: short answer, but the log shows the deploy retried and succeeded', () => {
    assert.ok(DEPLOY_RETRY.replace(/\[TOOL EXECUTION LOG\][\s\S]*/, '').trim().length < 200, 'fixture answer is short');
    assert.equal(detectMotorFailure(DEPLOY_RETRY).failed, true, 'the failed --cwd attempt still trips detection');
    assert.equal(isRecoveredToolError(DEPLOY_RETRY), true);
  });
  it('toolLogShowsRetryRecovery TRUE when a non-failing call follows the last failing one', () => {
    assert.equal(toolLogShowsRetryRecovery(DEPLOY_RETRY.match(/\[TOOL EXECUTION LOG\][\s\S]*/)[0]), true);
  });
  it('toolLogShowsRetryRecovery FALSE when the terminal call failed (no recovery)', () => {
    assert.equal(toolLogShowsRetryRecovery(RECOVERED_NORETRY.match(/\[TOOL EXECUTION LOG\][\s\S]*/)[0]), false);
  });
  it('toolLogShowsRetryRecovery FALSE with fewer than two tool entries', () => {
    assert.equal(toolLogShowsRetryRecovery('[TOOL EXECUTION LOG]\n[TOOL] x() → Error: command failed\n[END TOOL LOG]'), false);
  });
});

// WS-1b: a delivery-critical task (deploy/publish/promote) must not soft-pass a failed command
// on PROSE LENGTH alone — confident narrative is not a deployed artifact. It still soft-passes
// on PROVEN retry-recovery (the deploy actually succeeded on a second attempt), preserving FU-A.
describe('isDeliveryCriticalIntent — delivery-critical task detection', () => {
  it('TRUE for deploy / publish / promote / release / go-live / push-to-production / firebase deploy', () => {
    for (const s of [
      'Deploy the site to the staging channel.',
      'Publish the updated docs to the site.',
      'Promote staging to production.',
      'Cut a release of the package.',
      'Take the feature go live for all users.',
      'Push to production once approved.',
      'Run firebase deploy for the hosting target.',
      'Update the deployment and share the URL.',
    ]) assert.equal(isDeliveryCriticalIntent(s), true, s);
  });
  it('FALSE for tasks with no delivery verb', () => {
    for (const s of [
      'Summarize the meeting notes into three bullets.',
      'Edit index.html to add a noindex meta tag.',
      'Gather the last three missions for each agent.',
      '',
      null,
    ]) assert.equal(isDeliveryCriticalIntent(s), false, String(s));
  });
});

describe('isRecoveredToolError requireActionRecovery — the delivery-critical soft-pass gate', () => {
  // A failed deploy whose motor wrote a LONG confident narrative but never retried: the
  // answer-length path would soft-pass it (false-complete). requireActionRecovery closes that.
  const DEPLOY_FAIL_LONG_PROSE = `I have completed the deployment of the site to the staging preview channel. `
    + `The build compiled cleanly, assets were uploaded, and the hosting configuration was applied as specified. `
    + `Everything looks good and the site should now be live on the staging URL for review by the team.\n\n`
    + `---\n[TOOL EXECUTION LOG]\n`
    + `[TOOL] runCommand({"command":"firebase hosting:channel:deploy staging"}) → Error: command failed (exit code 1): HTTP Error: 403, permission denied\n`
    + `[END TOOL LOG]`;

  it('default (non-delivery): long prose beside a tool-log failure recovers (unchanged behavior)', () => {
    assert.ok(DEPLOY_FAIL_LONG_PROSE.replace(/\[TOOL EXECUTION LOG\][\s\S]*/, '').trim().length >= 200);
    assert.equal(isRecoveredToolError(DEPLOY_FAIL_LONG_PROSE), true);
  });
  it('requireActionRecovery: the SAME failed deploy no longer soft-passes on prose length', () => {
    assert.equal(isRecoveredToolError(DEPLOY_FAIL_LONG_PROSE, { requireActionRecovery: true }), false);
  });
  it('requireActionRecovery preserves FU-A: a deploy that retried and SUCCEEDED still recovers', () => {
    // DEPLOY_RETRY: first attempt failed on --cwd, retry produced a Channel URL → proven action recovery.
    assert.equal(isRecoveredToolError(DEPLOY_RETRY, { requireActionRecovery: true }), true);
  });
});
