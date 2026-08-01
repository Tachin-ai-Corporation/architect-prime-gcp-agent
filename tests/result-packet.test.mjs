// tests/result-packet.test.mjs — inter-organ result packets (ORGAN_CONTEXT_SHARING_PLAN P1)
//
// The defect under guard: a tool-agent result whose ANSWER is the tool output (a read-only
// discovery mission) was summarized by ELIDING the whole [TOOL EXECUTION LOG] to a ~53-char
// "[tool log elided]" marker — so Cortex saw no data, could not synthesize, and re-planned to
// re-observe a result it already had (52 LLM calls / 1.4M input tokens on one live mission).
// The fix: when the prose outside the log is thin, DIGEST the tool results into the summary;
// when the prose is substantial (an edit/audit verdict), keep eliding for economy. The verifier
// gets a shape-aware pack that keeps every tool RESULT (B-28 re-derivation), not a head+tail clip.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectShape, summarizeResult, buildResultPacket, digestToolResults, packToolEvidence,
} from '../corekit/lib/result-packet.mjs';

// A read-only discovery motor result: negligible prose, the DATA lives in the tool outputs.
const DISCOVERY = `I ran the requested discovery commands.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"gcloud iam service-accounts list"}) → EMAIL
svc-brain@architect-prime-beta.iam.gserviceaccount.com
svc-mouth@architect-prime-beta.iam.gserviceaccount.com
svc-ears@architect-prime-beta.iam.gserviceaccount.com
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list --format='value(name)' | wc -l"}) → 7
[END TOOL LOG]`;

// An audit motor result: the ANSWER is the prose verdict; the log is supporting noise.
const AUDIT = `Firebase hosting health audit complete. Findings: hosting is serving the live channel and returns HTTP 200 at the apex. The firebase.json rewrite to the Cloud Run backend resolves and the backend is reachable. TLS certificate is valid for 74 more days. No misconfiguration found; the site is healthy end to end and no action is required at this time.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"curl -sI https://site"}) → HTTP/2 200
[END TOOL LOG]`;

describe('detectShape — unchanged classification', () => {
  it('classifies a tool-agent result by its [TOOL EXECUTION LOG] marker', () => {
    assert.equal(detectShape(DISCOVERY), 'tool-agent');
    assert.equal(detectShape(AUDIT), 'tool-agent');
  });
  it('still classifies json-list and plain text', () => {
    assert.equal(detectShape('[{"id":"a"},{"id":"b"}]'), 'json-list');
    assert.equal(detectShape('just some prose'), 'text');
  });
});

describe('digestToolResults — keeps the tool RESULTS, not a marker', () => {
  it('surfaces each tool result within the budget', () => {
    const d = digestToolResults(DISCOVERY, 2000);
    assert.match(d, /svc-brain@architect-prime-beta/, 'first command output survives');
    assert.match(d, /svc-ears@architect-prime-beta/, 'later rows survive (not middle-dropped)');
    assert.match(d, /: 7\b/, 'the count result survives');
    assert.ok(d.length <= 2000, 'respects the budget');
  });
  it('returns empty when there is no tool log or the budget is tiny', () => {
    assert.equal(digestToolResults('no log here', 2000), '');
    assert.equal(digestToolResults(DISCOVERY, 10), '');
  });
});

describe('summarizeResult(tool-agent) — discovery keeps data, audit stays elided', () => {
  it('DISCOVERY: digests the data instead of collapsing to a bare elision marker', () => {
    const s = summarizeResult(DISCOVERY, { budget: 4000, minProse: 240 });
    // The regression: this used to be ~53 chars of "[tool log elided]".
    assert.ok(s.length > 120, `summary must carry data, got ${s.length} chars`);
    assert.match(s, /svc-brain@architect-prime-beta/, 'the discovered data is in the summary');
    assert.doesNotMatch(s, /tool log elided:/, 'must NOT elide the answer to a marker');
  });

  it('AUDIT: keeps the prose verdict and elides the log (economy, unchanged)', () => {
    const s = summarizeResult(AUDIT, { budget: 4000, minProse: 240 });
    assert.match(s, /healthy end to end/, 'the prose verdict is the answer');
    assert.match(s, /tool log elided:/, 'substantial prose → the log is elided');
  });

  it('minProse governs the branch: a high threshold forces the digest path', () => {
    // With minProse above the AUDIT prose length, even the audit is treated as data-bearing.
    const forced = summarizeResult(AUDIT, { budget: 4000, minProse: 100000 });
    assert.doesNotMatch(forced, /tool log elided:/);
    assert.match(forced, /HTTP\/2 200/, 'the tool result is digested in');
  });

  it('respects the budget on a large discovery log (target + honest clip marker)', () => {
    const big = 'preamble\n\n---\n[TOOL EXECUTION LOG]\n'
      + Array.from({ length: 20 }, (_, i) => `[TOOL] shell({"cmd":"c${i}"}) → ${'X'.repeat(400)}row${i}`).join('\n')
      + '\n[END TOOL LOG]';
    const s = summarizeResult(big, { budget: 1200, minProse: 240 });
    // `clip` hits the head+tail budget then appends a "…[N chars elided]…" marker (~45 chars),
    // so the summary is bounded to budget + one marker — never the unbounded original.
    assert.ok(s.length <= 1200 + 120, `must stay ~budget, got ${s.length}`);
    assert.ok(s.length < big.length, 'must shrink the 8KB+ original');
  });
});

describe('buildResultPacket — packet shape carries the digest', () => {
  it('DISCOVERY packet carries data, not a 53-char marker', () => {
    const pkt = buildResultPacket({ text: DISCOVERY, ref: 'w-task-1', budget: 4000, minProse: 240 });
    assert.equal(pkt.kind, 'organ_result');
    assert.equal(pkt.shape, 'tool-agent');
    assert.equal(pkt.ref, 'w-task-1');
    assert.equal(pkt.bytes, DISCOVERY.length);
    assert.ok(pkt.summary.length > 120, `packet summary must carry data, got ${pkt.summary.length}`);
    assert.match(pkt.summary, /svc-brain@architect-prime-beta/);
  });
});

describe('packToolEvidence — verifier sees every task\'s tool results', () => {
  it('keeps each task label and its tool-result data within budget', () => {
    const items = [
      { step: '1.1', agent: 'motor', output: DISCOVERY },
      { step: '1.2', agent: 'motor', output: 'plain text conclusion for task two' },
    ];
    const ev = packToolEvidence(items, 4000);
    assert.match(ev, /\[1\.1\] motor:/, 'labels the first task');
    assert.match(ev, /svc-brain@architect-prime-beta/, 'keeps the tool RESULT (not head+tail dropped)');
    assert.match(ev, /\[1\.2\] motor:/, 'labels the second task');
    assert.match(ev, /conclusion for task two/, 'keeps a non-tool-agent task output too');
    assert.ok(ev.length <= 4000, 'respects the total budget');
  });
  it('returns empty for no items or a tiny budget', () => {
    assert.equal(packToolEvidence([], 4000), '');
    assert.equal(packToolEvidence(null, 4000), '');
    assert.equal(packToolEvidence([{ step: '1.1', agent: 'motor', output: DISCOVERY }], 10), '');
  });
});
