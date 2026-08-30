'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-deepcode-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function agentCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-deepcode-agent-'));
}

function readSettings(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.deepcode', 'settings.json'), 'utf8'));
}

test('installDeepcodeSettings writes notify + permissions on a fresh cwd with no prior settings file', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  hive.installDeepcodeSettings({ id: 'a1', name: 'A', cwd }, true);
  const s = readSettings(cwd);
  assert.equal(s.permissions.defaultMode, 'allowAll');
  assert.ok(s.notify.endsWith('deepcode-notify.cjs'));
  assert.equal(s.env, undefined, 'no model chosen → no stray env key');
});

test('autoMode:false maps to permissions.defaultMode "askAll"', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  hive.installDeepcodeSettings({ id: 'a2', name: 'A', cwd }, false);
  const s = readSettings(cwd);
  assert.equal(s.permissions.defaultMode, 'askAll');
});

test('a chosen model is written into env.MODEL', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  hive.installDeepcodeSettings({ id: 'a3', name: 'A', cwd }, true, 'deepseek-v4-pro');
  const s = readSettings(cwd);
  assert.equal(s.env.MODEL, 'deepseek-v4-pro');
});

test('an existing settings.json with unrelated fields (API key, BASE_URL, mcpServers) survives untouched', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  fs.mkdirSync(path.join(cwd, '.deepcode'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.deepcode', 'settings.json'),
    JSON.stringify({ env: { API_KEY: 'sk-secret', BASE_URL: 'https://api.deepseek.com' }, mcpServers: { github: {} } }),
    'utf8'
  );
  hive.installDeepcodeSettings({ id: 'a4', name: 'A', cwd }, true, 'deepseek-v4-pro');
  const s = readSettings(cwd);
  assert.equal(s.env.API_KEY, 'sk-secret');
  assert.equal(s.env.BASE_URL, 'https://api.deepseek.com');
  assert.equal(s.env.MODEL, 'deepseek-v4-pro');
  assert.deepEqual(s.mcpServers, { github: {} });
  assert.equal(s.permissions.defaultMode, 'allowAll');
});

test('a malformed existing settings.json does not throw — the write proceeds against an empty base', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  fs.mkdirSync(path.join(cwd, '.deepcode'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.deepcode', 'settings.json'), '{not valid json', 'utf8');
  assert.doesNotThrow(() => hive.installDeepcodeSettings({ id: 'a5', name: 'A', cwd }, true));
  const s = readSettings(cwd);
  assert.equal(s.permissions.defaultMode, 'allowAll');
});

test('the shim lives at a stable <hive>/bin/deepcode-notify.cjs path shared across agents (rewritten each call, same path/content)', () => {
  const hive = new HiveManager(() => userData);
  const cwd1 = agentCwd();
  const cwd2 = agentCwd();
  hive.installDeepcodeSettings({ id: 'a6', name: 'A', cwd: cwd1 }, true);
  hive.installDeepcodeSettings({ id: 'a7', name: 'A', cwd: cwd2 }, true);
  const s1 = readSettings(cwd1);
  const s2 = readSettings(cwd2);
  assert.equal(s1.notify, s2.notify, 'both agents point at the same shared shim path');
  assert.ok(fs.existsSync(s1.notify));
});

test('a real git repo cwd gets .deepcode/ appended to .git/info/exclude, never a tracked .gitignore', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  execFileSync('git', ['init', '-q'], { cwd });
  hive.installDeepcodeSettings({ id: 'a8', name: 'A', cwd }, true);
  const exclude = fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split('\n').map((l) => l.trim()).includes('.deepcode/'));
  assert.ok(!fs.existsSync(path.join(cwd, '.gitignore')), 'must never write a tracked .gitignore in the user repo');
});

test('calling installDeepcodeSettings twice on the same git repo does not duplicate the exclude line', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  execFileSync('git', ['init', '-q'], { cwd });
  hive.installDeepcodeSettings({ id: 'a9', name: 'A', cwd }, true);
  hive.installDeepcodeSettings({ id: 'a9', name: 'A', cwd }, true);
  const exclude = fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
  const hits = exclude.split('\n').filter((l) => l.trim() === '.deepcode/');
  assert.equal(hits.length, 1);
});

test('a git worktree cwd (`.git` is a pointer FILE) resolves to the shared common dir\'s info/exclude', () => {
  const hive = new HiveManager(() => userData);
  const mainRepo = agentCwd();
  execFileSync('git', ['init', '-q'], { cwd: mainRepo });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: mainRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
  fs.writeFileSync(path.join(mainRepo, 'f.txt'), 'x');
  execFileSync('git', ['add', 'f.txt'], { cwd: mainRepo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: mainRepo });
  const worktreeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-deepcode-wt-')), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'agent-branch', worktreeDir], { cwd: mainRepo });
  assert.ok(fs.statSync(path.join(worktreeDir, '.git')).isFile(), 'worktree .git must be a pointer file, not a dir');

  hive.installDeepcodeSettings({ id: 'a10', name: 'A', cwd: worktreeDir }, true);
  const exclude = fs.readFileSync(path.join(mainRepo, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(
    exclude.split('\n').map((l) => l.trim()).includes('.deepcode/'),
    'the exclude line must land in the shared common dir, not be silently dropped'
  );
});

test('a leftover model/thinkingEnabled/reasoningEffort from DeepCode\'s own in-TUI `/model` command is cleared on the next munder-difflin write, so a restart cannot silently keep running a model the UI no longer shows', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  fs.mkdirSync(path.join(cwd, '.deepcode'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.deepcode', 'settings.json'),
    JSON.stringify({
      env: { MODEL: 'deepseek-v4-pro' },
      model: 'deepseek-v4-flash',
      thinkingEnabled: true,
      reasoningEffort: 'max'
    }),
    'utf8'
  );
  hive.installDeepcodeSettings({ id: 'a12', name: 'A', cwd }, true, 'deepseek-v4-pro');
  const s = readSettings(cwd);
  assert.equal(s.env.MODEL, 'deepseek-v4-pro');
  assert.equal(s.model, undefined, 'stale in-TUI model override must not survive a munder-difflin write');
  assert.equal(s.thinkingEnabled, undefined);
  assert.equal(s.reasoningEffort, undefined);
});

test('a non-git cwd is a silent no-op — no .git directory is created, and the settings write still succeeds', () => {
  const hive = new HiveManager(() => userData);
  const cwd = agentCwd();
  assert.doesNotThrow(() => hive.installDeepcodeSettings({ id: 'a11', name: 'A', cwd }, true));
  assert.ok(!fs.existsSync(path.join(cwd, '.git')));
  const s = readSettings(cwd);
  assert.equal(s.permissions.defaultMode, 'allowAll');
});
