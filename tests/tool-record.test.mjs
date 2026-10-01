// tests/tool-record.test.mjs — the record of a tool call is ground truth (B-28).
//
// 2026-10-01: Millie's weekly exec update produced a correct briefing and was marked
// BLOCKED. The gateway's [TOOL EXECUTION LOG] kept the first 500 characters of every tool
// result, silently, so the verifier saw her 1,826-char read-back cut after the agenda,
// could not find "Decisions to Lock" or the action table, re-checked on "complete
// evidence" built from the same cut log, and the mission blocked on three replans. These
// tests pin the replacement: kept whole up to tools.record.verbatim_chars; above it, the
// full result stored and a utility-model digest + ref in the log; never cut silently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildToolLog, completeToolLog, expandToolResults, storedResultRefs, recordPolicy, excerpt, digestInstruction,
  DEFAULT_RECORD_POLICY, TOOL_RESULTS_COLLECTION,
} from '../platform/context/tool-record.mjs';
import { packToolEvidence, digestToolResults } from '../platform/work/result-packet.mjs';
import { extractVerdict } from '../platform/work/verdict.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(repo, ...p), 'utf8');
const policy = DEFAULT_RECORD_POLICY;

// The shape of the 2026-10-01 briefing read-back: its later sections sit past char 500.
const briefing = [
  'Weekly Executive Update - 2026-10-01',
  'Agenda-at-a-Glance',
  ...Array.from({ length: 6 }, (_, i) => `Segment ${i + 1}: weekly project updates for the client programs and the platform roadmap`),
  'State of the Week',
  ...Array.from({ length: 5 }, (_, i) => `Area ${i + 1}: discussion of progress, risks and what the team is waiting on this week`),
  'Decisions to Lock',
  'A new pricing model will be rolled out to all payers.',
  'Action Items',
  'Task | Owner | Due | Status',
  'Draft new DSM requirements | Jeremy Walker | not set | Not Started',
].join('\n');
const motorOutput = (log) => `Read the finished document back; every section has content.\n\n---\n[TOOL EXECUTION LOG]\n${log}\n[END TOOL LOG]`;

describe('the gateway keeps the record whole up to the contract bound', () => {
  it('the 2026-10-01 read-back reaches the verifier with every section', () => {
    assert.ok(briefing.length > 900 && briefing.indexOf('Decisions to Lock') > 500, 'the fixture reproduces the failure');
    const { log, large } = buildToolLog([{ toolName: 'runCommand', args: { command: 'docs-cat 1ILSt' }, result: briefing }], policy);
    assert.deepEqual(large, [], 'under verbatim_chars: no digest, no store, no model call');
    const evidence = packToolEvidence([{ step: 'T1', agent: 'motor', output: motorOutput(log) }], 6802);
    for (const h of ['Agenda-at-a-Glance', 'State of the Week', 'Decisions to Lock', 'Action Items', 'Jeremy Walker']) {
      assert.ok(evidence.includes(h), `the verifier's evidence holds "${h}"`);
    }
    // Counterfactual: the old record cut every result at 500 chars.
    const old = `[TOOL] runCommand({"command":"docs-cat 1ILSt"}) → ${briefing.substring(0, 500)}`;
    const oldEvidence = packToolEvidence([{ step: 'T1', agent: 'motor', output: motorOutput(old) }], 6802);
    assert.equal(oldEvidence.includes('Decisions to Lock'), false, 'the old cap is the bug this replaces');
  });

  it('a large result becomes a marked excerpt in the log and a full record for the brain', () => {
    const big = 'row\n'.repeat(5000); // 20,000 chars
    const { log, large } = buildToolLog([{ toolName: 'runCommand', args: { command: 'drive-ls x' }, result: big }], policy);
    assert.equal(large.length, 1);
    assert.equal(large[0].result, big, 'the brain receives the whole result');
    assert.equal(large[0].chars, 20000);
    assert.match(log, /\[large result #0: 20000 chars — excerpt\]/);
    assert.match(log, /\[… 16000 of 20000 chars omitted …\]/, 'the cut is stated, never silent');
    assert.match(log, /\[\/large result #0\]$/);
  });

  it('arguments keep their old bounds; the verdict payload is never marked or broken', () => {
    const { log } = buildToolLog([
      { toolName: 'runCommand', args: { command: 'x'.repeat(500) }, result: 'ok' },
      { toolName: 'report_pass', args: { summary: 'All sections present.' }, result: 'recorded' },
    ], policy);
    assert.match(log, /^\[TOOL\] runCommand\(\{"command":"x{188}…\) → ok$/m, 'ordinary args: 200 chars, marked');
    assert.equal(extractVerdict(motorOutput(log)), 'PASS', 'verdict.mjs still reads the terminal tool');
  });
});

describe('the brain stores the full result and puts a digest + ref in the log', () => {
  const big = Array.from({ length: 900 }, (_, i) => `item ${i}: id-${1000 + i} status ok`).join('\n');
  const built = () => buildToolLog([{ toolName: 'runCommand', args: { command: 'list' }, result: big }], policy);

  it('stores first, then swaps the excerpt for the labelled digest and the ref', async () => {
    const { log, large } = built();
    const order = [];
    const { text, recorded } = await completeToolLog(motorOutput(log), large, {
      policy,
      store: async (rec) => { order.push('store'); assert.equal(rec.result, big); return 'tool_results/tr-1'; },
      digest: async () => { order.push('digest'); return '900 items, id-1000..id-1899, all status ok'; },
    });
    assert.match(text, /\[digest of \d+ chars — full result: tool_results\/tr-1\]\n900 items, id-1000\.\.id-1899, all status ok/);
    assert.doesNotMatch(text, /large result #0/, 'the gateway placeholder is gone');
    assert.deepEqual(recorded, [{ seq: 0, tool: 'runCommand', chars: big.length, ref: 'tool_results/tr-1', digested: true }]);
    assert.ok(order.includes('store') && order.includes('digest'));
  });

  it('a failed digest keeps the excerpt and says so; a failed store says the result was not kept', async () => {
    const { log, large } = built();
    const noDigest = await completeToolLog(motorOutput(log), large, { policy, store: async () => 'tool_results/tr-2', digest: async () => null });
    assert.match(noDigest.text, /\[excerpt of \d+ chars — digest unavailable; full result: tool_results\/tr-2\]\nitem 0:/);
    const noStore = await completeToolLog(motorOutput(log), large, { policy, store: async () => { throw new Error('503'); }, digest: async () => 'digest' });
    assert.match(noStore.text, /\[digest of \d+ chars — full result not stored\]\ndigest/);
  });

  it('a digest longer than the hard cap is cut to it', async () => {
    const { log, large } = built();
    const { text } = await completeToolLog(motorOutput(log), large, { policy, store: async () => 'tool_results/tr-3', digest: async () => 'd'.repeat(9000) });
    assert.ok(!text.includes('d'.repeat(policy.digest_max_chars + 1)));
  });

  it('the digest brief condenses and never interprets', () => {
    const brief = digestInstruction(policy);
    assert.match(brief, /Copy exactly every identifier/);
    assert.match(brief, /Never add, infer, judge/);
    assert.match(brief, /at most 3000 characters/);
  });
});

describe('the verifier and Cortex can reach the full result by ref', () => {
  it('expandToolResults restores stored results within the budget, smallest first', async () => {
    const log = [
      '[TOOL] runCommand({}) → [digest of 3000 chars — full result: tool_results/small]\nsmall digest',
      '[TOOL] runCommand({}) → [digest of 50000 chars — full result: tool_results/huge]\nhuge digest',
    ].join('\n');
    const store = { 'tool_results/small': 's'.repeat(3000), 'tool_results/huge': 'h'.repeat(50000) };
    const out = await expandToolResults(motorOutput(log), { read: async (ref) => store[ref], budget: 8000 });
    assert.match(out, /\[full result, 3000 chars — tool_results\/small\]\ns{3000}/);
    assert.match(out, /huge digest/, 'a result that does not fit keeps its digest');
    assert.match(out, /\[END TOOL LOG\]$/, 'the log stays well formed');
  });

  it('storedResultRefs lists each stored result a log points at, in order, once', () => {
    const log = [
      '[TOOL] readFile({}) → [digest of 5336 chars — full result: tool_results/tr-1-readback]',
      'Sections: Sources, Agenda',
      '[TOOL] readFile({}) → [excerpt of 9000 chars — digest unavailable; full result: tool_results/tr-2-template]',
      'excerpt',
      '[TOOL] readFile({}) → [digest of 5336 chars — full result: tool_results/tr-1-readback]',
      'again',
      '[TOOL] docs-cat({}) → a short result, kept whole',
    ].join('\n');
    assert.deepEqual(storedResultRefs(motorOutput(log)), ['tool_results/tr-1-readback', 'tool_results/tr-2-template']);
    assert.deepEqual(storedResultRefs('[digest of 10 chars — full result not stored]\nx'), [], 'an unstored result has no ref');
    assert.deepEqual(storedResultRefs(undefined), []);
  });

  it('an unreadable ref keeps its digest', async () => {
    const log = '[TOOL] x({}) → [digest of 10 chars — full result: tool_results/gone]\nkept';
    const out = await expandToolResults(motorOutput(log), { read: async () => null, budget: 9000 });
    assert.match(out, /kept/);
  });

  it('the brain wires every piece: gateway records out, store + digest in callAgent, refs hydrate', () => {
    const loop = read('corekit', 'brain', 'loop.mjs');
    assert.doesNotMatch(loop, /substring\(0, 500\)/, 'no silent 500-char record');
    assert.equal((loop.match(/buildToolLog\(turnToolCalls, RECORD_POLICY\)/g) || []).length, 2, 'both providers build the record the same way');
    assert.match(read('corekit', 'brain', 'index.mjs'), /tool_records: result\.toolRecords/);
    const brain = read('platform', 'runtime', 'agent-brain.mjs');
    assert.match(brain, /completeToolLog\(content, data\.tool_records/);
    assert.match(brain, /'tool_results',\n\]\);/, 'tool_results is deployment-rooted');
    assert.match(brain, /ref\.startsWith\(`\$\{TOOL_RESULTS_COLLECTION\}\/`\)/, 'Cortex request_context hydrates a tool-result ref');
    assert.match(read('platform', 'work', 'checkpoint-executor.mjs'), /expandToolResults\(toStr\(it\.output\)/, 'the re-check expands refs');
    // Asked for a task's full output, Cortex gets the stored results back in place of their
    // digests — it read a digested read-back as "truncated" and re-planned a passed mission.
    assert.match(brain, /full = await expandToolResults\(full, \{[\s\S]{0,400}?budget: HYDRATE_MAX_CHARS/, 'hydrating a work ref expands its digests');
    assert.equal(TOOL_RESULTS_COLLECTION, 'tool_results');
  });
});

describe('the contract defines the record once', () => {
  it('tools.record carries the approved bounds, and the store expires', () => {
    const c = JSON.parse(read('infra', 'contracts.json'));
    const p = recordPolicy(c);
    assert.equal(p.verbatim_chars, 4000);
    assert.equal(p.digest_target_chars, 3000);
    assert.equal(p.digest_max_chars, 4000);
    assert.equal(p.store_ttl_days, 30);
    assert.equal(p.arg_chars, 200);
    assert.equal(p.terminal_arg_chars, 4000);
    const idx = JSON.parse(read('firestore.indexes.json'));
    assert.ok(idx.fieldOverrides.some((o) => o.collectionGroup === 'tool_results' && o.fieldPath === 'expire_at' && o.ttl === true));
    assert.match(read('infra', 'bootstrap', 'provision-firestore-indexes.sh'), /gcloud firestore fields ttls update/);
  });

  it('excerpt states its cut', () => {
    assert.equal(excerpt('short', 100), 'short');
    assert.match(excerpt('a'.repeat(200), 100), /\[… 100 of 200 chars omitted …\]/);
  });
});

describe('the evidence digester keeps short results whole', () => {
  it('water-fills: a short read-back beside long listings is not cut to an even share', () => {
    const log = [
      `[TOOL] runCommand({}) → ${'L'.repeat(3000)}`,
      `[TOOL] runCommand({}) → ${briefing}`,
      `[TOOL] runCommand({}) → ${'M'.repeat(3000)}`,
      `[TOOL] runCommand({}) → ${'N'.repeat(3000)}`,
    ].join('\n');
    const out = digestToolResults(motorOutput(log), 3000);
    assert.ok(out.includes('Decisions to Lock') && out.includes('Jeremy Walker'), 'the short result keeps every character');
    assert.match(out, /…\[\+\d+ chars\]/, 'the long ones are cut, and the cut is stated');
  });
});
