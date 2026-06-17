// corekit/brain/tools.mjs — Direct Vendor SDK Tool Registry
//
// Exposes CoreKit scripts as simplified tool objects for direct vendor SDKs.
// Removes Vercel AI SDK wrappers entirely.

import { exec as execCb } from 'node:child_process';\r
import { promisify } from 'node:util';\r
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';\r
import { join } from 'node:path';\r
\r
const execAsync = promisify(execCb);\r
\r
const TOOL_TIMEOUT = 120_000; // 2 minutes per tool call\r
const BIN_DIR = process.env.BIN_DIR || '/opt/corekit/bin';\r
const SKILLS_DIR = process.env.SKILLS_DIR || '/opt/corekit/skills';\r
\r
// ---- Standard Tools definition ----\r
\r
export const runCommand = {\r
  name: 'runCommand',\r
  description: `Execute a shell command on the agent's host. You MUST read the relevant SKILL.md with readFile before your first use of any command. Skill docs: /opt/corekit/skills/<id>/SKILL.md. Never guess at command syntax.`,\r
  schema: {\r
    type: 'object',\r
    properties: {\r
      command: { type: 'string', description: 'Shell command to execute. Use CoreKit scripts for agent capabilities.' },\r
    },\r
    required: ['command'],\r
  },\r
  execute: async ({ command }) => {\r
    try {\r
      const { stdout, stderr } = await execAsync(command, {\r
        cwd: process.env.WORKSPACE || '/opt/corekit/workspace',\r
        timeout: TOOL_TIMEOUT,\r
        maxBuffer: 1024 * 1024,\r
        env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}` },\r
      });\r
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();\r
      return { result: output || '(no output)' };\r
    } catch (err) {\r
      return { error: `ERROR: ${err.message}${err.stderr ? `\nSTDERR: ${err.stderr}` : ''}` };\r
    }\r
  },\r
};\r
\r
export const readFileTool = {\r
  name: 'readFile',\r
  description: 'Read the contents of a file from the agent workspace or filesystem.',\r
  schema: {\r
    type: 'object',\r
    properties: {\r
      path: { type: 'string', description: 'Absolute or workspace-relative file path' },\r
      startLine: { type: 'number', description: 'Start line (1-indexed)' },\r
      endLine: { type: 'number', description: 'End line (1-indexed, inclusive)' },\r
    },\r
    required: ['path'],\r
  },\r
  execute: async ({ path, startLine, endLine }) => {\r
    try {\r
      const content = readFileSync(path, 'utf8');\r
      if (startLine || endLine) {\r
        const lines = content.split('\n');\r
        const start = (startLine || 1) - 1;\r
        const end = endLine || lines.length;\r
        return { result: lines.slice(start, end).join('\n') };\r
      }\r
      return { result: content };\r
    } catch (err) {\r
      if (err.code === 'ENOENT' && path.includes('/skills/')) {\r
        try {\r
          const available = readdirSync(SKILLS_DIR)\r
            .filter(d => existsSync(join(SKILLS_DIR, d, 'SKILL.md')))\r
            .join(', ');\r
          return { error: `ERROR: Skill not found at ${path}. Available skills: [${available}]. Use: readFile ${SKILLS_DIR}/<id>/SKILL.md` };\r
        } catch {}\r
      }\r
      return { error: `ERROR: ${err.message}` };\r
    }\r
  },\r
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
      writeFileSync(path, content, 'utf8');
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
      const entries = readdirSync(path).map(name => {
        const fullPath = join(path, name);
        try {
          const stat = statSync(fullPath);
          return `${stat.isDirectory() ? 'd' : '-'} ${name}${stat.isDirectory() ? '/' : ''} (${stat.size}b)`;
        } catch {
          return `? ${name}`;
        }
      });
      return { result: entries.join('\n') || '(empty directory)' };
    } catch (err) {
      return { error: `ERROR: ${err.message}` };
    }
  },
};

// ---- Helper: Convert standard schema to Google uppercase type schema ----
export function toGoogleSchema(schema) {
  if (!schema) return undefined;
  const copy = JSON.parse(JSON.stringify(schema));
  const convert = (node) => {
    if (node && typeof node === 'object') {
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
