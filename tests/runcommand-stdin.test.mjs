// tests/runcommand-stdin.test.mjs — the exec tool's stdin channel is shell-safe for free text.
// Regression for the project-manage team-add "Unterminated quoted string" break: free text with
// apostrophes/quotes/$ must reach a command via stdin WITHOUT being parsed by the shell.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Skip the metadata token fetch + give the child a valid cwd, so the tool runs off-VM.
process.env.FIREBASE_TOKEN = 'test-skip-metadata';
process.env.WORKSPACE = process.cwd();

const { runCommand } = await import('../corekit/brain/tools.mjs');

const ECHO = join(tmpdir(), 'ap-echo-stdin.cjs');   // echoes stdin → stdout
const PRINT = join(tmpdir(), 'ap-print.cjs');        // prints without reading stdin

describe('runCommand stdin channel (shell-free free text)', () => {
  before(() => {
    writeFileSync(ECHO, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d));");
    writeFileSync(PRINT, "process.stdout.write('NOSTDIN_OK');");
  });
  after(() => { try { rmSync(ECHO); } catch {} try { rmSync(PRINT); } catch {} });

  it('passes apostrophes, double quotes, and $-refs through untouched', async () => {
    const original = `Implements the website's "technical" features & $HOME`;
    const payload = JSON.stringify({ responsibilities: original });
    const r = await runCommand.execute({ command: `node "${ECHO}"`, stdin: payload });
    assert.equal(r.error, undefined, `unexpected error: ${r.error}`);
    // The JSON echoed back must parse (the shell never mangled it) and reconstruct the exact
    // string — apostrophe, literal double-quotes, and an un-expanded $-ref all intact.
    const parsed = JSON.parse(r.result.slice(r.result.indexOf('{')));
    assert.equal(parsed.responsibilities, original, 'free text round-tripped byte-for-byte');
    assert.ok(parsed.responsibilities.includes("website's"), 'apostrophe survived');
    assert.ok(parsed.responsibilities.includes('"technical"'), 'double quotes survived');
    assert.ok(parsed.responsibilities.includes('$HOME'), '$-ref reached the program literally (not shell-expanded)');
  });

  it('leaves the no-stdin path unchanged', async () => {
    const r = await runCommand.execute({ command: `node "${PRINT}"` });
    assert.equal(r.error, undefined, `unexpected error: ${r.error}`);
    assert.ok(r.result.includes('NOSTDIN_OK'));
  });
});
