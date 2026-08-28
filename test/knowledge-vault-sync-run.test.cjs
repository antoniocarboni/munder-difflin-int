'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-sync-run-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { KnowledgeManager } = loadTs('src/main/knowledge.ts');
const { runVaultSync } = loadTs('src/main/knowledgeVaultSync.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function makeVault() {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-'));
  const folder = path.join(vaultPath, '01-Projects', 'BurdaStyle');
  fs.mkdirSync(folder, { recursive: true });
  return { vaultPath, folder };
}

function cfgFor(vaultPath) {
  return {
    enabled: true,
    vaultPath,
    projects: [{ slug: 'burdastyle', repoOrigin: 'git@bitbucket.org:magenio/burdastyle.git', vaultFolder: '01-Projects/BurdaStyle' }]
  };
}

test('ingests new markdown notes on first run', async () => {
  const { vaultPath, folder } = makeVault();
  fs.writeFileSync(path.join(folder, 'note-a.md'), '# Note A\nContent about refunds.', 'utf8');
  fs.writeFileSync(path.join(folder, 'note-b.md'), '# Note B\nContent about shipping.', 'utf8');

  const km = new KnowledgeManager();
  const result = await runVaultSync(cfgFor(vaultPath), km);

  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].slug, 'burdastyle');
  assert.equal(result.projects[0].added, 2);
  assert.equal(result.projects[0].errors.length, 0);

  const list = require('../src/main/kg-core.cjs').list(km.projectRoot('burdastyle'));
  assert.equal(list.length, 2);
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test('a second run with no changes ingests nothing new', async () => {
  const { vaultPath, folder } = makeVault();
  fs.writeFileSync(path.join(folder, 'note-a.md'), '# Note A\nContent.', 'utf8');
  const km = new KnowledgeManager();
  await runVaultSync(cfgFor(vaultPath), km);
  const second = await runVaultSync(cfgFor(vaultPath), km);
  assert.equal(second.projects[0].added, 0);
  assert.equal(second.projects[0].updated, 0);
  assert.equal(second.projects[0].removed, 0);
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test('a modified note is re-ingested and the old copy is removed', async () => {
  const { vaultPath, folder } = makeVault();
  const notePath = path.join(folder, 'note-a.md');
  fs.writeFileSync(notePath, '# Note A\nOriginal content.', 'utf8');
  const km = new KnowledgeManager();
  await runVaultSync(cfgFor(vaultPath), km);

  fs.writeFileSync(notePath, '# Note A\nCompletely different content now.', 'utf8');
  const result = await runVaultSync(cfgFor(vaultPath), km);
  assert.equal(result.projects[0].updated, 1);
  assert.equal(result.projects[0].added, 0);

  const list = require('../src/main/kg-core.cjs').list(km.projectRoot('burdastyle'));
  assert.equal(list.length, 1, 'the edited note must not accumulate a duplicate doc');
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test('a deleted note is pruned from the store', async () => {
  const { vaultPath, folder } = makeVault();
  const notePath = path.join(folder, 'note-a.md');
  fs.writeFileSync(notePath, '# Note A\nContent.', 'utf8');
  const km = new KnowledgeManager();
  await runVaultSync(cfgFor(vaultPath), km);

  fs.rmSync(notePath);
  const result = await runVaultSync(cfgFor(vaultPath), km);
  assert.equal(result.projects[0].removed, 1);

  const list = require('../src/main/kg-core.cjs').list(km.projectRoot('burdastyle'));
  assert.equal(list.length, 0);
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test('a missing mapped folder is a per-project error, not a thrown exception', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-empty-'));
  const km = new KnowledgeManager();
  const result = await runVaultSync(cfgFor(vaultPath), km);
  assert.equal(result.projects[0].errors.length, 1);
  assert.match(result.projects[0].errors[0], /not found|does not exist|ENOENT/i);
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test('non-markdown files in the mapped folder are ignored', async () => {
  const { vaultPath, folder } = makeVault();
  fs.writeFileSync(path.join(folder, 'note-a.md'), '# Note A\nContent.', 'utf8');
  fs.writeFileSync(path.join(folder, 'attachment.png'), Buffer.from([0, 1, 2]));
  const km = new KnowledgeManager();
  const result = await runVaultSync(cfgFor(vaultPath), km);
  assert.equal(result.projects[0].added, 1);
  fs.rmSync(vaultPath, { recursive: true, force: true });
});
