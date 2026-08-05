// tests/artifacts-excludes.test.mjs — pure-core tests for renderWorkspaceExcludes (B-19, CR-4)
//
// The pathology being prevented, from the bobby coding canary (round 3 re-polluted):
//   the daemon writes mission bookkeeping into the git working tree — MISSION.md
//   (blackboard), missions/output.md + result.json (records), missions/<id>/steps/*.md
//   (step transcripts). `git add -A` (commitAndSync + work-commit --add-all) staged all
//   of it, so the merged diff carried ~30 step notes plus a corekit .gitignore block
//   instead of just the real source change. The fix seeds these ignores into the repo-
//   LOCAL `.git/info/exclude` (never committed) rather than a tracked `.gitignore`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkspaceExcludes } from '../corekit/lib/artifacts.mjs';

describe('renderWorkspaceExcludes', () => {
  it('emits the corekit block on an empty exclude file', () => {
    const { content, changed } = renderWorkspaceExcludes('');
    assert.equal(changed, true);
    assert.match(content, /corekit: mission scratch/);
  });

  it('ignores the mission bookkeeping that leaked into the project repo', () => {
    const { content } = renderWorkspaceExcludes('');
    // Root-anchored so a project's own nested paths stay safe.
    assert.match(content, /^\/MISSION\.md$/m);
    assert.match(content, /^\/missions\/$/m);
  });

  it('ignores organ / agent-workspace identity so a stray add -A cannot leak it (C-28)', () => {
    const { content } = renderWorkspaceExcludes('');
    // Root-anchored organ identity + the shared tree — belt-and-suspenders behind work-commit's guard.
    for (const pat of ['/IDENTITY.md', '/MEMORY.md', '/SOUL.md', '/SOUL_APPEND.md', '/shared']) {
      assert.ok(content.split('\n').includes(pat), `expected ${pat} in excludes`);
    }
  });

  it('still ignores downloaded source material (inputs, not artifacts)', () => {
    const { content } = renderWorkspaceExcludes('');
    for (const pat of ['*.pdf', '*.docx', '*.png', '*.zip']) {
      assert.ok(content.split('\n').includes(pat), `expected ${pat} in excludes`);
    }
  });

  it('is idempotent — a second pass adds nothing (C-18)', () => {
    const first = renderWorkspaceExcludes('').content;
    const second = renderWorkspaceExcludes(first);
    assert.equal(second.changed, false);
    assert.equal(second.content, first);
  });

  it('appends onto git\'s default exclude preamble without clobbering it', () => {
    const gitDefault = '# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with \'#\' are comments.\n';
    const { content, changed } = renderWorkspaceExcludes(gitDefault);
    assert.equal(changed, true);
    assert.ok(content.startsWith(gitDefault), 'preserves the existing preamble');
    assert.match(content, /^\/missions\/$/m);
    // and re-running over the merged result is a no-op
    assert.equal(renderWorkspaceExcludes(content).changed, false);
  });

  it('preserves a project\'s own exclude rules already present', () => {
    const projectRules = '# project rules\nnode_modules/\ndist/\n';
    const { content } = renderWorkspaceExcludes(projectRules);
    assert.match(content, /node_modules\//);
    assert.match(content, /dist\//);
    assert.match(content, /^\/missions\/$/m);
  });
});
