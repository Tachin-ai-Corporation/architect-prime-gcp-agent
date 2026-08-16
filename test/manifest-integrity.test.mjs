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

/**
 * The reverse direction: a skill package that no manifest ships.
 *
 * Every check above runs manifest → repo, so it catches a manifest line naming a
 * file that does not exist. It cannot catch a package that exists and is named by
 * no manifest — that package reaches no agent, and nothing said so. Two were
 * sitting there: `git-ops` and `github-pr`, homeless since C-34 removed repository
 * authorship from Prime, with a comment in job-engineer.txt still telling readers
 * they were Prime skills.
 *
 * Deliberately unshipped packages are declared in skills/UNSHIPPED.md with the
 * decision that put them there. Anything else is a forgotten manifest line.
 */
export function declaredUnshipped(markdown) {
  const ids = new Set();
  for (const m of String(markdown).matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)) ids.add(m[1]);
  return ids;
}

describe('manifest integrity — every skill package reaches an agent', () => {
  const declaredPath = join(repoRoot, 'skills', 'UNSHIPPED.md');
  const declared = existsSync(declaredPath)
    ? declaredUnshipped(readFileSync(declaredPath, 'utf8'))
    : new Set();

  const shipped = new Set();
  for (const file of manifestFiles) {
    for (const { repoPath } of parseManifest(join(manifestDir, file))) {
      const m = repoPath.match(/^skills\/([^/]+)\//);
      if (m) shipped.add(m[1]);
    }
  }

  const packages = readdirSync(join(repoRoot, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();

  it('finds the skill packages', () => {
    assert.ok(packages.length >= 20, `only ${packages.length} skill packages found — the scan is broken`);
  });

  it('reads the declared-unshipped list', () => {
    // If the file is emptied or its table reformatted, this fails here rather
    // than turning the check below into a blanket pass.
    assert.ok(declared.size > 0, 'skills/UNSHIPPED.md declares nothing — did its table change shape?');
  });

  for (const pkg of packages) {
    it(`${pkg} is shipped by a manifest, or declared unshipped`, () => {
      if (shipped.has(pkg) || declared.has(pkg)) return;
      assert.fail(
        `skills/${pkg}/ is installed by no manifest and is not in skills/UNSHIPPED.md.\n`
        + 'Either add its manifest lines, or declare it there with the reason.',
      );
    });
  }

  it('a declaration is not a place to park a package that IS shipped', () => {
    const both = [...declared].filter((id) => shipped.has(id));
    assert.deepEqual(both, [], `declared unshipped but installed by a manifest: ${both.join(', ')}`);
  });
});
