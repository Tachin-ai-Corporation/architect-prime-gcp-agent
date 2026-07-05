// corekit/lib/mission-record.mjs — Structured mission output persistence
//
// Pure render functions + one effectful writer.
// Mission records ensure durable full-output files exist in the git workspace
// BEFORE the artifact publish step, so commitAndSync captures them.
//
// output.md  — human-readable mission result with header
// result.json — structured completion summary for deterministic recovery

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ---- Pure render functions ----

/**
 * Render the markdown header block for a mission record.
 * Pure — no I/O, no LLM.
 *
 * @param {object} envelope - The mission envelope
 * @returns {string} Markdown header string
 */
export function renderMissionRecordHeader(envelope) {
  const lines = [
    `# Mission: ${envelope.title || 'Untitled'}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| ID | \`${envelope.id}\` |`,
    `| Status | ${envelope.status || 'unknown'} |`,
    `| Owner | ${envelope.owner || 'unknown'} |`,
    `| Created | ${envelope.created_at || '—'} |`,
    `| Completed | ${envelope.completed_at || '—'} |`,
  ];

  if (envelope.project_id) {
    lines.push(`| Project | \`${envelope.project_id}\` |`);
  }
  if (envelope.source_meta?.delegation_ref) {
    lines.push(`| Delegation Ref | \`${envelope.source_meta.delegation_ref}\` |`);
  }
  if (envelope.accept_criteria) {
    lines.push(`| Accept Criteria | ${envelope.accept_criteria} |`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Render the full output.md content for a mission record.
 * Pure — no I/O, no LLM.
 *
 * @param {object} envelope - The mission envelope
 * @returns {string} Full output.md content
 */
export function renderMissionRecordBody(envelope) {
  const header = renderMissionRecordHeader(envelope);
  const output = envelope.output || '(no output)';
  return `${header}---\n\n## Output\n\n${output}\n`;
}

/**
 * Render the structured result.json content for a mission record.
 * Pure — no I/O, no LLM.
 *
 * @param {object} envelope - The mission envelope
 * @param {object} [verification] - Optional verification result
 * @returns {object} Structured result object (serializable to JSON)
 */
export function renderResultJson(envelope, verification = null) {
  return {
    id: envelope.id,
    type: envelope.type || 'M',
    status: envelope.status,
    title: envelope.title || null,
    owner: envelope.owner || null,
    project_id: envelope.project_id || null,
    created_at: envelope.created_at || null,
    completed_at: envelope.completed_at || null,
    accept_criteria: envelope.accept_criteria || null,
    output_chars: (envelope.output || '').length,
    output_preview: (envelope.output || '').substring(0, 500),
    delegation_ref: envelope.source_meta?.delegation_ref || null,
    artifact_status: envelope.context?.artifact_status || null,
    verification: verification ? {
      verdict: verification.verdict || null,
      summary: verification.summary || null,
    } : null,
    children_count: envelope.children?.length || 0,
    iteration: envelope.iteration || 0,
  };
}

/**
 * Write mission record files into the shared workspace directory.
 * Effectful edge — writes output.md and result.json to the git working tree.
 * Idempotent: overwriting same content produces identical files.
 *
 * @param {object} envelope - The mission envelope
 * @param {string} sharedDir - Absolute path to shared/{envelopeId}/ directory
 * @param {Function} [logFn] - Optional log function
 * @returns {{ written: boolean, files: string[] }} Result of the write
 */
export function writeMissionRecord(envelope, sharedDir, logFn) {
  const log = logFn || (() => {});

  if (!sharedDir || !existsSync(sharedDir)) {
    log('DEBUG', `writeMissionRecord: shared dir missing for ${envelope.id}, skipping`);
    return { written: false, files: [] };
  }

  const missionsDir = join(sharedDir, 'missions');
  const files = [];

  try {
    if (!existsSync(missionsDir)) {
      mkdirSync(missionsDir, { recursive: true });
    }

    // Write output.md
    const outputMd = renderMissionRecordBody(envelope);
    const outputPath = join(missionsDir, 'output.md');
    writeFileSync(outputPath, outputMd, 'utf8');
    files.push('missions/output.md');

    // Write result.json
    const resultObj = renderResultJson(envelope);
    const resultPath = join(missionsDir, 'result.json');
    writeFileSync(resultPath, JSON.stringify(resultObj, null, 2) + '\n', 'utf8');
    files.push('missions/result.json');

    log('INFO', `writeMissionRecord: wrote ${files.length} files for ${envelope.id}`);
    return { written: true, files };
  } catch (e) {
    log('WARN', `writeMissionRecord failed: ${e.message}`);
    return { written: false, files: [] };
  }
}
