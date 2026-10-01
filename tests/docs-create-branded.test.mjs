// tests/docs-create-branded.test.mjs — a content section is never dropped silently.
//
// 2026-10-01: the weekly exec update's instructions named the bullet section type
// "bullet_list"; docs-create-branded knows "bullets". Every unknown section was skipped
// with a stderr line nobody read, so each briefing lost its bulleted sections — status,
// blockers, decisions — and the tool still reported "created". The same happened to the
// briefing template on its first build. The tool now maps the common aliases and refuses
// anything else BEFORE it creates a document.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const tool = readFileSync(join(repo, 'skills', 'workspace-docs', 'docs-create-branded'), 'utf8');

describe('docs-create-branded content sections', () => {
  it('maps the aliases a writer reaches for to the real types', () => {
    for (const [alias, real] of [['bullet_list', 'bullets'], ['list', 'bullets'], ['numbered_list', 'numbered'], ['text', 'paragraph']]) {
      assert.match(tool, new RegExp(`'${alias}': '${real}'`), `${alias} → ${real}`);
    }
  });

  it('refuses an unknown type before anything is created', () => {
    const check = tool.indexOf("'status': 'invalid_content'");
    const create = tool.indexOf('uploadType=multipart');
    assert.ok(check > 0 && create > 0, 'both the check and the create are in the tool');
    assert.ok(check < create, 'the refusal happens before the document is created');
    assert.match(tool, /nothing was created/);
    assert.match(tool, /sys\.exit\(1\)/);
  });

  it('the weekly exec update writes the types the tool accepts', () => {
    const rec = readFileSync(join(repo, 'operator', 'agents', 'millie', 'responsibilities.json'), 'utf8');
    assert.doesNotMatch(rec, /bullet_list/, 'the type that was silently dropped');
    assert.match(rec, /\\"type\\":\\"bullets\\"/);
  });
});
