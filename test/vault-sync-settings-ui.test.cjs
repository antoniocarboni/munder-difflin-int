'use strict';

// Settings → Memory & Knowledge → Vault Sync: the panel that replaced
// hand-editing config.json's knowledgeGraph.vaultSync. SettingsModal.tsx has
// no mounted-component tests (see settings-one-save.test.cjs's own note on
// why) — this reads the source, the same house pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MODAL = read('src/renderer/src/components/SettingsModal.tsx');
const EN = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));

test('turning Vault Sync on also turns Knowledge Graph on — the sync is a no-op without it', () => {
  const i = MODAL.indexOf('const toggleVaultSync');
  assert.ok(i > 0, 'toggleVaultSync is gone');
  const body = MODAL.slice(i, MODAL.indexOf('\n  };', i));
  assert.match(body, /if \(next && !kgEnabled\) setKgEnabled\(true\)/,
    'enabling vault sync while Knowledge Graph is off must flip it on too, not leave a toggle that silently does nothing');
});

test('the project picker resolves repoOrigin automatically — no field for pasting a git URL by hand', () => {
  assert.ok(!/placeholder=\{t\('settings\.memory\.vault.*[Oo]rigin/.test(MODAL),
    'no raw origin-entry field should exist');
  assert.match(MODAL, /window\.cth\.gitRemoteUrl\(repoPath\)/,
    'the origin must be resolved from the picked project, not typed by the operator');
});

test('the vault subfolder picker never asks the operator to compute a relative path', () => {
  assert.match(MODAL, /window\.cth\.chooseVaultSubfolder\(vaultPath\)/,
    'must use the dedicated vault-rooted picker, not the generic chooseFolder + manual path math');
  assert.doesNotMatch(MODAL, /vaultFolder.*relative\(/s,
    'path.relative has no equivalent in the renderer (context isolation) — this must come pre-computed from main');
});

test('slugs are auto-derived and de-duplicated, not required typing', () => {
  assert.match(MODAL, /slugifyProjectName\(basenamePath\(repoPath\)\)/);
  assert.match(MODAL, /dedupeSlug\(/);
});

test('"sync now" is disabled while there are unsaved changes', () => {
  const i = MODAL.indexOf("t('settings.memory.vaultSyncNow')");
  assert.ok(i > 0, 'the sync-now button label is gone');
  const buttonStart = MODAL.lastIndexOf('<PixelButton', i);
  const button = MODAL.slice(buttonStart, i);
  assert.match(button, /disabled=\{vsSyncBusy \|\| dirty\}/,
    'clicking sync-now with staged-but-unsaved edits would sync against stale config on disk');
});

test('"sync now" and the daily timer both resolve through window.cth.vaultSyncNow', () => {
  assert.match(MODAL, /window\.cth\.vaultSyncNow\(\)/);
});

test('doc counts refresh automatically after a sync, not only on manual reopen', () => {
  const i = MODAL.indexOf('const syncVaultNow');
  assert.ok(i > 0, 'syncVaultNow is gone');
  const body = MODAL.slice(i, MODAL.indexOf('\n  };', i));
  assert.match(body, /refreshVsDocCounts\(\)/, 'a successful "sync now" must refresh the doc counts shown per mapping');
});

test('the doc list and preview are project-scoped, never the global kg calls', () => {
  const listStart = MODAL.indexOf('const toggleVsDocs');
  const previewStart = MODAL.indexOf('const previewVsDoc');
  assert.ok(listStart > 0 && previewStart > 0, 'toggleVsDocs/previewVsDoc are gone');
  const listBody = MODAL.slice(listStart, MODAL.indexOf('\n  };', listStart));
  const previewBody = MODAL.slice(previewStart, MODAL.indexOf('\n  };', previewStart));
  assert.match(listBody, /window\.cth\.kgListForProject\(/, 'must use the project-scoped list, not the global kg:list');
  assert.match(previewBody, /window\.cth\.kgGetForProject\(/, 'must use the project-scoped get, not the global kg:get');
});

test('every settings.memory.vault* key referenced in the modal exists in en.json', () => {
  const used = [...MODAL.matchAll(/t\('settings\.memory\.(vault[A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(used.length > 5, `sanity: expected several vault* keys, found ${used.length}`);
  const missing = used.filter((k) => !(k in EN.settings.memory));
  assert.deepEqual(missing, [], 'a referenced translation key does not exist in en.json');
});
