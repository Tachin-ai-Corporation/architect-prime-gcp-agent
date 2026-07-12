// tests/session-store.test.mjs — pure-core tests for the gateway session store (B-19)
// SESSION_CONTEXT_PLAN Phase 5. context.mjs reads contracts at import; these
// exercise the in-memory store semantics that the daemon-authored protocol relies on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  openSession, continueSession, appendTurn, resetSession, closeSession, listSessions,
  hashSystem, estimateTokens,
} from '../corekit/brain/context.mjs';

describe('hashSystem / estimateTokens', () => {
  it('hash is stable and content-keyed', () => {
    assert.equal(hashSystem('abc'), hashSystem('abc'));
    assert.notEqual(hashSystem('abc'), hashSystem('abd'));
  });
  it('estimateTokens is chars/4 over message contents', () => {
    assert.equal(estimateTokens([{ role: 'user', content: 'x'.repeat(40) }]), 10);
  });
});

describe('open / continue / append (daemon-authored)', () => {
  it('open stores messages at seq 0; continue hits on matching identity', () => {
    const id = 't-open-' + Math.floor(1);
    openSession({ id, agentId: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'open payload' }] });
    const hit = continueSession({ id, agentId: 'cortex', systemHash: 'h1', expectedSeq: 0 });
    assert.ok(hit.session);
    assert.equal(hit.session.seq, 0);
    closeSession(id);
  });

  it('appendTurn stores the daemon delta and advances seq', () => {
    const id = 't-append';
    openSession({ id, agentId: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'open' }] });
    const s = appendTurn(id, [{ role: 'assistant', content: '{"action":"synthesize"}' }, { role: 'user', content: 'delta-2' }], 1234);
    assert.equal(s.seq, 1);
    assert.equal(s.messages.length, 3); // open + 2 delta
    assert.equal(s.lastRealPromptTokens, 1234);
    closeSession(id);
  });

  it('continue MISSES fail-closed by reason, never throw', () => {
    const id = 't-miss';
    openSession({ id, agentId: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(continueSession({ id, agentId: 'cortex', systemHash: 'h1', expectedSeq: 9 }).miss, 'seq');
    assert.equal(continueSession({ id, agentId: 'motor', systemHash: 'h1', expectedSeq: 0 }).miss, 'agent');
    assert.equal(continueSession({ id, agentId: 'cortex', systemHash: 'DIFFERENT', expectedSeq: 0 }).miss, 'system_hash');
    assert.equal(continueSession({ id: 'nope', agentId: 'cortex', systemHash: 'h1', expectedSeq: 0 }).miss, 'absent');
    closeSession(id);
  });

  it('caps oversized user/tool content but leaves content-parts arrays intact', () => {
    const id = 't-cap';
    openSession({ id, agentId: 'cortex', systemHash: 'h1', messages: [] });
    const big = 'y'.repeat(50_000);
    const s = appendTurn(id, [
      { role: 'user', content: big },
      { role: 'assistant', content: [{ type: 'text', text: 'partsblock' }] },
    ]);
    const userTurn = s.messages.find(m => m.role === 'user');
    const asstTurn = s.messages.find(m => m.role === 'assistant');
    assert.ok(userTurn.content.length < 50_000, 'user content capped');
    assert.ok(Array.isArray(asstTurn.content), 'array content untouched');
    closeSession(id);
  });

  it('reset replaces messages but preserves seq; close is idempotent', () => {
    const id = 't-reset';
    openSession({ id, agentId: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'a' }] });
    appendTurn(id, [{ role: 'assistant', content: 'b' }]);
    const r = resetSession({ id, agentId: 'cortex', systemHash: 'h2', messages: [{ role: 'user', content: 'fresh' }] });
    assert.equal(r.seq, 1);           // seq preserved across reset
    assert.equal(r.messages.length, 1); // messages replaced
    assert.equal(closeSession(id), true);
    assert.equal(closeSession(id), false); // idempotent
  });

  it('listSessions exposes counters/metadata, never content', () => {
    const id = 't-list';
    openSession({ id, agentId: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'hello world' }] });
    const entry = listSessions().find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.agentId, 'cortex');
    assert.ok(typeof entry.est_tokens === 'number');
    assert.ok(!('messages' in entry) && !('content' in entry));
    closeSession(id);
  });
});
