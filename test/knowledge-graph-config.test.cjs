'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-kg-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { writeConfig, readConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

writeConfig({});
readConfig();

test('knowledgeGraph.vaultSync defaults to disabled with an empty project list', () => {
  const cfg = readConfig();
  assert.equal(cfg.knowledgeGraph.enabled, false);
  assert.equal(cfg.knowledgeGraph.vaultSync.enabled, false);
  assert.deepEqual(cfg.knowledgeGraph.vaultSync.projects, []);
});

test('a vaultSync config round-trips through writeConfig/readConfig', () => {
  const mapping = { slug: 'burdastyle', repoOrigin: 'git@bitbucket.org:magenio/burdastyle.git', vaultFolder: '01-Projects/BurdaStyle' };
  writeConfig({
    knowledgeGraph: {
      enabled: true,
      vaultSync: { enabled: true, vaultPath: '~/Documents/Obsidian/SecondBrain', projects: [mapping] }
    }
  });
  const cfg = readConfig();
  assert.equal(cfg.knowledgeGraph.vaultSync.enabled, true);
  assert.equal(cfg.knowledgeGraph.vaultSync.vaultPath, '~/Documents/Obsidian/SecondBrain');
  assert.deepEqual(cfg.knowledgeGraph.vaultSync.projects, [mapping]);
});
