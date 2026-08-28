'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { resolveProjectForCwd } = loadTs('src/main/knowledgeVaultSync.ts');

function initRepo(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resolve-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
}

const MAPPINGS = [
  { slug: 'burdastyle', repoOrigin: 'git@bitbucket.org:magenio/burdastyle.git', vaultFolder: '01-Projects/BurdaStyle' },
  { slug: 'bravifarmacie', repoOrigin: 'git@bitbucket.org:magenio/bravifarmacie.git', vaultFolder: '01-Projects/Bravi Farmacie' }
];

test('resolves a cwd whose origin matches one mapping', async () => {
  const dir = initRepo('git@bitbucket.org:magenio/burdastyle.git');
  const m = await resolveProjectForCwd(dir, MAPPINGS);
  assert.equal(m.slug, 'burdastyle');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns null when the origin matches no mapping', async () => {
  const dir = initRepo('git@bitbucket.org:magenio/some-other-repo.git');
  const m = await resolveProjectForCwd(dir, MAPPINGS);
  assert.equal(m, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns null for a non-git cwd, never throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resolve-notrepo-'));
  const m = await resolveProjectForCwd(dir, MAPPINGS);
  assert.equal(m, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns null against an empty mapping list', async () => {
  const dir = initRepo('git@bitbucket.org:magenio/burdastyle.git');
  const m = await resolveProjectForCwd(dir, []);
  assert.equal(m, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
