'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-kg-manager-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { KnowledgeManager } = loadTs('src/main/knowledge.ts');
const { writeConfig, readConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

// Settle config.ts's one-shot migration before any test reads it — same
// priming Task 1's config test and the existing config-write-notify.test.cjs
// already do; skipping it leaves the first read's shape undefined.
writeConfig({});
readConfig();

test('projectRoot is a subfolder of userData/knowledge/projects, distinct from the global root', () => {
  const km = new KnowledgeManager();
  const projRoot = km.projectRoot('burdastyle');
  assert.equal(projRoot, path.join(userData, 'knowledge', 'projects', 'burdastyle'));
  assert.notEqual(projRoot, km.root());
});

test('env() is empty when the feature is off (default)', () => {
  const km = new KnowledgeManager();
  assert.deepEqual(km.env(), {});
  assert.deepEqual(km.env('burdastyle'), {});
});

test('env(slug) points KG_ROOT at the project store when active; env() with no slug keeps the global store', () => {
  writeConfig({ knowledgeGraph: { enabled: true, vaultSync: { enabled: false, projects: [] } } });
  const km = new KnowledgeManager();
  const projectEnv = km.env('burdastyle');
  assert.equal(projectEnv.KG_ROOT, km.projectRoot('burdastyle'));
  assert.ok(projectEnv.KG_CLI);
  assert.ok(projectEnv.KG_CORE);

  const globalEnv = km.env();
  assert.equal(globalEnv.KG_ROOT, km.root());
  assert.notEqual(globalEnv.KG_ROOT, projectEnv.KG_ROOT);

  writeConfig({ knowledgeGraph: { enabled: false, vaultSync: { enabled: false, projects: [] } } });
});

test('ingestFileInto writes into the given root, not the global root; removeDocFrom removes it from that same root', () => {
  const km = new KnowledgeManager();
  const projRoot = km.projectRoot('burdastyle');
  fs.mkdirSync(projRoot, { recursive: true });
  const notePath = path.join(projRoot, '..', 'source-note.md');
  fs.writeFileSync(notePath, '# Refund policy\nCustomers get a full refund within 30 days.', 'utf8');

  const result = km.ingestFileInto(projRoot, notePath, { title: 'Refund policy', tags: ['obsidian', 'burdastyle'] });
  assert.ok(result.docId);
  assert.ok(result.chunkCount >= 1);
  assert.equal(fs.existsSync(path.join(projRoot, 'docs', result.docId)), true);
  assert.equal(fs.existsSync(path.join(km.root(), 'docs', result.docId)), false);

  const removed = km.removeDocFrom(projRoot, result.docId);
  assert.equal(removed, true);
  assert.equal(fs.existsSync(path.join(projRoot, 'docs', result.docId)), false);
});

// statusFor/listFor/getFrom back the Settings → Vault Sync panel's per-mapping
// "N documents indexed" + preview — same shape as their global counterparts
// (status/list/get), just pointed at a project's isolated store instead.
test('statusFor reads a project store no differently than status() reads the global one', () => {
  writeConfig({ knowledgeGraph: { enabled: true, vaultSync: { enabled: false, projects: [] } } });
  const km = new KnowledgeManager();

  assert.deepEqual(km.statusFor('never-synced'), { enabled: true, root: km.projectRoot('never-synced'), docCount: 0, chunkCount: 0, byModality: {} });

  const projRoot = km.projectRoot('acme');
  fs.mkdirSync(projRoot, { recursive: true });
  const notePath = path.join(projRoot, '..', 'acme-note.md');
  fs.writeFileSync(notePath, '# Onboarding\nStep one: set up your account.', 'utf8');
  km.ingestFileInto(projRoot, notePath, { title: 'Onboarding' });

  const status = km.statusFor('acme');
  assert.equal(status.docCount, 1);
  assert.equal(status.root, projRoot);

  writeConfig({ knowledgeGraph: { enabled: false, vaultSync: { enabled: false, projects: [] } } });
});

test('listFor and getFrom read the SAME project root ingestFileInto wrote to, isolated from other projects and the global store', () => {
  writeConfig({ knowledgeGraph: { enabled: true, vaultSync: { enabled: false, projects: [] } } });
  const km = new KnowledgeManager();

  const rootA = km.projectRoot('project-a');
  fs.mkdirSync(rootA, { recursive: true });
  const noteA = path.join(rootA, '..', 'a-note.md');
  fs.writeFileSync(noteA, '# Project A\nSome content unique to A.', 'utf8');
  const { docId } = km.ingestFileInto(rootA, noteA, { title: 'Project A' });

  assert.equal(km.listFor('project-b').length, 0, 'an unsynced project must read as empty, not throw');
  const listA = km.listFor('project-a');
  assert.equal(listA.length, 1);
  assert.equal(listA[0].title, 'Project A');

  const doc = km.getFrom('project-a', docId);
  assert.ok(doc);
  assert.match(doc.text, /unique to A/);

  // The doc must not be readable through a different project's root, or the
  // global root — that isolation is the entire point of a per-project store.
  assert.equal(km.getFrom('project-b', docId), null);
  assert.equal(km.get(docId), null);

  writeConfig({ knowledgeGraph: { enabled: false, vaultSync: { enabled: false, projects: [] } } });
});
