// tests/compaction.test.mjs — pure-core tests for corekit/lib/compaction.mjs (B-19)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stepCheckpointNum, renderCheckpointDigest, buildPriorWorkContext } from '../corekit/lib/compaction.mjs';

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
