// corekit/brain/tools.mjs — Direct Vendor SDK Tool Registry
//
// Exposes CoreKit scripts as simplified tool objects for direct vendor SDKs.
// Removes Vercel AI SDK wrappers entirely.

import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve, basename } from 'node:path';
import { getContracts } from './config.mjs';

const execAsync = promisify(execCb);

const resolvePath = (p) => {
  if (isAbsolute(p)) return p;
  const workspace = process.env.WORKSPACE || '/opt/corekit/workspace';
  return join(workspace, p);
};

const BIN_DIR = process.env.BIN_DIR || '/opt/corekit/bin';
const SKILLS_DIR = process.env.SKILLS_DIR || '/opt/corekit/skills';

// ---- Tool-result discipline (B-4 · contracts.tools) --------------------------
// A tool result IS context. Every result-returning tool routes through capResult
// so no single call can flood an organ's window, and truncation is ALWAYS
// announced — a silent cut reads as "I saw everything" and produces confident
// wrong answers. The organ is told how to narrow instead (same re-derive-on-miss
// philosophy as the workspace-docs edit procedure).
const _tools = () => getContracts().tools || {};
const OUT_CHARS = () => _tools().output_chars || 24_000;
const OUT_HEAD = () => _tools().output_head_chars || 16_000;
const OUT_TAIL = () => _tools().output_tail_chars || 6_000;
const TOOL_TIMEOUT = () => _tools().timeout_ms || 120_000;
const MAX_BUFFER = () => _tools().max_buffer_bytes || 4 * 1024 * 1024;
const BINARY_GUARD = () => _tools().binary_guard !== false;

/**
 * Bound a tool result to the contract budget, keeping a head and a tail window
 * so both the command echo and the final status line survive.
 *
 * @param {string} text - raw tool output
 * @param {string} [what='output'] - noun used in the truncation notice
 * @param {string} [howToNarrow] - concrete next action for the organ
 * @returns {string} bounded text, with an explicit notice when cut
 */
export function capResult(text, what = 'output', howToNarrow = 'Narrow the command (grep/head/tail/--limit), or read a line range with readFile startLine/endLine.') {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const max = OUT_CHARS();
  if (s.length <= max) return s;
  const head = s.slice(0, OUT_HEAD());
  const tail = OUT_TAIL() > 0 ? s.slice(-OUT_TAIL()) : '';
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n[… ${what} truncated: ${omitted} of ${s.length} chars omitted (budget ${max}). `
    + `You have NOT seen the whole result. ${howToNarrow} …]\n\n${tail}`;
}

// Magic-byte table. Ordered most-specific-first; each entry names the route that
// DOES work, so a refusal is a signpost rather than a dead end.
const BINARY_TYPES = [
  { kind: 'PDF', magic: Buffer.from('%PDF'), route: 'drive-to-doc --file <path or driveId>  →  then docs-cat <docId> for text (OCR included).' },
  { kind: 'ZIP/OOXML (docx, xlsx, pptx)', magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), route: 'Upload to Drive and convert (drive-to-doc), or use the matching workspace-{docs,sheets,slides} skill.' },
  { kind: 'PNG image', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), route: 'drive-to-doc --file <path> runs OCR and returns a readable Doc.' },
  { kind: 'JPEG image', magic: Buffer.from([0xff, 0xd8, 0xff]), route: 'drive-to-doc --file <path> runs OCR and returns a readable Doc.' },
  { kind: 'GIF image', magic: Buffer.from('GIF8'), route: 'drive-to-doc --file <path> runs OCR and returns a readable Doc.' },
  { kind: 'gzip archive', magic: Buffer.from([0x1f, 0x8b]), route: 'Decompress first (gunzip), then read the extracted text.' },
];

/**
 * Decide whether a buffer is non-text. Magic bytes first, then a control-char
 * heuristic over the first 4KB for formats not in the table.
 *
 * @param {Buffer} buf
 * @returns {{kind: string, route: string}|null} null when the content is text
 */
export function sniffBinary(buf) {
  if (!buf || buf.length === 0) return null;
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  for (const t of BINARY_TYPES) {
    if (head.length >= t.magic.length && head.subarray(0, t.magic.length).equals(t.magic)) {
      return { kind: t.kind, route: t.route };
    }
  }
  let nul = 0, ctrl = 0;
  for (const b of head) {
    if (b === 0) nul++;
    else if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  if (nul > 0 || ctrl / head.length > 0.1) {
    return {
      kind: 'binary (non-text bytes)',
      route: 'If it is a document or image, convert it first: drive-to-doc --file <path> → docs-cat <docId>.',
    };
  }
  return null;
}

// ---- Standard Tools definition ----

const getFirebaseToken = async () => {
  if (process.env.FIREBASE_TOKEN) return process.env.FIREBASE_TOKEN;
  try {
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(500)
    });
    if (res.ok) {
      const data = await res.json();
      return data.access_token;
    }
  } catch {}
  return null;
};

export const runCommand = {
  name: 'runCommand',
  description: `Execute a shell command on the agent's host. You MUST read the relevant SKILL.md with readFile before your first use of any command. Skill docs: /opt/corekit/skills/<id>/SKILL.md. Never guess at command syntax. When an argument contains free text with apostrophes, double quotes, newlines, or $ (e.g. a project responsibilities/canon line), do NOT inline it in the command — pass it in the 'stdin' field and read it with a '--stdin' flag (CoreKit CLIs like project-manage accept it). Inlining such text in single quotes causes "Unterminated quoted string".`,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute. Use CoreKit scripts for agent capabilities.' },
      stdin: { type: 'string', description: 'Optional. Text piped to the command on stdin — the shell-safe channel for free text with quotes/apostrophes/newlines. The shell never parses it, so it cannot break quoting. Pair with a command that reads stdin (e.g. `project-manage team-add <id> --stdin`).' },
    },
    required: ['command'],
  },
  execute: async ({ command, stdin }) => {
    // Breadcrumb for the in-flight call. When an ORGAN dispatch is aborted by the
    // daemon (dispatch.gateway_timeout_ms) the organ's own reply is lost, so this
    // line is the only record of what it was doing — without it a 300s abort is
    // undiagnosable after the fact.
    const brief = String(command).replace(/\s+/g, ' ').slice(0, 200);
    const t0 = Date.now();
    console.log(`[tools] runCommand → ${brief}`);
    try {
      const env = {
        ...process.env,
        PATH: `${BIN_DIR}:${process.env.PATH}`,
        NODE_OPTIONS: '--dns-result-order=ipv4first'
      };
      const token = await getFirebaseToken();
      if (token) {
        env.FIREBASE_TOKEN = token;
      }
      const opts = {
        cwd: process.env.WORKSPACE || '/opt/corekit/workspace',
        timeout: TOOL_TIMEOUT(),
        maxBuffer: MAX_BUFFER(),
        env,
      };
      // When stdin is supplied, feed it to the child on its stdin rather than the shell
      // command line — the shell-safe channel for free text with quotes/apostrophes/newlines
      // (fixes the "Unterminated quoted string" break when free text is inlined in the command).
      const runWithStdin = (cmd, input) => new Promise((resolve, reject) => {
        const child = execCb(cmd, opts, (err, stdout, stderr) => {
          if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
        });
        try { child.stdin.end(input); } catch { /* child may have exited before stdin write */ }
      });
      const { stdout, stderr } = (typeof stdin === 'string' && stdin.length > 0)
        ? await runWithStdin(command, stdin)
        : await execAsync(command, opts);
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
      console.log(`[tools] runCommand ✓ ${Date.now() - t0}ms ${output.length}b`);
      return { result: capResult(output, 'command output') || '(no output)' };
    } catch (err) {
      return execFailure('runCommand', err, Date.now() - t0, brief);
    }
  },
};

/**
 * The tool result for a command that did not complete — shared by runCommand and memoryCommand
 * so a timeout reads as "unknown, narrow it" and an overflow as "filter it", identically.
 */
function execFailure(tool, err, elapsed, brief) {
  const timedOut = err.killed || err.signal === 'SIGTERM' || /timed?\s?out/i.test(err.message || '');
  if (timedOut) {
    console.warn(`[tools] ${tool} TIMEOUT ${elapsed}ms (limit ${TOOL_TIMEOUT()}ms) → ${brief}`);
    return { error: `ERROR: command timed out after ${Math.round(elapsed / 1000)}s (limit ${Math.round(TOOL_TIMEOUT() / 1000)}s): ${brief}\n`
      + 'The command did not finish — treat this as "unknown", not "failed". Re-run a narrower version (one file/id at a time, add --limit, or filter with grep) rather than repeating it verbatim.' };
  }
  if (err.code === 'ENOBUFS' || /maxBuffer/i.test(err.message || '')) {
    console.warn(`[tools] ${tool} OVERFLOW ${elapsed}ms → ${brief}`);
    return { error: `ERROR: command produced more than the ${MAX_BUFFER()}-byte output limit: ${brief}\n`
      + 'Redirect it to a file and read a range, or filter the output (grep/head) before returning it.' };
  }
  console.warn(`[tools] ${tool} ✗ ${elapsed}ms → ${brief}: ${String(err.message).slice(0, 200)}`);
  return { error: capResult(`ERROR: ${err.message}${err.stderr ? `\nSTDERR: ${err.stderr}` : ''}`, 'error output') };
}

export const readFileTool = {
  name: 'readFile',
  description: 'Read the contents of a file from the agent workspace or filesystem.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative file path' },
      startLine: { type: 'number', description: 'Start line (1-indexed)' },
      endLine: { type: 'number', description: 'End line (1-indexed, inclusive)' },
    },
    required: ['path'],
  },
  execute: async ({ path, startLine, endLine }) => {
    try {
      const resolvedPath = resolvePath(path);
      // Read as bytes so a binary file can be REFUSED rather than decoded into
      // the context window. A 340KB PDF decoded as utf8 is ~340k chars of
      // mojibake that teaches the organ nothing and costs it everything.
      const buf = readFileSync(resolvedPath);
      if (BINARY_GUARD()) {
        const bin = sniffBinary(buf);
        if (bin) {
          return { error: `ERROR: ${path} is ${bin.kind}, not text — its bytes are unreadable as characters and would consume the whole context window.\n`
            + `Do this instead: ${bin.route}\n`
            + 'This is a routing problem, not a dead end — the content IS reachable by the route above.' };
        }
      }
      const content = buf.toString('utf8');
      if (startLine || endLine) {
        const lines = content.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;
        return { result: capResult(lines.slice(start, end).join('\n'), `${path} lines ${start + 1}-${end}`, 'Request a smaller startLine/endLine range.') };
      }
      return { result: capResult(content, path, `Re-read a specific range with startLine/endLine (the file is ${content.length} chars).`) };
    } catch (err) {
      if (err.code === 'ENOENT' && path.includes('/skills/')) {
        try {
          const available = readdirSync(SKILLS_DIR)
            .filter(d => existsSync(join(SKILLS_DIR, d, 'SKILL.md')))
            .join(', ');
          return { error: `ERROR: Skill not found at ${path}. Available skills: [${available}]. Use: readFile ${SKILLS_DIR}/<id>/SKILL.md` };
        } catch {}
      }
      return { error: `ERROR: ${err.message}` };
    }
  },
};

export const writeFileTool = {
  name: 'writeFile',
  description: 'Write content to a file. Creates the file if it does not exist.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative file path' },
      content: { type: 'string', description: 'File content to write' },
    },
    required: ['path', 'content'],
  },
  execute: async ({ path, content }) => {
    try {
      const resolvedPath = resolvePath(path);
      writeFileSync(resolvedPath, content, 'utf8');
      return { result: `Written ${content.length} bytes to ${path}` };
    } catch (err) {
      return { error: `ERROR: ${err.message}` };
    }
  },
};

export const listDirTool = {
  name: 'listDir',
  description: 'List directory contents.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  },
  execute: async ({ path }) => {
    try {
      const resolvedPath = resolvePath(path);
      const entries = readdirSync(resolvedPath).map(name => {
        const fullPath = join(resolvedPath, name);
        try {
          const stat = statSync(fullPath);
          return `${stat.isDirectory() ? 'd' : '-'} ${name}${stat.isDirectory() ? '/' : ''} (${stat.size}b)`;
        } catch {
          return `? ${name}`;
        }
      });
      return { result: capResult(entries.join('\n'), `listing of ${path}`, 'List a narrower subdirectory.') || '(empty directory)' };
    } catch (err) {
      return { error: `ERROR: ${err.message}` };
    }
  },
};

// ---- Memory-scoped tools (the memory boundary — BRAIN_CANON B-5 + organ table) ----------
//
// Memory is a CLOSED set of three layers — working memory (MEMORY.md), Core Memory and the
// Deep Truths region — and the memory system writes nothing else. Processes, projects, skills
// and responsibilities are definitions: memory READS them and never writes them. Temporal-Memory
// is tooled only to consolidate, and then config.mjs hands it THESE tools instead of
// runCommand/writeFile. Before, a tooled temporal-memory got every tool (allowedTools null) —
// a full shell — and a consolidation pass wrote project context through project-manage.

// Exactly the `scripts` of the skills whose agent_part is temporal-memory (memory-consolidate ∪
// memory-recall), and exactly the CLIs in corekit/memory/ — tests/memory-boundary.test.mjs holds
// all three in agreement, so a new memory CLI is a deliberate, reviewed addition.
export const MEMORY_CLIS = Object.freeze([
  'core-memory-read', 'core-memory-write', 'core-memory-retire', 'update-deep-truths', 'session-summary',
]);

// Read-only views of the definitions memory reconciles against. Memory may LIST and GET a
// playbook or a project — to see what the agent already has, and to retire a memory that merely
// restates one — never write, retire or add context to one.
export const MEMORY_READ_VIEWS = Object.freeze({
  'process-ops': Object.freeze(['list', 'get']),
  'project-manage': Object.freeze(['list', 'get', 'team-list', 'canon-list', 'get-artifacts-root']),
});

// The files memory writes: working memory, and the consolidation report (the verifiable record
// of a consolidation pass). SOUL.md is not here — its Deep Truths region changes only through
// update-deep-truths, which verifies before it writes.
export const MEMORY_FILES = Object.freeze(['MEMORY.md', 'consolidation_report.md', 'memory_consolidation_report.md']);
const MEMORY_HOME = () => process.env.MEMORY_HOME || join(process.env.CORE_DIR || '/opt/corekit', 'workspace');
const MEMORY_MD_TARGET = 2_000;   // the working-memory budget the consolidation skill prunes to
const MEMORY_MD_HARD_CAP = 8_000; // a runaway rewrite must not flood every cortex prompt

/**
 * Split a command line into argv WITHOUT a shell. Quotes group; nothing expands. An unquoted
 * shell operator is refused rather than passed through — memoryCommand runs one CLI, and a
 * `;`, pipe, redirect or `$(...)` is an attempt to run something else.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCommandLine(line) {
  const argv = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { argv.push(cur); cur = ''; started = false; }
      continue;
    }
    if (/[;&|<>`$(){}]/.test(c)) {
      throw new Error(`shell operator '${c}' is refused — memoryCommand runs ONE memory CLI with no shell`);
    }
    cur += c;
    started = true;
  }
  if (quote) throw new Error('unterminated quote');
  if (started) argv.push(cur);
  return argv;
}

/**
 * Decide whether argv is a command the memory authority may run. Pure.
 *
 * @param {string[]} argv
 * @param {string} [binDir]
 * @returns {{ok:true, name:string, path:string} | {ok:false, reason:string}}
 */
export function checkMemoryCommand(argv, binDir = BIN_DIR) {
  if (!Array.isArray(argv) || !argv[0]) return { ok: false, reason: 'empty command' };
  let name = argv[0];
  if (name.includes('/')) {
    // A path is accepted only when it IS the installed CLI — never an arbitrary binary.
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (name !== `${binDir}/${base}`) return { ok: false, reason: `'${name}' is not an installed memory CLI` };
    name = base;
  }
  if (MEMORY_CLIS.includes(name)) return { ok: true, name, path: `${binDir}/${name}` };
  const views = MEMORY_READ_VIEWS[name];
  if (views) {
    if (views.includes(argv[1])) return { ok: true, name, path: `${binDir}/${name}` };
    const attempted = [name, argv[1]].filter(Boolean).join(' ');
    return {
      ok: false,
      reason: `'${attempted}' is not a read-only view — memory may run only ${name} ${views.join('|')}; definitions are read, never written`,
    };
  }
  const readViews = Object.entries(MEMORY_READ_VIEWS).map(([k, v]) => `${k} ${v.join('|')}`).join(', ');
  return {
    ok: false,
    reason: `'${name}' is not a memory command. Memory writes only working memory, Core Memory and Deep Truths `
      + `(${MEMORY_CLIS.join(', ')}); definitions are read-only (${readViews}).`,
  };
}

/**
 * Resolve a path to one of the memory files, or null when it is anything else. Pure.
 *
 * @param {string} path - absolute, or relative to the memory home (the cortex workspace)
 * @param {string} [home]
 * @returns {string|null} the absolute target when writable by memory
 */
export function memoryFileTarget(path, home = MEMORY_HOME()) {
  if (!path) return null;
  const target = resolve(isAbsolute(path) ? path : join(home, path));
  return MEMORY_FILES.map((f) => resolve(join(home, f))).includes(target) ? target : null;
}

export const memoryCommand = {
  name: 'memoryCommand',
  description: `Run ONE memory command — the only commands the memory authority runs. Memory CLIs: ${MEMORY_CLIS.join(', ')}. `
    + `Read-only definition views: process-ops list|get, project-manage list|get|team-list|canon-list (definitions are read, never written). `
    + `Pass the command line exactly as the memory-consolidate skill shows it, e.g. "core-memory-read --category resources --limit 50". `
    + `It runs WITHOUT a shell: pipes, redirects, ";", "&&" and "$(...)" are refused. Put long free text (quotes, apostrophes, newlines) in 'stdin' for a CLI that reads it.`,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The memory CLI and its arguments, e.g. core-memory-retire --id mem-20260919-99f5bccd --reason "duplicate of mem-20260915-4f7ad67c"' },
      stdin: { type: 'string', description: 'Optional text piped to the CLI on stdin.' },
    },
    required: ['command'],
  },
  execute: async ({ command, stdin }) => {
    const brief = String(command ?? '').replace(/\s+/g, ' ').slice(0, 200);
    let argv;
    try {
      argv = splitCommandLine(String(command ?? '').trim());
    } catch (e) {
      console.warn(`[tools] memoryCommand ✗ refused → ${brief}: ${e.message}`);
      return { error: `REFUSED (memory boundary): ${e.message}` };
    }
    const check = checkMemoryCommand(argv);
    if (!check.ok) {
      console.warn(`[tools] memoryCommand ✗ refused → ${brief}: ${check.reason}`);
      return { error: `REFUSED (memory boundary): ${check.reason}` };
    }
    const t0 = Date.now();
    console.log(`[tools] memoryCommand → ${brief}`);
    try {
      const env = { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}`, NODE_OPTIONS: '--dns-result-order=ipv4first' };
      const token = await getFirebaseToken();
      if (token) env.FIREBASE_TOKEN = token;
      const opts = { cwd: MEMORY_HOME(), timeout: TOOL_TIMEOUT(), maxBuffer: MAX_BUFFER(), env };
      const { stdout, stderr } = await new Promise((res, rej) => {
        const child = execFileCb(check.path, argv.slice(1), opts, (err, so, se) => {
          if (err) { err.stdout = so; err.stderr = se; rej(err); } else res({ stdout: so, stderr: se });
        });
        // Always close stdin: a CLI that reads it must not hang waiting for input nobody sends.
        try { child.stdin.end(typeof stdin === 'string' ? stdin : ''); } catch { /* child already exited */ }
      });
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
      console.log(`[tools] memoryCommand ✓ ${Date.now() - t0}ms ${output.length}b`);
      return { result: capResult(output, 'command output') || '(no output)' };
    } catch (err) {
      return execFailure('memoryCommand', err, Date.now() - t0, brief);
    }
  },
};

export const writeMemoryFile = {
  name: 'writeMemoryFile',
  description: `Write one of the memory authority's own files: working memory (MEMORY.md — keep it under ${MEMORY_MD_TARGET.toLocaleString('en-US')} characters) `
    + `or the consolidation report (consolidation_report.md). These are the ONLY files memory writes: any other path is refused — `
    + 'process, project, skill and organ files are read-only to memory, and Deep Truths change only through update-deep-truths.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: `One of: ${MEMORY_FILES.join(', ')} (in the agent workspace)` },
      content: { type: 'string', description: 'The complete file content' },
    },
    required: ['path', 'content'],
  },
  execute: async ({ path, content }) => {
    const target = memoryFileTarget(String(path ?? ''));
    if (!target) {
      console.warn(`[tools] writeMemoryFile ✗ refused → ${path}`);
      return { error: `REFUSED (memory boundary): '${path}' is not a memory file. Memory writes only ${MEMORY_FILES.join(', ')} in the agent workspace.` };
    }
    const text = typeof content === 'string' ? content : String(content ?? '');
    const isWorkingMemory = basename(target) === 'MEMORY.md';
    if (isWorkingMemory && text.length > MEMORY_MD_HARD_CAP) {
      return { error: `REFUSED: MEMORY.md would be ${text.length} chars (hard cap ${MEMORY_MD_HARD_CAP}; target < ${MEMORY_MD_TARGET}). Prune further — working memory is loaded into every cortex prompt.` };
    }
    try {
      writeFileSync(target, text, 'utf8');
      const over = isWorkingMemory && text.length > MEMORY_MD_TARGET ? ` — over the ${MEMORY_MD_TARGET}-char target; prune further` : '';
      return { result: `Written ${text.length} chars to ${basename(target)}${over}` };
    } catch (err) {
      return { error: `ERROR: ${err.message}` };
    }
  },
};

// ---- Verdict Tools (cerebellum only) ----

export const reportPass = {
  name: 'report_pass',
  description: 'Report that the milestone\'s INTENT is achieved. Call this tool exactly once when the deliverable does what was asked, with concrete supporting evidence. You may PASS even when a listed criterion is only partially met or deferred — SO LONG AS the gap does NOT defeat the deliverable (e.g. a value that resolves at runtime, an optional enrichment left undone): pass, and state that gap in `caveat` so the operator sees it. Reserve report_fail for a milestone whose intent is genuinely unmet (wrong output, a missing core deliverable, an unrecoverable error, a claim contradicted by evidence).',
  schema: {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: 'Brief summary of why the work passes' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string' },
            pass: { type: 'boolean' },
            evidence: { type: 'string' },
          },
          required: ['criterion', 'pass', 'evidence'],
        },
      },
      caveat: { type: 'string', description: 'OPTIONAL. Leave empty for a clean, unqualified pass. If the intent is met but a criterion is partially met or deferred in a way that does NOT defeat the deliverable, name that gap here in one plain sentence — it is surfaced to the operator, honestly, not hidden. A caveat is not a way to wave through wrong work: a gap that defeats the deliverable is a report_fail, not a caveat.' },
    },
    required: ['reasoning', 'checks'],
  },
  execute: async ({ reasoning, checks, caveat }) => {
    return { verdict: 'PASS', reasoning, checks, ...(caveat ? { caveat } : {}) };
  },
};

export const reportFail = {
  name: 'report_fail',
  description: 'Report that one or more acceptance criteria are NOT satisfied. Call this tool exactly once when any criterion lacks evidence or is contradicted.',
  schema: {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: 'Summary of what failed and why' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string' },
            pass: { type: 'boolean' },
            evidence: { type: 'string' },
          },
          required: ['criterion', 'pass', 'evidence'],
        },
      },
      recommendation: { type: 'string', description: 'Specific action to fix the failure' },
    },
    required: ['reasoning', 'checks', 'recommendation'],
  },
  execute: async ({ reasoning, checks, recommendation }) => {
    return { verdict: 'FAIL', reasoning, checks, recommendation };
  },
};

export const requestProbe = {
  name: 'request_probe',
  description: 'Request independent re-derivation of specific claims before rendering a verdict. Use ONLY for load-bearing claims that cannot be verified from the provided evidence — claims whose truth requires re-running, recomputing by a different route, or checking live state. The daemon executes each probe in a fresh session with no access to the original transcript, then returns the results to you for a final verdict. One probe round maximum.',
  schema: {
    type: 'object',
    properties: {
      probes: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: {
        claim:       { type: 'string', description: 'The exact claim to re-derive' },
        instruction: { type: 'string', description: 'How to re-derive it from ground truth by a DIFFERENT route than the original. Exact commands/paths. Do NOT reference the original task or its output.' },
      }, required: ['claim', 'instruction'] }},
      reasoning: { type: 'string', description: 'Why these claims cannot be verified from the provided evidence' },
    },
    required: ['probes', 'reasoning'],
  },
  execute: async ({ probes }) => ({
    status: 'probes_requested',
    count: probes.length,
    note: 'Session ends; the daemon will run these probes independently and re-dispatch you with results.',
  }),
};

// ---- Helper: Convert standard schema to Google uppercase type schema ----
// Gemini's functionDeclarations accept a SUBSET of JSON Schema. Passing
// unsupported keywords doesn't fail the API call but CAN produce
// finishReason=MALFORMED_FUNCTION_CALL when the model's output is validated
// against constraints the SDK doesn't understand. Observed: request_probe's
// minItems/maxItems triggered deterministic MALFORMED at prompt sizes well
// inside the documented safe threshold (~4.5K chars).
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minItems', 'maxItems', 'minLength', 'maxLength',
  'pattern', 'default', 'additionalProperties',
  'anyOf', 'oneOf', 'allOf', 'not', '$ref', '$schema',
  'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'format', 'examples', 'const',
]);
export function toGoogleSchema(schema) {
  if (!schema) return undefined;
  const copy = JSON.parse(JSON.stringify(schema));
  const convert = (node) => {
    if (node && typeof node === 'object') {
      for (const key of UNSUPPORTED_SCHEMA_KEYS) {
        delete node[key];
      }
      if (typeof node.type === 'string') {
        node.type = node.type.toUpperCase();
      }
      if (node.properties && typeof node.properties === 'object') {
        for (const k of Object.keys(node.properties)) {
          convert(node.properties[k]);
        }
      }
      if (node.items && typeof node.items === 'object') {
        convert(node.items);
      }
    }
  };
  convert(copy);
  return copy;
}

// ---- Tool set builders ----

export function getAllTools() {
  return {
    runCommand,
    readFile: readFileTool,
    writeFile: writeFileTool,
    listDir: listDirTool,
    memoryCommand,
    writeMemoryFile,
    report_pass: reportPass,
    report_fail: reportFail,
    request_probe: requestProbe,
  };
}

// Tools that exist only for a scoped organ's allowlist — never part of the open set an
// unrestricted organ (allowedTools null) receives. The memory tools are narrower duplicates of
// runCommand/writeFile; handing them to motor would only cost it prompt tokens.
const SCOPED_ONLY = new Set(['memoryCommand', 'writeMemoryFile']);

export function getFilteredTools(allowList) {
  const all = getAllTools();
  if (!allowList) return Object.fromEntries(Object.entries(all).filter(([k]) => !SCOPED_ONLY.has(k)));
  if (Array.isArray(allowList) && allowList.length === 0) return undefined;
  return Object.fromEntries(
    allowList.map(name => [name, all[name]]).filter(([, v]) => v)
  );
}
