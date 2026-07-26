// tests/verdict-evidence.test.mjs — "I could not see it" is not "it is wrong" (B-28)
//
// The fixture below is the ACTUAL verdict text that reported a finished mission as blocked.
// Three compensation addendums had been correctly edited. The verifier was handed 2,833 chars
// of evidence for all three documents, PASSED the first clause outright, then failed the
// second because one document's content was "not fully visible in the provided transcript".
// That FAIL entered prior_results as success:false, the synthesize guard read it as an
// unresolved hard failure and rejected the synthesis cortex had correctly chosen, and the
// mission exited as `blocked` with three finished documents inside it.
//
// Every guard in that chain was working as designed. The input was a lie. This detector is
// what makes the lie detectable, so the whole class turns on the separation asserted here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingEvidenceFail } from '../corekit/lib/verdict.mjs';

// Verbatim, from mission w-1785103256254-935eda69 CP2.
const REAL_VERDICT = "The `ops.json` content for Marnie B's addendum is not fully visible in "
  + 'the provided transcript.';

describe('isMissingEvidenceFail — the verifier could not SEE the work', () => {
  it('catches the exact verdict that blocked a finished mission', () => {
    assert.equal(isMissingEvidenceFail(REAL_VERDICT), true);
  });

  it('catches the other ways a verifier reports a clipped view', () => {
    for (const s of [
      'Kaeryn B\'s ops.json is not visible in the provided output.',
      'The combined task outputs were truncated, so the content could not be confirmed.',
      'The full document text is not included in the provided evidence.',
      'Evidence for the third document is missing.',
      'Insufficient evidence was provided to confirm the replacements.',
      'I cannot verify the final content because the transcript is truncated.',
      'The tool log was cut off before the final status line.',
    ]) {
      assert.equal(isMissingEvidenceFail(s), true, `should read as an evidence shortfall: ${s}`);
    }
  });
});

describe('isMissingEvidenceFail — genuine findings about the WORK must not match', () => {
  // These are the verdicts that MUST keep failing the milestone. A false positive here is
  // far worse than a false negative: it would let real defects through as "inconclusive".
  it('leaves real defects alone', () => {
    for (const s of [
      'The document is missing a signature block.',
      "Sarah K's addendum does not include the expense note.",
      'The monthly rate is wrong: it shows $2,500 where $7,500 was specified.',
      'The address field was populated instead of being left blank.',
      'Only two of the three addendums were created.',
      'The responsibilities section is empty.',
      'The template placeholders were never replaced.',
      'The draft is not present in the In Progress folder.',
      'The doc was created from the wrong master template.',
      'criterion 3 (personal details extracted) failed: the source is a PDF and no conversion was attempted',
    ]) {
      assert.equal(isMissingEvidenceFail(s), false, `must stay a work failure: ${s}`);
    }
  });

  // The word "missing" appears in both families, so it cannot be the discriminator on its own.
  it('separates a missing ARTIFACT from missing EVIDENCE', () => {
    assert.equal(isMissingEvidenceFail('The signature block is missing from the document.'), false);
    assert.equal(isMissingEvidenceFail('Evidence for that criterion is missing.'), true);
  });
});

describe('isMissingEvidenceFail — never throws', () => {
  it('treats every malformed input as a work failure, not an evidence shortfall', () => {
    // Failing CLOSED on garbage is the safe direction: an unparseable reason must not be
    // silently downgraded to inconclusive.
    for (const bad of ['', null, undefined, 42, {}, [], NaN, () => {}]) {
      assert.equal(isMissingEvidenceFail(bad), false);
    }
  });
});
