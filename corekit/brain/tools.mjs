// corekit/brain/tools.mjs — Tool Registry
//
// Wraps CoreKit scripts as AI SDK tools with explicit JSON Schema.
//
// IMPORTANT: AI SDK v6 has a property name mismatch — tool() creates
// {parameters} but the framework reads {inputSchema}. We must add
// inputSchema manually to each tool definition.
//
// CoreKit scripts are in PATH via ~/.openclaw/bin/.

import { jsonSchema } from 'ai';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const execAsync = promisify(execCb);

const TOOL_TIMEOUT = 120_000; // 2 minutes per tool call
const BIN_DIR = process.env.BIN_DIR || '/home/node/.openclaw/bin';

// ---- Helper: Create tool with both parameters and inputSchema ----
function makeTool({ description, parameters, execute }) {
  return {
    type: 'function',
    description,
    parameters,
    inputSchema: parameters,  // AI SDK v6 framework reads this
    execute,
  };
}

// ---- Core tool: Shell command execution ----

const runCommandSchema = jsonSchema({
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute. Use CoreKit scripts for agent capabilities.' },
  },
  required: ['command'],
});

export const runCommand = makeTool({
  description: `Execute a shell command on the agent's host. CoreKit scripts are available in PATH: agent-ask, web-fetch, chat-send, chat-read, drive-ls, drive-upload, drive-download, send-email, read-inbox, search-email, read-calendar, create-event, list-events, agent-status, brain-telemetry-write, brain-telemetry-read, task-log-write, task-log-read, responsibility-manage, project-manage, process-manage, work-log-read, skill-author, assemble-tools.`,
  parameters: runCommandSchema,
  execute: async ({ command }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.env.WORKSPACE || '/home/node/.openclaw/workspace-cortex',
        timeout: TOOL_TIMEOUT,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}` },
      });
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
      return output || '(no output)';
    } catch (err) {
      return `ERROR: ${err.message}${err.stderr ? `\nSTDERR: ${err.stderr}` : ''}`;
    }
  },
});

// ---- File tools ----

export const readFileTool = makeTool({
  description: 'Read the contents of a file from the agent workspace or filesystem.',
  parameters: jsonSchema({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative file path' },
      startLine: { type: 'number', description: 'Start line (1-indexed)' },
      endLine: { type: 'number', description: 'End line (1-indexed, inclusive)' },
    },
    required: ['path'],
  }),
  execute: async ({ path, startLine, endLine }) => {
    try {
      const content = readFileSync(path, 'utf8');
      if (startLine || endLine) {
        const lines = content.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;
        return lines.slice(start, end).join('\n');
      }
      return content;
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  },
});

export const writeFileTool = makeTool({
  description: 'Write content to a file. Creates the file if it does not exist.',
  parameters: jsonSchema({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative file path' },
      content: { type: 'string', description: 'File content to write' },
    },
    required: ['path', 'content'],
  }),
  execute: async ({ path, content }) => {
    try {
      writeFileSync(path, content, 'utf8');
      return `Written ${content.length} bytes to ${path}`;
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  },
});

export const listDirTool = makeTool({
  description: 'List directory contents.',
  parameters: jsonSchema({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  }),
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
      return entries.join('\n') || '(empty directory)';
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  },
});

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
