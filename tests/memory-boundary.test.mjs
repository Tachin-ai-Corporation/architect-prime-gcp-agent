// tests/memory-boundary.test.mjs — memory is a closed set, and the fence is structural.
//
// BRAIN_CANON B-5: memory is exactly three layers — working memory (MEMORY.md), Core Memory and the
// Deep Truths region — and the memory system writes nothing else. Processes, projects, skills and
// responsibilities are READ, never written. Found live 2026-09-24, all three at once: a tooled
// temporal-memory held a full shell (allowedTools null) and a consolidation pass wrote project context
// through project-manage; a post-mission reflex REPLACED playbook narratives and wrote project notes;
// and the organ's own SOUL told it to "refresh" both.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MEMORY_CLIS, MEMORY_READ_VIEWS, MEMORY_FILES,
  splitCommandLine, checkMemoryCommand, memoryFileTarget, getFilteredTools, writeMemoryFile,
} from '../corekit/brain/tools.mjs';
import { isMemoryScoped, fenceMemoryTask } from '../platform/work/memory-scope.mjs';
import { createScheduler } from '../platform/work/scheduler.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(repo, p), 'utf8');
const BIN = '/opt/corekit/bin';
const sorted = (a) => [...a].sort();

// ── One list, held three ways ─────────────────────────────────────────────────

describe('the memory CLI set is one list, held three ways', () => {
  it('MEMORY_CLIS is exactly the scripts of the skills temporal-memory owns (B-17)', () => {
    const owned = new Set();
    for (const d of readdirSync(join(repo, 'skills'), { withFileTypes: true })) {
      const f = join(repo, 'skills', d.name, 'skill.json');
      if (!d.isDirectory() || !existsSync(f)) continue;
      const s = JSON.parse(readFileSync(f, 'utf8'));
      if (s.agent_part === 'temporal-memory') for (const x of s.scripts || []) owned.add(x);
    }
    assert.deepEqual(sorted(MEMORY_CLIS), sorted(owned));
  });

  it('and exactly the CLIs in corekit/memory/ — process-ops (a definition tool) moved out', () => {
    assert.deepEqual(sorted(readdirSync(join(repo, 'corekit', 'memory'))), sorted(MEMORY_CLIS));
    assert.ok(existsSync(join(repo, 'corekit', 'brain', 'process-ops')), 'process-ops lives with the other definition CLIs');
  });

  it('process-ops stays motor-owned and is installed from its new home', () => {
    assert.equal(JSON.parse(read('skills/process-ops/skill.json')).agent_part, 'motor');
    for (const m of ['infra/manifests/role-fleet.txt', 'infra/manifests/role-prime.txt']) {
      assert.match(read(m), /^corekit\/brain\/process-ops bin\/process-ops$/m, m);
      assert.doesNotMatch(read(m), /corekit\/memory\/process-ops/, m);
    }
  });
});

// ── memoryCommand: memory CLIs only, no shell ─────────────────────────────────

describe('splitCommandLine — argv without a shell', () => {
  it('groups quotes and expands nothing', () => {
    assert.deepEqual(
      splitCommandLine(`core-memory-write --fact 'drive_folder: "weekly_exec_notes_root" = 1OYwJJ' --category resources`),
      ['core-memory-write', '--fact', 'drive_folder: "weekly_exec_notes_root" = 1OYwJJ', '--category', 'resources']);
    assert.deepEqual(splitCommandLine('core-memory-retire --id mem-1 --reason "dup of \\"a\\""'),
      ['core-memory-retire', '--id', 'mem-1', '--reason', 'dup of "a"']);
    assert.deepEqual(splitCommandLine('core-memory-write --fact "a; b | c $(x)"'),
      ['core-memory-write', '--fact', 'a; b | c $(x)'], 'operators inside quotes are literal text');
  });
  it('refuses an unquoted shell operator — that is an attempt to run something else', () => {
    for (const bad of [
      'core-memory-read; rm -rf /', 'core-memory-read && project-manage update p', 'core-memory-read | tee x',
      'core-memory-read > /tmp/x', 'core-memory-read $(whoami)', 'core-memory-read `id`', 'core-memory-read & sleep 9',
    ]) {
      assert.throws(() => splitCommandLine(bad), /shell operator/, bad);
    }
    assert.throws(() => splitCommandLine('core-memory-read --query "open'), /unterminated/);
  });
});

describe('checkMemoryCommand — what the memory authority may run', () => {
  it('allows every memory CLI, by name or by its installed path', () => {
    for (const c of MEMORY_CLIS) {
      assert.deepEqual(checkMemoryCommand([c, '--limit', '5'], BIN), { ok: true, name: c, path: `${BIN}/${c}` });
    }
    assert.equal(checkMemoryCommand([`${BIN}/core-memory-read`], BIN).ok, true);
  });
  it('allows the read-only definition views, and refuses every write of a definition', () => {
    for (const [cli, reads] of Object.entries(MEMORY_READ_VIEWS)) {
      for (const sub of reads) assert.equal(checkMemoryCommand([cli, sub, 'x'], BIN).ok, true, `${cli} ${sub}`);
    }
    for (const [cli, sub] of [
      ['process-ops', 'write'], ['process-ops', 'retire'], ['process-ops', undefined],
      ['project-manage', 'add-context'], ['project-manage', 'update'], ['project-manage', 'create'],
      ['project-manage', 'canon-set'], ['project-manage', 'team-add'], ['project-manage', 'add-process'],
    ]) {
      const r = checkMemoryCommand([cli, sub].filter(Boolean), BIN);
      assert.equal(r.ok, false, `${cli} ${sub}`);
      assert.match(r.reason, /read-only view|never written/, `${cli} ${sub}`);
    }
  });
  it('refuses everything else — memory reaches nothing but memory', () => {
    for (const cmd of ['rm', 'bash', 'curl', 'python3', 'docs-create', 'drive-delete', 'responsibility-manage', 'git']) {
      const r = checkMemoryCommand([cmd, 'x'], BIN);
      assert.equal(r.ok, false, cmd);
      assert.match(r.reason, /not a memory command/, cmd);
    }
    assert.equal(checkMemoryCommand(['/tmp/core-memory-read'], BIN).ok, false, 'a look-alike path is not the installed CLI');
    assert.equal(checkMemoryCommand(['../bin/core-memory-read'], BIN).ok, false);
    assert.equal(checkMemoryCommand([], BIN).ok, false);
  });
});

// ── writeMemoryFile: the memory files only ────────────────────────────────────

describe('writeMemoryFile writes only the memory files', () => {
  const home = join(tmpdir(), 'mem-home-probe');
  it('resolves exactly MEMORY.md and the consolidation report in the memory home', () => {
    for (const f of MEMORY_FILES) assert.ok(memoryFileTarget(f, home), f);
    assert.ok(memoryFileTarget(join(home, 'MEMORY.md'), home), 'absolute form');
    for (const bad of ['SOUL.md', 'IDENTITY.md', 'sub/MEMORY.md', '../workspace-motor/MEMORY.md', '/etc/passwd',
      join(home, '..', 'MEMORY.md'), 'processes.json', '']) {
      assert.equal(memoryFileTarget(bad, home), null, bad || '(empty)');
    }
  });

  it('writes working memory, refuses any other file, and bounds a runaway rewrite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-home-'));
    const prev = process.env.MEMORY_HOME;
    process.env.MEMORY_HOME = dir;
    try {
      const ok = await writeMemoryFile.execute({ path: 'MEMORY.md', content: '# MEMORY\n- one active item\n' });
      assert.match(ok.result, /Written \d+ chars to MEMORY\.md/);
      assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '# MEMORY\n- one active item\n');
      const refused = await writeMemoryFile.execute({ path: 'SOUL.md', content: 'x' });
      assert.match(refused.error, /REFUSED \(memory boundary\)/);
      assert.equal(existsSync(join(dir, 'SOUL.md')), false);
      const flood = await writeMemoryFile.execute({ path: 'MEMORY.md', content: 'y'.repeat(9_000) });
      assert.match(flood.error, /hard cap/);
      const over = await writeMemoryFile.execute({ path: 'MEMORY.md', content: 'z'.repeat(2_500) });
      assert.match(over.result, /over the 2000-char target/);
    } finally {
      if (prev === undefined) delete process.env.MEMORY_HOME; else process.env.MEMORY_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The gateway: temporal-memory holds only the memory toolset ─────────────────

describe('the gateway hands a consolidating temporal-memory only memory tools', () => {
  it('tooled → exactly MEMORY_TOOLSET (no shell, no general writer); recall → no tools; not overridable', async () => {
    // A fresh module instance over a workspace whose config.json tries to WIDEN the fence.
    const base = mkdtempSync(join(tmpdir(), 'gw-'));
    mkdirSync(join(base, 'workspace-temporal-memory'), { recursive: true });
    writeFileSync(join(base, 'workspace-temporal-memory', 'config.json'), JSON.stringify({ allowedTools: ['runCommand', 'writeFile'] }));
    const prev = process.env.WORKSPACE_BASE;
    process.env.WORKSPACE_BASE = base;
    try {
      const url = pathToFileURL(join(repo, 'corekit', 'brain', 'config.mjs')).href + `?probe=${Date.now()}`;
      const { loadAgentConfig, MEMORY_TOOLSET } = await import(url);
      assert.deepEqual(MEMORY_TOOLSET, ['readFile', 'listDir', 'memoryCommand', 'writeMemoryFile']);
      const tooled = loadAgentConfig('temporal-memory', { exec: true }).allowedTools;
      assert.deepEqual(tooled, [...MEMORY_TOOLSET], 'a workspace config.json must not widen the memory fence');
      assert.ok(!tooled.includes('runCommand') && !tooled.includes('writeFile'));
      assert.deepEqual(loadAgentConfig('temporal-memory', {}).allowedTools, [], 'recall stays toolless (C-5)');
      assert.deepEqual(Object.keys(getFilteredTools(tooled)), [...MEMORY_TOOLSET], 'every name resolves to a real tool');
      assert.equal(loadAgentConfig('motor', {}).allowedTools, null, "motor's toolset is unchanged");
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_BASE; else process.env.WORKSPACE_BASE = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("an unrestricted organ's open set does not grow the memory tools", () => {
    const open = Object.keys(getFilteredTools(null));
    assert.ok(open.includes('runCommand') && open.includes('writeFile'));
    assert.ok(!open.includes('memoryCommand') && !open.includes('writeMemoryFile'));
  });
});

// ── The mission fence ─────────────────────────────────────────────────────────

describe('a memory-scoped mission dispatches no other hand', () => {
  it('recognizes the scope stamp', () => {
    assert.equal(isMemoryScoped({ source_meta: { effect_scope: 'memory' } }), true);
    assert.equal(isMemoryScoped({ source_meta: { effect_scope: 'world' } }), false);
    assert.equal(isMemoryScoped({}), false);
    assert.equal(isMemoryScoped(null), false);
  });

  it('allows the memory organs, reroutes motor to temporal-memory, refuses delegation and gates', () => {
    assert.deepEqual(fenceMemoryTask({ stepType: 'standard', taskAgent: 'temporal-memory' }), { action: 'allow' });
    assert.deepEqual(fenceMemoryTask({ stepType: 'standard', taskAgent: 'temporal-research' }), { action: 'allow' });
    for (const agent of ['motor', undefined]) {
      const f = fenceMemoryTask({ stepType: 'standard', taskAgent: agent });
      assert.equal(f.action, 'reroute');
      assert.equal(f.agent, 'temporal-memory');
    }
    for (const stepType of ['delegation', 'approval_gate', 'something_new']) {
      assert.equal(fenceMemoryTask({ stepType, taskAgent: 'motor' }).action, 'refuse', stepType);
    }
  });

  it('is consulted before the WS-2 reroute, so a memory mission can never become a delegation', () => {
    const src = read('platform/work/checkpoint-executor.mjs');
    const fence = src.indexOf('if (isMemoryScoped(envelope))');
    const ws2 = src.indexOf('// WS-2: route specialty-owned execution');
    assert.ok(fence > 0 && ws2 > 0 && fence < ws2, 'the memory fence runs before the WS-2 delegation reroute');
  });

  it('the nightly consolidation declares itself memory-scoped', () => {
    const r = JSON.parse(read('corekit/config/responsibilities.json')).responsibilities.find((x) => x.id === 'r-memory-consolidation');
    assert.equal(r.effect_scope, 'memory');
  });
});

describe('the scheduler stamps the scope onto what it fires', () => {
  const fire = async (resp) => {
    const root = mkdtempSync(join(tmpdir(), 'sched-scope-'));
    mkdirSync(join(root, 'corekit'), { recursive: true });
    writeFileSync(join(root, 'corekit', 'responsibilities.json'), JSON.stringify({ version: 2, responsibilities: [resp] }));
    const written = [];
    let n = 0;
    const s = createScheduler({
      config: { coreDir: root, agentId: 'probe' }, logger: () => {},
      generateId: (p) => `${p}-${++n}`, writeHistory: async () => {}, recallMemory: async () => ({}),
      processEnvelope: async () => {}, getDefaultProjectId: () => null,
      firestoreWrite: async (col, _id, doc) => { if (col === 'work') written.push(JSON.parse(JSON.stringify(doc))); },
    });
    try {
      s.loadResponsibilities();
      s.start(new Date('2026-09-24T07:00:00Z'));
      s.stop();
      await s.tick(new Date('2026-09-24T08:00:20Z'));
    } finally { rmSync(root, { recursive: true, force: true }); }
    return { R: written.find((d) => d.type === 'R'), M: written.find((d) => d.type === 'M') };
  };

  it('a memory responsibility → effect_scope on both R and M, and the planner is told', async () => {
    const { R, M } = await fire({ id: 'r-mem', name: 'Mem', schedule: '0 8 * * *', enabled: true, effect_scope: 'memory', instruction: 'Consolidate.' });
    assert.equal(R?.source_meta?.effect_scope, 'memory');
    assert.equal(M?.source_meta?.effect_scope, 'memory');
    assert.match(M.context_summary, /EFFECT SCOPE: memory/);
  });

  it('a world responsibility carries no scope', async () => {
    const { M } = await fire({ id: 'r-w', name: 'W', schedule: '0 8 * * *', enabled: true, instruction: 'Do work.' });
    assert.ok(M, 'fired');
    assert.equal('effect_scope' in (M.source_meta || {}), false);
    assert.doesNotMatch(M.context_summary || '', /EFFECT SCOPE/);
  });
});

// ── No memory path writes a definition ────────────────────────────────────────

describe('no memory path writes a definition', () => {
  const brain = read('platform/runtime/agent-brain.mjs');
  const body = (from, to) => {
    const a = brain.indexOf(from);
    const b = brain.indexOf(to, a + from.length);
    assert.ok(a > 0 && b > a, `found ${from}`);
    return brain.slice(a, b);
  };

  it('the lesson reflex appends to working memory and writes neither projects nor processes', () => {
    const reflex = body('async function recordMissionLessons', '// ---- completeEnvelope');
    assert.doesNotMatch(reflex, /firestoreWrite\(\s*'(projects|processes)'/);
    assert.match(reflex, /appendWorkingMemory\(lessonLine\(\{ scope: 'project'/);
    assert.match(reflex, /appendWorkingMemory\(lessonLine\(\{ scope: 'playbook'/);
    assert.match(reflex, /if \(isMemoryScoped\(mission\)\) return;/, 'a memory mission is not asked for lessons about itself');
  });

  it('the old write shapes are gone from the daemon', () => {
    assert.doesNotMatch(brain, /auto_maintenance\s*=/, 'the project-context note');
    assert.doesNotMatch(brain, /updated_by: 'temporal-memory'/, 'the playbook narrative replacement');
  });

  it("temporal-memory's firmware reads definitions and never writes them", () => {
    for (const f of ['platform/organ-firmware/fleet/_brain/temporal-memory/SOUL.md', 'platform/organ-firmware/prime/temporal-memory/SOUL.md']) {
      const soul = read(f);
      assert.doesNotMatch(soul, /Context Stewardship|tightening a narrative|shared playbook library and each project's/i, f);
      assert.match(soul, /only places I write/, f);
      assert.match(soul, /I read definitions — processes, projects, skills, responsibilities — and never write them/, f);
    }
  });

  it('the consolidation skill and responsibility hand out only the memory tools', () => {
    const skill = read('skills/memory-consolidate/SKILL.md');
    assert.doesNotMatch(skill, /`runCommand`|`writeFile`/, 'no shell, no general file writer');
    assert.match(skill, /memoryCommand/);
    assert.match(skill, /writeMemoryFile/);
    const r = JSON.parse(read('corekit/config/responsibilities.json')).responsibilities.find((x) => x.id === 'r-memory-consolidation');
    const text = JSON.stringify(r);
    assert.doesNotMatch(text, /exec tool/, 'the consolidation holds no exec tool to use');
    assert.match(text, /READ THE DEFINITIONS \(read-only\)/);
  });
});
