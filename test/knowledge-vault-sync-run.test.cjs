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
const { writeConfig, readConfig } = loadTs('src/main/config.ts');
const { list: kgList, getDoc: kgGetDoc } = require('../src/main/kg-core.cjs');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

// Settle config.ts's one-shot migration before any test reads it — same
// priming the other config-touching test files in this suite do.
writeConfig({});
readConfig();

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

// Regression coverage for review finding 1: `existsSync` (an access check)
// does not guarantee a subsequent `statSync` on the same path will succeed —
// the mapped folder can be deleted/renamed between the two calls (TOCTOU),
// plausible for a background job syncing against a live, user-edited vault.
// An unguarded `statSync` throwing there must not reject the whole
// `runVaultSync` call and skip every remaining project.
test('a statSync failure on an existing mapped path is a per-project error, not a thrown exception, and a sibling project still succeeds', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-statfail-'));
  const brokenFolder = path.join(vaultPath, '01-Projects', 'BurdaStyle');
  fs.mkdirSync(brokenFolder, { recursive: true });

  const goodFolder = path.join(vaultPath, '02-Projects', 'OtherProject');
  fs.mkdirSync(goodFolder, { recursive: true });
  fs.writeFileSync(path.join(goodFolder, 'note.md'), '# Note\nContent.', 'utf8');

  const originalStatSync = fs.statSync;
  fs.statSync = (p, ...rest) => {
    if (p === brokenFolder) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${brokenFolder}'`), { code: 'ENOENT' });
    }
    return originalStatSync(p, ...rest);
  };

  const km = new KnowledgeManager();
  const cfg = {
    enabled: true,
    vaultPath,
    projects: [
      { slug: 'burdastyle', repoOrigin: 'git@bitbucket.org:magenio/burdastyle.git', vaultFolder: '01-Projects/BurdaStyle' },
      { slug: 'otherproject', repoOrigin: 'git@bitbucket.org:magenio/otherproject.git', vaultFolder: '02-Projects/OtherProject' }
    ]
  };

  let result;
  try {
    result = await runVaultSync(cfg, km);
  } finally {
    fs.statSync = originalStatSync;
  }

  assert.equal(result.projects.length, 2);
  const broken = result.projects.find((p) => p.slug === 'burdastyle');
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0], /ENOENT|could not stat/i);

  const healthy = result.projects.find((p) => p.slug === 'otherproject');
  assert.equal(healthy.errors.length, 0);
  assert.equal(healthy.added, 1);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Regression coverage for review finding 2: a transient per-file failure
// (e.g. a momentary read error) on a file that was already tracked and is
// otherwise unchanged must not drop that file's sync-state entry. If it did,
// the next run would see no prevState for it, treat the unchanged file as
// brand-new, and re-ingest it without a prior removeDocFrom — a duplicate
// doc for content that never actually changed.
test('a transient read failure on an already-tracked, unchanged file does not create a duplicate doc on the next run', async () => {
  const { vaultPath, folder } = makeVault();
  // Unique filename: this project's persistent `.vault-sync-state.json` on
  // disk is shared across every test in this file (same slug, same shared
  // userData dir), so a name reused from an earlier test would collide with
  // that leftover state and make the "first run" assertion below flaky.
  const notePath = path.join(folder, 'transient-failure-note.md');
  fs.writeFileSync(notePath, '# Transient Failure Note\nStable content.', 'utf8');

  const km = new KnowledgeManager();
  const first = await runVaultSync(cfgFor(vaultPath), km);
  assert.equal(first.projects[0].added, 1);

  // The per-file read in runVaultSync uses node:fs/promises's readFile (not
  // fs.readFileSync — that stayed sync only for the one-shot sync-state file),
  // so the transient failure has to be injected there.
  const fsPromises = require('node:fs/promises');
  const originalReadFile = fsPromises.readFile;
  let failedOnce = false;
  fsPromises.readFile = (p, ...rest) => {
    if (p === notePath && !failedOnce) {
      failedOnce = true;
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${notePath}'`), { code: 'EACCES' }));
    }
    return originalReadFile(p, ...rest);
  };

  let second;
  try {
    second = await runVaultSync(cfgFor(vaultPath), km);
  } finally {
    fsPromises.readFile = originalReadFile;
  }

  assert.equal(second.projects[0].errors.length, 1);
  assert.match(second.projects[0].errors[0], /EACCES/i);
  assert.equal(second.projects[0].added, 0);
  assert.equal(second.projects[0].updated, 0);

  // The recovery run must see the file's state as carried-forward/unchanged,
  // not absent — otherwise it would be (wrongly) treated as brand-new.
  const third = await runVaultSync(cfgFor(vaultPath), km);
  assert.equal(third.projects[0].added, 0, 'the recovery run must not treat the unchanged file as brand-new');
  assert.equal(third.projects[0].updated, 0);

  const list = require('../src/main/kg-core.cjs').list(km.projectRoot('burdastyle'));
  assert.equal(list.length, 1, 'no duplicate doc for the file that had a transient read failure');

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Regression coverage for review finding 3: cross-project isolation is the
// entire point of this feature. Nothing in the existing tests above (all
// single-mapping) proves that syncing TWO mapped projects keeps their notes
// in genuinely separate stores rather than a shared/filtered one.
test('two mapped projects end up in fully isolated stores — cross-project isolation', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-isolation-'));
  const folderA = path.join(vaultPath, '01-Projects', 'ProjectA');
  const folderB = path.join(vaultPath, '01-Projects', 'ProjectB');
  fs.mkdirSync(folderA, { recursive: true });
  fs.mkdirSync(folderB, { recursive: true });
  fs.writeFileSync(path.join(folderA, 'note.md'), '# Project A Note\nDetails mentioning alpha-only-content.', 'utf8');
  fs.writeFileSync(path.join(folderB, 'note.md'), '# Project B Note\nDetails mentioning bravo-only-content.', 'utf8');

  const cfg = {
    enabled: true,
    vaultPath,
    projects: [
      { slug: 'project-a', repoOrigin: 'git@bitbucket.org:magenio/project-a.git', vaultFolder: '01-Projects/ProjectA' },
      { slug: 'project-b', repoOrigin: 'git@bitbucket.org:magenio/project-b.git', vaultFolder: '01-Projects/ProjectB' }
    ]
  };

  const km = new KnowledgeManager();
  const result = await runVaultSync(cfg, km);
  assert.equal(result.projects.length, 2);
  for (const p of result.projects) assert.equal(p.errors.length, 0, `unexpected errors for ${p.slug}: ${p.errors.join('; ')}`);

  const rootA = km.projectRoot('project-a');
  const rootB = km.projectRoot('project-b');
  assert.notEqual(rootA, rootB);

  const listA = kgList(rootA);
  const listB = kgList(rootB);
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);

  const textA = listA.map((m) => kgGetDoc(rootA, m.id).text).join('\n');
  const textB = listB.map((m) => kgGetDoc(rootB, m.id).text).join('\n');
  assert.match(textA, /alpha-only-content/);
  assert.doesNotMatch(textA, /bravo-only-content/, "project A's store must not contain project B's content");
  assert.match(textB, /bravo-only-content/);
  assert.doesNotMatch(textB, /alpha-only-content/, "project B's store must not contain project A's content");

  // env(slug) is the mechanism that actually hands an agent its KG_ROOT —
  // confirm the two projects never resolve to the same one.
  writeConfig({ knowledgeGraph: { enabled: true, vaultSync: { enabled: false, projects: [] } } });
  const envKm = new KnowledgeManager();
  assert.notEqual(envKm.env('project-a').KG_ROOT, envKm.env('project-b').KG_ROOT);
  writeConfig({ knowledgeGraph: { enabled: false, vaultSync: { enabled: false, projects: [] } } });

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Regression coverage for review finding 3: a duplicate slug across two
// mappings must never let either one touch the shared store — not to ingest,
// not to prune — since which mapping the user actually intended can't be
// known.
test('a duplicate slug across two mappings skips both entirely — no ingest, no prune', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-dupslug-'));
  const folderA = path.join(vaultPath, '01-Projects', 'ProjectA');
  const folderC = path.join(vaultPath, '01-Projects', 'ProjectC');
  fs.mkdirSync(folderA, { recursive: true });
  fs.mkdirSync(folderC, { recursive: true });
  fs.writeFileSync(path.join(folderA, 'note.md'), '# Project A Note\nContent A.', 'utf8');
  fs.writeFileSync(path.join(folderC, 'note.md'), '# Project C Note\nContent C.', 'utf8');

  const km = new KnowledgeManager();
  const sharedSlug = 'shared-slug';

  // First, legitimately seed the shared store via a single, non-duplicated
  // mapping — this is the pre-existing content that must NOT be pruned once
  // the slug becomes duplicated below.
  const seedResult = await runVaultSync({
    enabled: true,
    vaultPath,
    projects: [{ slug: sharedSlug, repoOrigin: 'git@bitbucket.org:magenio/project-a.git', vaultFolder: '01-Projects/ProjectA' }]
  }, km);
  assert.equal(seedResult.projects[0].errors.length, 0);
  assert.equal(seedResult.projects[0].added, 1);
  assert.equal(kgList(km.projectRoot(sharedSlug)).length, 1);

  // Now introduce a second mapping that accidentally reuses the same slug.
  const dupCfg = {
    enabled: true,
    vaultPath,
    projects: [
      { slug: sharedSlug, repoOrigin: 'git@bitbucket.org:magenio/project-a.git', vaultFolder: '01-Projects/ProjectA' },
      { slug: sharedSlug, repoOrigin: 'git@bitbucket.org:magenio/project-c.git', vaultFolder: '01-Projects/ProjectC' }
    ]
  };
  const result = await runVaultSync(dupCfg, km);

  assert.equal(result.projects.length, 2);
  for (const p of result.projects) {
    assert.equal(p.errors.length, 1, `${p.slug} should be recorded as errored`);
    assert.match(p.errors[0], /duplicate slug/i);
    assert.equal(p.added, 0);
    assert.equal(p.updated, 0);
    assert.equal(p.removed, 0);
  }

  // The pre-existing doc must survive untouched — neither mapping was
  // allowed to prune it, and neither ingested project C's note into it.
  const finalList = kgList(km.projectRoot(sharedSlug));
  assert.equal(finalList.length, 1, 'the shared store must be untouched — no ingest, no prune');
  assert.match(kgGetDoc(km.projectRoot(sharedSlug), finalList[0].id).text, /Content A/);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});
