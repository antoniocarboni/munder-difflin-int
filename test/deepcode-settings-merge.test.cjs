'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('the shim is written once to <hive>/bin/deepcode-notify.cjs, shared across agents', () => {
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
