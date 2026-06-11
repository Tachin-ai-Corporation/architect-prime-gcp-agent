import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const manifestDir = join(repoRoot, 'infra', 'manifests');

/**
 * Parse a manifest file into an array of { repoPath, vmPath } entries.
 * Skips blank lines and comment lines (starting with #).
 */
function parseManifest(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const entries = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      entries.push({ repoPath: parts[0], vmPath: parts[1] });
    }
  }

  return entries;
}

// Enumerate all .txt manifest files
const manifestFiles = readdirSync(manifestDir)
  .filter(f => f.endsWith('.txt'))
  .sort();

describe('manifest integrity — repo paths exist', () => {
  for (const file of manifestFiles) {
    const manifestPath = join(manifestDir, file);
    const entries = parseManifest(manifestPath);

    describe(file, () => {
      for (const { repoPath } of entries) {
        it(`${repoPath} exists in repo`, () => {
          const fullPath = join(repoRoot, repoPath);
          assert.ok(
            existsSync(fullPath),
            `repo path does not exist: ${repoPath} (resolved to ${fullPath})`
          );
        });
      }
    });
  }
});
