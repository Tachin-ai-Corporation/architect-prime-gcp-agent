// corekit/brain/tools.mjs — Tool Registry
//
// Wraps CoreKit scripts as AI SDK tools with Zod schemas.
// The current architecture uses an `exec` tool that lets the LLM run
// shell commands — the same pattern as OpenClaw's exec tool type.
// CoreKit scripts are in PATH via ~/.openclaw/bin/.
//
// Future iterations will add typed tools (email, calendar, drive, etc.)
// with structured Zod schemas for each.

import { tool } from 'ai';
import { z } from 'zod';
import { execFile, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readFile, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const execFileAsync = promisify(execFile);
const execAsync = promisify(execCb);

const TOOL_TIMEOUT = 120_000; // 2 minutes per tool call
const BIN_DIR = process.env.BIN_DIR || '/home/node/.openclaw/bin';

// ---- Core tool: Shell command execution ----

export const runCommand = tool({
  description: `Execute a shell command on the agent's host. CoreKit scripts are available in PATH: agent-ask, web-fetch, chat-send, chat-read, drive-ls, drive-upload, drive-download, send-email, read-inbox, search-email, read-calendar, create-event, list-events, agent-status, brain-telemetry-write, brain-telemetry-read, task-log-write, task-log-read, responsibility-manage, project-manage, process-manage, work-log-read, skill-author, assemble-tools.`,
  parameters: z.object({
    command: z.string().describe('Shell command to execute. Use CoreKit scripts for agent capabilities.'),
    workdir: z.string().optional().describe('Working directory (default: agent workspace)'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
  }),
  execute: async ({ command, workdir, timeout }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workdir || process.env.WORKSPACE || '/home/node/.openclaw/workspace-cortex',
        timeout: timeout || TOOL_TIMEOUT,
        maxBuffer: 1024 * 1024, // 1MB
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

export const readFileTool = tool({
  description: 'Read the contents of a file from the agent workspace or filesystem.',
  parameters: z.object({
    path: z.string().describe('Absolute or workspace-relative file path'),
    startLine: z.number().optional().describe('Start line (1-indexed)'),
    endLine: z.number().optional().describe('End line (1-indexed, inclusive)'),
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

export const writeFileTool = tool({
  description: 'Write content to a file. Creates the file if it does not exist.',
  parameters: z.object({
    path: z.string().describe('Absolute or workspace-relative file path'),
    content: z.string().describe('File content to write'),
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

export const listDirTool = tool({
  description: 'List directory contents.',
  parameters: z.object({
    path: z.string().describe('Directory path'),
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

/**
 * All available tools.
 */
export function getAllTools() {
  return {
    runCommand,
    readFile: readFileTool,
    writeFile: writeFileTool,
    listDir: listDirTool,
  };
}

/**
 * Filter tools by allowed list.
 *
 * @param {string[]|null} allowList  Array of tool names, or null for all tools
 * @returns {object}  Filtered tool set
 */
export function getFilteredTools(allowList) {
  const all = getAllTools();
  if (!allowList) return all;
  return Object.fromEntries(
    allowList.map(name => [name, all[name]]).filter(([, v]) => v)
  );
}
