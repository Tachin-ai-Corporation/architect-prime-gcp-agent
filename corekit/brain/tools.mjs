// corekit/brain/tools.mjs — Direct Vendor SDK Tool Registry
//
// Exposes CoreKit scripts as simplified tool objects for direct vendor SDKs.
// Removes Vercel AI SDK wrappers entirely.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const execAsync = promisify(execCb);

const TOOL_TIMEOUT = 120_000; // 2 minutes per tool call
const BIN_DIR = process.env.BIN_DIR || '/opt/corekit/bin';

// ---- Standard Tools definition ----

export const runCommand = {
  name: 'runCommand',
  description: `Execute a shell command on the agent's host. Available tools are documented in installed skills at /opt/corekit/skills/<name>/SKILL.md — read the relevant skill before using a tool.`,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute. Use CoreKit scripts for agent capabilities.' },
    },
    required: ['command'],
  },
  execute: async ({ command }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.env.WORKSPACE || '/opt/corekit/workspace',
        timeout: TOOL_TIMEOUT,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}` },
      });
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
      return { result: output || '(no output)' };
    } catch (err) {
      return { error: `ERROR: ${err.message}${err.stderr ? `\nSTDERR: ${err.stderr}` : ''}` };
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
      const content = readFileSync(path, 'utf8');
      if (startLine || endLine) {
        const lines = content.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;
        return { result: lines.slice(start, end).join('\n') };
      }
      return { result: content };
    } catch (err) {
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
