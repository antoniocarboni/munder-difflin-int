'use strict';

// Backend wiring for the Settings → Memory & Knowledge → Vault Sync panel:
// three new IPC handlers in src/main/index.ts, plus runVaultSyncTick's return
// value (previously void — the daily timer only ever fire-and-forgot it, but
// the new "sync now" button needs to know what happened).
//
// index.ts is a large file with module-scope side effects (ipcMain.handle,
// app lifecycle), so — same as restart-cancel.test.cjs and settings-one-save
// .test.cjs — this reads the source rather than loading/executing it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');
const SRC = read('src/main/index.ts');

function handlerBody(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const i = SRC.indexOf(marker);
  assert.ok(i > 0, `handler for ${channel} not found`);
  const end = SRC.indexOf('\n});', i);
  return SRC.slice(i, end);
}

test('git:remoteUrl validates its argument and delegates to getRemoteUrl', () => {
  const body = handlerBody('git:remoteUrl');
  assert.match(body, /typeof cwd !== 'string'/, 'must reject a non-string cwd');
  assert.match(body, /getRemoteUrl\(cwd\)/, 'must delegate to the shared getRemoteUrl helper, not reimplement it');
  assert.match(SRC, /getRemoteUrl\s*\n\}\s*from '\.\/git'/s, 'getRemoteUrl must be imported from ./git');
});

test('knowledge:chooseVaultSubfolder requires a vault path before opening the dialog', () => {
  const body = handlerBody('knowledge:chooseVaultSubfolder');
  assert.match(body, /!vaultPath\.trim\(\)/, 'an empty vault path must be rejected before showOpenDialog runs');
  assert.match(body, /properties: \['openDirectory'\]/, 'must pick a directory, not a file');
  assert.match(body, /defaultPath: root/, 'the dialog must open rooted at the vault, so browsing starts inside it');
});

test('knowledge:chooseVaultSubfolder rejects a folder picked outside the vault', () => {
  const body = handlerBody('knowledge:chooseVaultSubfolder');
  // Same containment shape as runVaultSync's own check in knowledgeVaultSync.ts
  // (trailing sep, so `/vault-extra` cannot false-positive as inside `/vault`).
  assert.match(body, /picked !== root && !picked\.startsWith\(root \+ sep\)/,
    'must reject a pick outside the vault the same way runVaultSync validates vaultFolder');
  assert.match(body, /relativePath: picked === root \? '\.' : relative\(root, picked\)/,
    'on success it must hand back a path relative to the vault root, never an absolute one');
});

test('knowledge:vaultSyncNow reuses the exact same tick the daily timer fires', () => {
  const body = handlerBody('knowledge:vaultSyncNow');
  assert.match(body, /runVaultSyncTick\(\)/,
    '"sync now" and the daily timer must run through one code path, never two that can drift apart');
});

test('the three project-scoped kg handlers all gate on isMappedProjectSlug', () => {
  for (const channel of ['kg:statusForProject', 'kg:listForProject', 'kg:getForProject']) {
    const body = handlerBody(channel);
    assert.match(body, /isMappedProjectSlug\(slug\)/,
      `${channel} must check the slug against configured mappings — a raw string would let any caller read an arbitrary projects/<slug>/ directory`);
  }
});

test('isMappedProjectSlug reads the CONFIGURED mappings, not a renderer-supplied list', () => {
  const i = SRC.indexOf('function isMappedProjectSlug');
  assert.ok(i > 0, 'isMappedProjectSlug is gone');
  const body = SRC.slice(i, SRC.indexOf('\n}', i));
  assert.match(body, /readConfig\(\)\.knowledgeGraph\?\.vaultSync\?\.projects/,
    'must read from disk via readConfig(), not trust a caller-provided project list');
});

test('runVaultSyncTick returns a result instead of void', () => {
  const i = SRC.indexOf('async function runVaultSyncTick(');
  assert.ok(i > 0, 'runVaultSyncTick is gone');
  const body = SRC.slice(i, SRC.indexOf('\n}', SRC.indexOf('vaultSyncInFlight = false;', i)));
  assert.match(body, /Promise<VaultSyncTickResult>/, 'the daily-timer path silently swallowing this is fine; the type must still be honest');
  assert.match(body, /return \{ ran: false, error: 'a sync is already running' \}/,
    'a concurrent tick must say why nothing happened, not silently no-op');
  assert.match(body, /return \{ ran: false, error: 'vault sync is not enabled' \}/,
    'clicking "sync now" while the feature is off must say why, not silently no-op');
  assert.match(body, /return \{ ran: true, result \}/, 'a successful run must report its per-project result');
});
