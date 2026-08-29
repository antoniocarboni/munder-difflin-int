'use strict';

// IMPORTANT: `loadTs` (test/load-ts.cjs) caches a TypeScript module by resolved
// file path in its OWN Map, separate from Node's `require.cache` — so calling
// loadTs('src/main/config.ts') more than once in this process returns the SAME
// module instance (same closure state, including the jiraProjectsMigrationRan
// latch), exactly like test/config-write-notify.test.cjs's single top-level
// load. `node --test` runs the `test()` calls in ONE file sequentially in
// source order by default, so only the FIRST test below sees the latch at its
// initial `false` — that's intentional and is why it's written first. Every
// later test either pre-sets the persisted `jiraProjectsImported` flag in its
// own config.json (so it doesn't depend on the in-memory latch at all) or only
// asserts something true regardless of whether migration ran this time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-migration-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  // Mutable holder so each test can point getPath at its own subdirectory of
  // `userData` without needing a fresh module load.
  exports: { app: { getPath: () => currentUserDataDir } }
};
let currentUserDataDir = userData;

const { readConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function newProfileDir(name) {
  const dir = path.join(userData, name);
  fs.mkdirSync(dir, { recursive: true });
  currentUserDataDir = dir;
  return dir;
}

test('imports projects[] from hive/jira-map.json into jiraProjects on first read', () => {
  const dir = newProfileDir('first-read');
  const hiveDir = path.join(dir, 'hive');
  fs.mkdirSync(hiveDir, { recursive: true });
  fs.writeFileSync(path.join(hiveDir, 'jira-map.json'), JSON.stringify({
    claimFilter: { pollIntervalMs: 300000 },
    projects: [{ key: 'BURD', repo: '/r/burd', baseBranch: 'develop', agents: ['dwight'] }]
  }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ harnessHome: dir }));

  const cfg = readConfig();

  assert.deepEqual(cfg.jiraProjects, [
    { key: 'BURD', repo: '/r/burd', baseBranch: 'develop', agents: ['dwight'], enabled: true }
  ]);
  assert.equal(cfg.jiraProjectsImported, true);
});

test('does not re-import after the user deletes bindings on purpose', () => {
  const dir = newProfileDir('no-reimport');
  const hiveDir = path.join(dir, 'hive');
  fs.mkdirSync(hiveDir, { recursive: true });
  fs.writeFileSync(path.join(hiveDir, 'jira-map.json'), JSON.stringify({
    projects: [{ key: 'BURD', repo: '/r/burd', baseBranch: 'develop' }]
  }));
  // jiraProjectsImported: true is already PERSISTED here, so this assertion
  // holds regardless of the in-memory latch's state at this point in the file.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    harnessHome: dir, jiraProjects: [], jiraProjectsImported: true
  }));

  assert.deepEqual(readConfig().jiraProjects, []);
});

test('never mutates hive/jira-map.json', () => {
  const dir = newProfileDir('no-mutation');
  const hiveDir = path.join(dir, 'hive');
  fs.mkdirSync(hiveDir, { recursive: true });
  const mapPath = path.join(hiveDir, 'jira-map.json');
  const original = JSON.stringify({ projects: [{ key: 'BURD', repo: '/r', baseBranch: 'develop' }] });
  fs.writeFileSync(mapPath, original);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ harnessHome: dir }));

  readConfig();
  assert.equal(fs.readFileSync(mapPath, 'utf8'), original);
});

test('a config with no harnessHome (pre-onboarding) never crashes reading', () => {
  const dir = newProfileDir('no-harness-home');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ harnessHome: null }));
  assert.deepEqual(readConfig().jiraProjects, []);
});
