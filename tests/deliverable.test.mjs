// tests/deliverable.test.mjs — Unit tests for mission deliverable composition
//
// Run: node --test tests/deliverable.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  composeDeliverable,
  composeFallbackSummary,
  isEmptyDeliverable,
  stripArtifactFooter,
} from '../platform/work/deliverable.mjs';

const ARTIFACT_LINE = '\n\n📎 Artifacts: repo@main a1b2c3d4 — 5 file(s)';

// ── stripArtifactFooter ─────────────────────────────────────────────

describe('stripArtifactFooter', () => {
  it('removes the artifact footer', () => {
    assert.strictEqual(stripArtifactFooter('Real summary.' + ARTIFACT_LINE), 'Real summary.');
  });
  it('leaves footer-free text untouched', () => {
    assert.strictEqual(stripArtifactFooter('Just a summary.'), 'Just a summary.');
  });
  it('reduces an artifact-only body to empty', () => {
    assert.strictEqual(stripArtifactFooter(ARTIFACT_LINE), '');
  });
  it('handles null/undefined', () => {
    assert.strictEqual(stripArtifactFooter(null), '');
    assert.strictEqual(stripArtifactFooter(undefined), '');
  });
});

// ── isEmptyDeliverable ──────────────────────────────────────────────

describe('isEmptyDeliverable', () => {
  it('is true for empty, whitespace, and artifact-only bodies', () => {
    assert.ok(isEmptyDeliverable(''));
    assert.ok(isEmptyDeliverable('   \n  '));
    assert.ok(isEmptyDeliverable(ARTIFACT_LINE));
  });
  it('is false for a real summary', () => {
    assert.ok(!isEmptyDeliverable('The deployment completed successfully on us-central1.'));
  });
});

// ── composeFallbackSummary ──────────────────────────────────────────

describe('composeFallbackSummary', () => {
  it('never returns empty, even with a bare envelope', () => {
    const out = composeFallbackSummary({ status: 'complete' });
    assert.ok(out.length > 0);
  });

  it('leads with an outcome headline scaled to status', () => {
    const blocked = composeFallbackSummary({ status: 'blocked', title: 'Investigate Millie work history' });
    assert.match(blocked, /^Blocked:/);
  });

  it('surfaces the blocker', () => {
    const out = composeFallbackSummary({ status: 'blocked', blocker: 'agent-brain crash-looping (missing module)' });
    assert.match(out, /crash-looping/);
  });

  it('distills findings from prior results, marking success and failure', () => {
    const out = composeFallbackSummary(
      { status: 'failed', title: 'Assess Millie' },
      { priorResults: [
        { agent: 'motor', success: false, result: 'gcloud logging read returned no output' },
        { agent: 'system', result: 'ignored' },
        { agent: 'temporal-memory', success: true, result: 'No prior work found for millie' },
      ] },
    );
    assert.match(out, /✗ motor/);
    assert.match(out, /✓ temporal-memory/);
    assert.ok(!out.includes('ignored'), 'system entries are excluded');
  });
});

// ── composeDeliverable ──────────────────────────────────────────────

describe('composeDeliverable', () => {
  it('uses a real synthesis verbatim (composed=false)', () => {
    const synthesis = 'Deployed the analytics service; smoke tests green.';
    const { body, composed } = composeDeliverable({ status: 'complete' }, { synthesis });
    assert.strictEqual(composed, false);
    assert.strictEqual(body, synthesis);
  });

  it('composes a floor summary when synthesis is empty (composed=true)', () => {
    const { body, composed } = composeDeliverable(
      { status: 'blocked', title: 'Investigate Millie', blocker: 'brain dead' },
      { synthesis: '', priorResults: [{ agent: 'motor', success: false, result: 'no data' }] },
    );
    assert.strictEqual(composed, true);
    assert.ok(body.length > 0);
    assert.match(body, /Blocked:/);
  });

  it('treats an artifact-only synthesis as empty and composes a summary', () => {
    const { body, composed } = composeDeliverable({ status: 'complete', title: 'x' }, { synthesis: ARTIFACT_LINE });
    assert.strictEqual(composed, true);
    assert.ok(stripArtifactFooter(body).length > 0, 'body has a real summary, not just the footer');
  });

  it('places the artifact footer UNDER the summary, never as the whole body', () => {
    const footer = '📎 Artifacts: repo@main abc — 2 file(s)';
    const { body } = composeDeliverable({ status: 'complete' }, {
      synthesis: 'All done.',
      artifactFooter: footer,
    });
    assert.ok(body.startsWith('All done.'), 'summary leads');
    assert.ok(body.endsWith(footer), 'artifacts follow');
  });

  it('respects a custom minChars threshold', () => {
    const short = 'ok';
    const loose = composeDeliverable({ status: 'complete' }, { synthesis: short, minChars: 1 });
    assert.strictEqual(loose.composed, false, 'short synthesis passes a low threshold');
    const strict = composeDeliverable({ status: 'complete' }, { synthesis: short, minChars: 40 });
    assert.strictEqual(strict.composed, true, 'short synthesis fails a high threshold');
  });
});
