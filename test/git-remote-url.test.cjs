'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { getRemoteUrl } = loadTs('src/main/git.ts');

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-remote-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

test('getRemoteUrl returns the configured origin', async () => {
  const dir = initRepo();
  spawnSync('git', ['remote', 'add', 'origin', 'git@bitbucket.org:magenio/burdastyle.git'], { cwd: dir });
  const url = await getRemoteUrl(dir);
  assert.equal(url, 'git@bitbucket.org:magenio/burdastyle.git');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRemoteUrl returns null when there is no origin remote', async () => {
  const dir = initRepo();
  const url = await getRemoteUrl(dir);
  assert.equal(url, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRemoteUrl returns null for a non-git directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-remote-notrepo-'));
  const url = await getRemoteUrl(dir);
  assert.equal(url, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRemoteUrl resolves a worktree to its parent repo\'s origin', async () => {
  const dir = initRepo();
  spawnSync('git', ['remote', 'add', 'origin', 'git@bitbucket.org:magenio/burdastyle.git'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const wtDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-wt-')), 'wt');
  spawnSync('git', ['worktree', 'add', wtDir, '-b', 'agent/x'], { cwd: dir });
  const url = await getRemoteUrl(wtDir);
  assert.equal(url, 'git@bitbucket.org:magenio/burdastyle.git');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(wtDir, { recursive: true, force: true });
});
