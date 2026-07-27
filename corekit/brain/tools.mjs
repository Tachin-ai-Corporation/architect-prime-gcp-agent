// corekit/brain/tools.mjs — Direct Vendor SDK Tool Registry
//
// Exposes CoreKit scripts as simplified tool objects for direct vendor SDKs.
// Removes Vercel AI SDK wrappers entirely.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
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
  description: `Execute a shell command on the agent's host. You MUST read the relevant SKILL.md with readFile before your first use of any command. Skill docs: /opt/corekit/skills/<id>/SKILL.md. Never guess at command syntax.`,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute. Use CoreKit scripts for agent capabilities.' },
    },
    required: ['command'],
  },
  execute: async ({ command }) => {
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
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.env.WORKSPACE || '/opt/corekit/workspace',
        timeout: TOOL_TIMEOUT(),
        maxBuffer: MAX_BUFFER(),
        env,
      });
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
      console.log(`[tools] runCommand ✓ ${Date.now() - t0}ms ${output.length}b`);
      return { result: capResult(output, 'command output') || '(no output)' };
    } catch (err) {
      const elapsed = Date.now() - t0;
      const timedOut = err.killed || err.signal === 'SIGTERM' || /timed?\s?out/i.test(err.message || '');
      if (timedOut) {
        console.warn(`[tools] runCommand TIMEOUT ${elapsed}ms (limit ${TOOL_TIMEOUT()}ms) → ${brief}`);
        return { error: `ERROR: command timed out after ${Math.round(elapsed / 1000)}s (limit ${Math.round(TOOL_TIMEOUT() / 1000)}s): ${brief}\n`
          + 'The command did not finish — treat this as "unknown", not "failed". Re-run a narrower version (one file/id at a time, add --limit, or filter with grep) rather than repeating it verbatim.' };
      }
      if (err.code === 'ENOBUFS' || /maxBuffer/i.test(err.message || '')) {
        console.warn(`[tools] runCommand OVERFLOW ${elapsed}ms → ${brief}`);
        return { error: `ERROR: command produced more than the ${MAX_BUFFER()}-byte output limit: ${brief}\n`
          + 'Redirect it to a file and read a range, or filter the output (grep/head) before returning it.' };
      }
      console.warn(`[tools] runCommand ✗ ${elapsed}ms → ${brief}: ${String(err.message).slice(0, 200)}`);
      return { error: capResult(`ERROR: ${err.message}${err.stderr ? `\nSTDERR: ${err.stderr}` : ''}`, 'error output') };
    }
  },
};

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

// ---- Verdict Tools (cerebellum only) ----

export const reportPass = {
  name: 'report_pass',
  description: 'Report that all acceptance criteria are satisfied. Call this tool exactly once when every criterion has concrete supporting evidence.',
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
    },
    required: ['reasoning', 'checks'],
  },
  execute: async ({ reasoning, checks }) => {
    return { verdict: 'PASS', reasoning, checks };
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
    report_pass: reportPass,
    report_fail: reportFail,
    request_probe: requestProbe,
  };
}

export function getFilteredTools(allowList) {
  const all = getAllTools();
  if (!allowList) return all;
  if (Array.isArray(allowList) && allowList.length === 0) return undefined;
  return Object.fromEntries(
    allowList.map(name => [name, all[name]]).filter(([, v]) => v)
  );
}
