// tests/agent-output.test.mjs — motor failure detection + recovered-tool-error classification
//
// detectMotorFailure matches a failure pattern ANYWHERE in the motor's output. That over-fires
// when a multi-command task has ONE sub-command error but the motor recovers and produces the
// full deliverable — a live discovery mission that gathered all its data was reported `blocked`
// because one count command printed "command failed". isRecoveredToolError distinguishes that
// recovered incident (annotate, let cerebellum arbitrate) from a real outcome failure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMotorFailure, isRecoveredToolError } from '../corekit/lib/agent-output.mjs';

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

  it('respects a custom minAnswerChars threshold', () => {
    // With an impossibly high bar, even a full deliverable is treated as too thin → not recovered.
    assert.equal(isRecoveredToolError(RECOVERED, { minAnswerChars: 100000 }), false);
  });
});
