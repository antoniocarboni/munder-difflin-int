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
