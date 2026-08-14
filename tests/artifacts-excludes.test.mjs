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
import { renderWorkspaceExcludes, resolveCommitAssets, motorWorkspaceSweepPlan } from '../corekit/lib/artifacts.mjs';

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

  it('still ignores downloaded source material (inputs, not artifacts) by default', () => {
    const { content } = renderWorkspaceExcludes('');
    for (const pat of ['*.pdf', '*.docx', '*.png', '*.zip']) {
      assert.ok(content.split('\n').includes(pat), `expected ${pat} in excludes`);
    }
  });

  it('ignores tool caches, dep trees, and VCS conflict artifacts (deploy-scratch→main fix)', () => {
    const { content } = renderWorkspaceExcludes('');
    // .firebase/ (deploy cache) literally leaked into a project main; node_modules + *.orig/*.rej
    // are never a project's committable source. Belt-and-suspenders behind stage-only-intended.
    for (const pat of ['.firebase/', 'node_modules/', '*.orig', '*.rej']) {
      assert.ok(content.split('\n').includes(pat), `expected ${pat} in excludes`);
    }
  });

  it('keeps the tool-cache excludes even for an asset-bearing project (they are never source)', () => {
    const { content } = renderWorkspaceExcludes('', { keepAssets: true });
    for (const pat of ['.firebase/', 'node_modules/', '*.orig', '*.rej']) {
      assert.ok(content.split('\n').includes(pat), `expected ${pat} excluded with keepAssets`);
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

describe('renderWorkspaceExcludes — asset-bearing project (keepAssets)', () => {
  // The tachin-web pathology: a website's own images are the deliverable, but the default
  // input-hygiene excludes dropped *.png/*.jpg so the migrated git tree shipped HTML-only.
  const IMAGE_GLOBS = ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp'];

  it('does NOT exclude image/media globs when keepAssets is set', () => {
    const { content } = renderWorkspaceExcludes('', { keepAssets: true });
    const lines = content.split('\n');
    for (const pat of IMAGE_GLOBS) {
      assert.ok(!lines.includes(pat), `${pat} must NOT be excluded for an asset-bearing project`);
    }
  });

  it('still excludes archives + office docs even with keepAssets (never a site\'s source)', () => {
    const { content } = renderWorkspaceExcludes('', { keepAssets: true });
    const lines = content.split('\n');
    for (const pat of ['*.pdf', '*.docx', '*.xlsx', '*.pptx', '*.zip', '*.gz', '*.tar']) {
      assert.ok(lines.includes(pat), `expected ${pat} still excluded with keepAssets`);
    }
  });

  it('still ignores bookkeeping + organ identity with keepAssets (C-24/C-28 defenses hold)', () => {
    const { content } = renderWorkspaceExcludes('', { keepAssets: true });
    for (const pat of ['/MISSION.md', '/missions/', '/IDENTITY.md', '/SOUL.md', '/shared']) {
      assert.ok(content.split('\n').includes(pat), `expected ${pat} still excluded with keepAssets`);
    }
  });

  it('is idempotent with keepAssets too', () => {
    const first = renderWorkspaceExcludes('', { keepAssets: true }).content;
    assert.equal(renderWorkspaceExcludes(first, { keepAssets: true }).changed, false);
  });
});

describe('resolveCommitAssets', () => {
  it('is false for a plain/undefined project (default input hygiene)', () => {
    assert.equal(resolveCommitAssets(undefined), false);
    assert.equal(resolveCommitAssets({}), false);
    assert.equal(resolveCommitAssets({ class: 'code' }), false);
  });

  it('is true for a web/website/site-class project', () => {
    assert.equal(resolveCommitAssets({ class: 'web' }), true);
    assert.equal(resolveCommitAssets({ type: 'website' }), true);
    assert.equal(resolveCommitAssets({ class: 'site' }), true);
  });

  it('honours an explicit commit_assets flag over class', () => {
    assert.equal(resolveCommitAssets({ commit_assets: true, class: 'code' }), true);
    assert.equal(resolveCommitAssets({ commit_assets: false, class: 'web' }), false);
  });
});

describe('motorWorkspaceSweepPlan', () => {
  // The pathology: the motor's persistent workspace (its tool cwd) accumulated an old
  // site + node_modules + git clones across missions, and `firebase deploy public:"."`
  // shipped that blob to staging. The sweep clears scratch at mission start.
  const dirent = (name, isSymlink = false) => ({ name, isSymlink });

  it('removes scratch but keeps identity / working-memory / runtime files', () => {
    const entries = [
      dirent('SOUL.md'), dirent('IDENTITY.md'), dirent('MEMORY.md'), dirent('TASK.json'),
      dirent('config.json'), dirent('progress.json'), dirent('sessions.json'),
      dirent('CLASSIFIED_MEMORY.md'), dirent('custom-skills'),
      dirent('index.html'), dirent('node_modules'), dirent('.git'), dirent('report.md'),
      dirent('tachin-website-repo'), dirent('hosting_public'),
    ];
    const removed = motorWorkspaceSweepPlan(entries).sort();
    assert.deepEqual(removed, ['.git', 'hosting_public', 'index.html', 'node_modules', 'report.md', 'tachin-website-repo'].sort());
    // none of the keep-set was scheduled for deletion
    for (const keep of ['SOUL.md','IDENTITY.md','MEMORY.md','TASK.json','config.json','progress.json','sessions.json','CLASSIFIED_MEMORY.md','custom-skills']) {
      assert.ok(!removed.includes(keep), `must keep ${keep}`);
    }
  });

  it('NEVER removes a symlink — the `shared` missions link (and any symlink) is untouched', () => {
    const entries = [dirent('shared', true), dirent('index.html'), dirent('weird-link', true)];
    const removed = motorWorkspaceSweepPlan(entries);
    assert.ok(!removed.includes('shared'), 'shared symlink must never be swept');
    assert.ok(!removed.includes('weird-link'), 'no symlink is ever swept');
    assert.deepEqual(removed, ['index.html']);
  });

  it('is a no-op on a clean workspace and on empty input', () => {
    assert.deepEqual(motorWorkspaceSweepPlan([]), []);
    assert.deepEqual(motorWorkspaceSweepPlan([dirent('SOUL.md'), dirent('MEMORY.md'), dirent('shared', true)]), []);
  });
});
