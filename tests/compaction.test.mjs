// tests/compaction.test.mjs — pure-core tests for platform/context/compaction.mjs (B-19)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepCheckpointNum, renderCheckpointDigest, buildPriorWorkContext,
  shouldCompact, splitIterationBlocks, redactSecrets, validateMissionDigest, spliceCompacted,
} from '../platform/context/compaction.mjs';

describe('stepCheckpointNum', () => {
  it('extracts the checkpoint prefix', () => {
    assert.equal(stepCheckpointNum('2.3'), 2);
    assert.equal(stepCheckpointNum('10.1'), 10);
  });
  it('returns null without a prefix', () => {
    assert.equal(stepCheckpointNum('nope'), null);
    assert.equal(stepCheckpointNum(undefined), null);
    assert.equal(stepCheckpointNum(3), null);
  });
});

describe('renderCheckpointDigest', () => {
  const results = [
    { step: '1.1', agent: 'motor', success: true, result: 'built the report and saved it' },
    { step: '1.2', agent: 'cerebellum', success: false, result: 'criteria unmet: missing totals' },
  ];

  it('includes accept criteria verbatim (B-25)', () => {
    const criteria = 'Totals MUST match the ledger exactly; no rounding.';
    const d = renderCheckpointDigest({ cpNum: 1, acceptCriteria: criteria, results });
    assert.ok(d.includes(criteria));
  });

  it('carries per-step verdicts and excerpts', () => {
    const d = renderCheckpointDigest({ cpNum: 1, results });
    assert.ok(d.includes('Step 1.1 (motor): SUCCESS'));
    assert.ok(d.includes('Step 1.2 (cerebellum): FAILED'));
  });

  it('includes a recovery pointer when missionId is given', () => {
    const d = renderCheckpointDigest({ cpNum: 1, results, missionId: 'm-abc' });
    assert.ok(d.includes('mission m-abc'));
  });

  it('caps excerpts and the whole digest', () => {
    const big = [{ step: '1.1', agent: 'motor', success: true, result: 'x'.repeat(50_000) }];
    const d = renderCheckpointDigest({ cpNum: 1, results: big, excerptChars: 100, capChars: 4000 });
    assert.ok(d.length <= 4100); // cap + truncation marker slack
  });
});

describe('buildPriorWorkContext', () => {
  const checkpoints = [
    { instruction: 'Gather data', accept_criteria: 'All sources fetched' },
    { instruction: 'Build report', accept_criteria: 'Report complete' },
  ];
  const allResults = [
    { step: '1.1', agent: 'motor', success: true, result: 'fetched A '.repeat(200) },
    { step: '1.2', agent: 'motor', success: true, result: 'fetched B '.repeat(200) },
  ];
  const cpResults = [
    { step: '2.1', agent: 'motor', success: true, result: 'drafted section one' },
  ];

  it('returns undefined with no prior work', () => {
    assert.equal(buildPriorWorkContext({ checkpoints, allResults: [], cpResults: [], currentCpNum: 1 }), undefined);
  });

  it('digests completed checkpoints and keeps the current one verbatim', () => {
    const out = buildPriorWorkContext({ checkpoints, allResults, cpResults, currentCpNum: 2, stepChars: 8000 });
    assert.ok(out.includes('[CHECKPOINT 1 DIGEST'));
    assert.ok(out.includes('All sources fetched'));
    // Current CP result appears verbatim, not inside a digest
    assert.ok(out.includes('drafted section one'));
    assert.ok(!out.includes('[CHECKPOINT 2 DIGEST'));
  });

  it('is dramatically smaller than the doubled verbatim transcript it replaces', () => {
    const bigResults = [];
    for (let cp = 1; cp <= 3; cp++) {
      for (let t = 1; t <= 3; t++) {
        bigResults.push({ step: `${cp}.${t}`, agent: 'motor', success: true, result: 'y'.repeat(8000) });
      }
    }
    const out = buildPriorWorkContext({
      checkpoints: [{}, {}, {}, {}], allResults: bigResults, cpResults: [], currentCpNum: 4,
      stepChars: 8000, digestChars: 4000,
    });
    // Old behavior shipped 2 × 9 × 8000 = 144K chars; digests cap at 3 × 4000.
    assert.ok(out.length <= 3 * 4000 + 200);
  });

  it('keeps unprefixed results verbatim (crash-resume shapes)', () => {
    const out = buildPriorWorkContext({
      checkpoints,
      allResults: [{ step: 'legacy', agent: 'motor', success: true, result: 'legacy result' }],
      cpResults: [],
      currentCpNum: 2,
      stepChars: 8000,
    });
    assert.ok(out.includes('legacy result'));
  });
});

describe('shouldCompact (deterministic trigger, C-4)', () => {
  const cfg = { working_budget_tokens: 80000, trigger_pct: 0.7, min_compactable_tokens: 8000, max_compactions_per_mission: 3 };

  it('fires above the threshold', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 60000, accumulatedChars: 200000, compactionsSoFar: 0, cfg }).compact, true);
  });
  it('declines below the threshold', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 20000, accumulatedChars: 40000, compactionsSoFar: 0, cfg }).compact, false);
  });
  it('uses the chars/4 proxy when real tokens are absent', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 0, accumulatedChars: 60000 * 4, compactionsSoFar: 0, cfg }).compact, true);
  });
  it('respects max_compactions and the disabled flag', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 90000, accumulatedChars: 400000, compactionsSoFar: 3, cfg }).reason, 'max_compactions');
    assert.equal(shouldCompact({ lastRealPromptTokens: 90000, accumulatedChars: 400000, compactionsSoFar: 0, cfg: { ...cfg, enabled: false } }).reason, 'disabled');
  });
  it('declines when the accumulated context itself is small', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 90000, accumulatedChars: 1000, compactionsSoFar: 0, cfg }).reason, 'below_min');
  });
});

describe('splitIterationBlocks / spliceCompacted pinning', () => {
  const acc = ['MISSION HEAD framing',
    '--- Iteration 1 ---\nwork one',
    '--- Iteration 2 ---\nwork two',
    '--- Iteration 3 ---\nwork three',
    '--- Iteration 4 ---\nwork four'].join('\n\n');

  it('splits head from iteration blocks', () => {
    const { head, blocks } = splitIterationBlocks(acc);
    assert.equal(head, 'MISSION HEAD framing');
    assert.equal(blocks.length, 4);
  });

  it('splice keeps criteria verbatim and digest survives a re-split (pinned)', () => {
    const digest = {
      covered_iterations: '1..2',
      decisions: [{ iteration: 1, action: 'checkpoint_plan', target: 'motor', outcome: 'done' }],
      claims: [{ text: 'report built', bin: 'verified', source: 'step 1.1' }],
      open_questions: ['totals unconfirmed'],
      artifacts: [], durable_learnings: ['gmail auth expires fast'],
    };
    const { head, blocks } = splitIterationBlocks(acc);
    const criteria = 'Totals MUST match the ledger exactly.';
    const out = spliceCompacted({ head, keptBlocks: blocks.slice(-2), digest, seq: 1, instruction: 'Build the report', acceptCriteria: criteria });
    assert.ok(out.includes('[CONTEXT COMPACTED — seq 1'));
    assert.ok(out.includes(criteria));
    assert.ok(out.includes('work three') && out.includes('work four'));
    assert.ok(!out.includes('work one'));
    // Pinning: a second split folds the digest into the head, so later
    // compactions and the fallback prune can never evict it.
    const again = splitIterationBlocks(out);
    assert.ok(again.head.includes('[CONTEXT COMPACTED — seq 1'));
    assert.equal(again.blocks.length, 2);
  });
});

describe('validateMissionDigest (B-29 bins mandatory)', () => {
  it('accepts a well-formed digest', () => {
    assert.equal(validateMissionDigest({ decisions: [], claims: [{ text: 'x', bin: 'assumed' }], open_questions: [] }).valid, true);
  });
  it('rejects missing bins and the wrap-as-synthesize shape', () => {
    assert.equal(validateMissionDigest({ decisions: [], claims: [{ text: 'x' }], open_questions: [] }).valid, false);
    assert.equal(validateMissionDigest({ action: 'synthesize', summary: 'narrative' }).valid, false);
  });
});

describe('redactSecrets (C-8)', () => {
  it('scrubs token shapes', () => {
    const dirty = 'a ya29.AbCdEf-123 b AIzaSyA12345678901234567890123456789012 c ghp_abcdefghijklmnopqrstu d Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjEi';
    const clean = redactSecrets(dirty);
    assert.ok(!clean.includes('ya29.A'));
    assert.ok(!clean.includes('AIzaSy'));
    assert.ok(!clean.includes('ghp_'));
    assert.ok(!clean.includes('eyJhbGciOiJSUzI1NiIsImtpZCI6IjEi'));
  });
});
