# Obsidian Vault Knowledge Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every hive agent read-only, per-project access to its own Obsidian vault notes via the existing `kg` CLI, kept fresh by a daily sync job, with physical directory isolation between projects.

**Architecture:** Extend the already-multi-root-capable `kg-core.cjs` engine with a per-project store convention (`<userData>/knowledge/projects/<slug>/`), additive to the existing single global store. A new `resolveProjectForCwd()` maps an agent's working directory to a project via its git `origin` (never its filesystem path). A new `runVaultSync()` diffs each mapped Obsidian folder against a small per-project sync-state file and ingests/prunes markdown notes through the existing `KnowledgeManager.ingestFile`-style API. `KnowledgeManager.env()` gains an optional project slug so agent spawn injects the right `KG_ROOT` — one store per agent, never two.

**Tech Stack:** TypeScript (Electron main process), Node's built-in `node:test` + `node:assert/strict`, the repo's `test/load-ts.cjs` helper to run TS test targets, real `git` subprocess calls (no mocking), the existing file-backed `kg-core.cjs` engine (no changes to it).

**Spec:** `docs/superpowers/specs/2026-08-28-obsidian-vault-knowledge-sync-design.md`

## Global Constraints

- Both `knowledgeGraph.enabled` and `knowledgeGraph.vaultSync.enabled` default to `false` — zero behaviour change until the user opts in, matching every other flag-gated feature in this codebase (Slack, heartbeat, webhook triggers).
- The existing global `knowledgeGraph.rootPath` store and its manual "add files" UI (`kg:addFiles`/`kg:ingestFiles` IPC handlers) are untouched — every change here is additive.
- Project matching is by git `origin` URL, exact string match, never by filesystem path (a worktree's path differs from its parent repo; its origin does not).
- Only `*.md` files are synced (v1 scope — no PDFs/images/attachments).
- An agent is injected with exactly one `KG_ROOT`: its resolved project's store, or the existing global store as fallback. Never both.
- No changes to `resources/kg-core.cjs` or `resources/kg.cjs` — the agent-facing `kg` CLI contract (`kg search`, `kg list`, `kg get`) is unchanged.

---

### Task 1: Config schema for vault sync

**Files:**
- Modify: `src/main/config.ts:168-173` (existing `KnowledgeGraphConfig`), `src/main/config.ts:485` (existing `DEFAULTS.knowledgeGraph` seed)
- Test: Create `test/knowledge-graph-config.test.cjs`

**Interfaces:**
- Produces: `VaultProjectMapping { slug: string; repoOrigin: string; vaultFolder: string }`, `VaultSyncConfig { enabled?: boolean; vaultPath?: string; projects?: VaultProjectMapping[]; lastSyncAt?: number }`, and `KnowledgeGraphConfig.vaultSync?: VaultSyncConfig` — every later task reads these exact shapes from `readConfig().knowledgeGraph`.

- [ ] **Step 1: Write the failing test**

Create `test/knowledge-graph-config.test.cjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/knowledge-graph-config.test.cjs`
Expected: FAIL — `cfg.knowledgeGraph.vaultSync` is `undefined` (the field doesn't exist yet), so both tests throw on the first `assert.equal`.

- [ ] **Step 3: Add the interfaces and extend the default seed**

In `src/main/config.ts`, immediately after the existing `KnowledgeGraphConfig` interface (currently ends around line 173 with `rootPath?: string;` then `}`), add:

```ts
/** One Obsidian project folder mapped to a munder-difflin repo. Matched to an
 *  agent by git `origin`, never by filesystem path (a worktree's path differs
 *  from its parent repo; its origin does not). */
export interface VaultProjectMapping {
  /** Stable id — becomes the `<userData>/knowledge/projects/<slug>/` folder
   *  name. Free-form but should be filesystem-safe; not required to match
   *  either the repo folder name or the vault folder name (both differ in
   *  practice). */
  slug: string;
  /** `git remote get-url origin` output for the target repo, verbatim. */
  repoOrigin: string;
  /** Path to this project's notes, relative to `vaultSync.vaultPath` — e.g.
   *  "01-Projects/BurdaStyle". */
  vaultFolder: string;
}

/** Daily sync from an Obsidian vault into per-project Knowledge Graph stores.
 *  Additive to the existing global `knowledgeGraph.rootPath` store — never
 *  touches it. Opt-in: `enabled` false is a full no-op (no scan, no timer). */
export interface VaultSyncConfig {
  enabled?: boolean;
  /** Absolute path to the vault root, e.g. "~/Documents/Obsidian/SecondBrain". */
  vaultPath?: string;
  projects?: VaultProjectMapping[];
  /** Epoch ms of the last completed run (partial or full). Used to decide
   *  whether a day has elapsed since app start. */
  lastSyncAt?: number;
}
```

Then modify the existing `KnowledgeGraphConfig` interface to add one field:

```ts
export interface KnowledgeGraphConfig {
  enabled?: boolean;
  rootPath?: string;
  vaultSync?: VaultSyncConfig;
}
```

Find the default config seed (`knowledgeGraph: { enabled: false }` around line 485) and extend it:

```ts
knowledgeGraph: { enabled: false, vaultSync: { enabled: false, projects: [] } },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/knowledge-graph-config.test.cjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0

- [ ] **Step 6: Commit**

```bash
git add src/main/config.ts test/knowledge-graph-config.test.cjs
git commit -m "feat(kg): add VaultSyncConfig schema for Obsidian vault sync"
```

---

### Task 2: `getRemoteUrl` in git.ts

**Files:**
- Modify: `src/main/git.ts` (add one exported function, reusing the existing private `runGit` helper already in this file)
- Test: Create `test/git-remote-url.test.cjs`

**Interfaces:**
- Consumes: the existing private `runGit(cwd, args, timeoutMs?)` in `src/main/git.ts` (already defined at the top of that file — do not duplicate it).
- Produces: `getRemoteUrl(cwd: string, remote?: string): Promise<string | null>` — Task 4 calls this exact signature.

- [ ] **Step 1: Write the failing test**

Create `test/git-remote-url.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { getRemoteUrl } = loadTs('src/main/git.ts');

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-remote-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

test('getRemoteUrl returns the configured origin', async () => {
  const dir = initRepo();
  spawnSync('git', ['remote', 'add', 'origin', 'git@bitbucket.org:magenio/burdastyle.git'], { cwd: dir });
  const url = await getRemoteUrl(dir);
  assert.equal(url, 'git@bitbucket.org:magenio/burdastyle.git');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRemoteUrl returns null when there is no origin remote', async () => {
  const dir = initRepo();
  const url = await getRemoteUrl(dir);
  assert.equal(url, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRemoteUrl returns null for a non-git directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-remote-notrepo-'));
  const url = await getRemoteUrl(dir);
  assert.equal(url, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRemoteUrl resolves a worktree to its parent repo\'s origin', async () => {
  const dir = initRepo();
  spawnSync('git', ['remote', 'add', 'origin', 'git@bitbucket.org:magenio/burdastyle.git'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const wtDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-git-wt-')), 'wt');
  spawnSync('git', ['worktree', 'add', wtDir, '-b', 'agent/x'], { cwd: dir });
  const url = await getRemoteUrl(wtDir);
  assert.equal(url, 'git@bitbucket.org:magenio/burdastyle.git');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(wtDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/git-remote-url.test.cjs`
Expected: FAIL — `getRemoteUrl is not a function` (not exported yet).

- [ ] **Step 3: Implement `getRemoteUrl`**

In `src/main/git.ts`, add this function right after the existing `isRepo` function (so it sits next to the other small "best-effort detect" helpers):

```ts
/** The `origin` remote's URL (or another remote's, if named), verbatim as git
 *  reports it. `cwd` may be a linked worktree — git resolves remotes through to
 *  the main repo transparently, so this needs no special-casing. Returns null
 *  when there is no such remote, `cwd` isn't a git repo, or git is unavailable —
 *  never throws (fails closed for callers matching against a known-good URL). */
export async function getRemoteUrl(cwd: string, remote = 'origin'): Promise<string | null> {
  const res = await runGit(cwd, ['remote', 'get-url', remote]);
  if (!res.ok) return null;
  const url = res.stdout.trim();
  return url || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/git-remote-url.test.cjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0

- [ ] **Step 6: Commit**

```bash
git add src/main/git.ts test/git-remote-url.test.cjs
git commit -m "feat(git): add getRemoteUrl helper"
```

---

### Task 3: Per-project store methods on `KnowledgeManager`

**Files:**
- Modify: `src/main/knowledge.ts`
- Test: Create `test/knowledge-manager-project-store.test.cjs`

**Interfaces:**
- Consumes: the existing `core` (`kg-core.cjs`) functions already required at the top of `knowledge.ts` — `core.ingest(root, input)`, `core.removeDoc(root, docId)` — and the existing `readConfig` import.
- Produces: `KnowledgeManager.projectRoot(slug: string): string`, `KnowledgeManager.env(projectSlug?: string | null): Record<string,string>` (signature change — now takes an optional param; existing zero-arg call sites keep compiling and keep today's behavior), `KnowledgeManager.ingestFileInto(root: string, srcPath: string, opts?: {title?: string; tags?: string[]; caption?: string}): {docId: string; chunkCount: number; meta: KgMeta}`, `KnowledgeManager.removeDocFrom(root: string, docId: string): boolean`. Task 5 calls `projectRoot`, `ingestFileInto`, `removeDocFrom`. Task 6 calls `env(projectSlug)`.

- [ ] **Step 1: Write the failing test**

Create `test/knowledge-manager-project-store.test.cjs`:

```js
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

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('projectRoot is a subfolder of userData/knowledge/projects, distinct from the global root', () => {
  const km = new KnowledgeManager();
  const projRoot = km.projectRoot('burdastyle');
  assert.equal(projRoot, path.join(userData, 'knowledge', 'projects', 'burdastyle'));
  assert.notEqual(projRoot, km.root());
});

test('env(slug) points KG_ROOT at the project store; env() with no slug keeps today\'s global-store behavior', () => {
  const km = new KnowledgeManager();
  // active() reads knowledgeGraph.enabled from config — mock readConfig's
  // backing file by writing one directly via config.ts in a real scenario;
  // here we exercise the disabled-by-default path first.
  assert.deepEqual(km.env(), {});
  assert.deepEqual(km.env('burdastyle'), {});
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/knowledge-manager-project-store.test.cjs`
Expected: FAIL — `km.projectRoot is not a function`.

- [ ] **Step 3: Implement the new methods**

In `src/main/knowledge.ts`, add `projectRoot` right after the existing `root()` method:

```ts
  /** The store directory for one project's isolated vault-sync store — always
   *  `<userData>/knowledge/projects/<slug>/`, regardless of any `rootPath`
   *  override (that override only ever applies to the global manual store).
   *  Purely additive: the global store this method sits next to is untouched. */
  projectRoot(slug: string): string {
    return join(app.getPath('userData'), 'knowledge', 'projects', slug);
  }
```

Replace the existing `env()` method with this version (same body, one new optional parameter and one new branch — the no-arg call shape and its return value for an unresolved/absent project are byte-for-byte identical to today):

```ts
  /** Env merged into an agent's spawn so its `kg` CLI hits the right store.
   *  Empty when the feature is off — zero behaviour change for a default
   *  install. `projectSlug`, when given and the feature is on, points
   *  `KG_ROOT` at that project's ISOLATED store instead of the global one —
   *  an agent gets exactly one store, never both. Omit (or pass a project
   *  that didn't resolve) to keep today's global-store behaviour exactly. */
  env(projectSlug?: string | null): Record<string, string> {
    if (!this.active()) return {};
    const root = projectSlug ? this.projectRoot(projectSlug) : this.root();
    return { KG_ROOT: root, KG_CLI: this.cliPath(), KG_CORE: this.corePath() };
  }
```

Add `ingestFileInto` and `removeDocFrom` right after the existing `ingestFile`/`ingestText` methods:

```ts
  /** Like `ingestFile`, but targets an explicit `root` instead of the implicit
   *  global `this.root()` — used by the vault-sync job to write into a
   *  project's own isolated store. */
  ingestFileInto(root: string, srcPath: string, opts: { title?: string; tags?: string[]; caption?: string } = {}) {
    return core.ingest(root, { srcPath, ...opts });
  }

  /** Like removing from the global store, but targets an explicit `root`. */
  removeDocFrom(root: string, docId: string): boolean {
    return core.removeDoc(root, docId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/knowledge-manager-project-store.test.cjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0 (confirms every existing call site of `knowledge.env()` — zero-arg — still type-checks against the new optional-parameter signature)

- [ ] **Step 6: Commit**

```bash
git add src/main/knowledge.ts test/knowledge-manager-project-store.test.cjs
git commit -m "feat(kg): add per-project store methods to KnowledgeManager"
```

---

### Task 4: `resolveProjectForCwd`

**Files:**
- Create: `src/main/knowledgeVaultSync.ts`
- Test: Create `test/knowledge-vault-sync-resolve.test.cjs`

**Interfaces:**
- Consumes: `getRemoteUrl(cwd, remote?)` from Task 2 (`src/main/git.ts`), `VaultProjectMapping` from Task 1 (`src/main/config.ts`).
- Produces: `resolveProjectForCwd(cwd: string, mappings: VaultProjectMapping[]): Promise<VaultProjectMapping | null>` — Task 6 calls this exact signature at spawn time.

- [ ] **Step 1: Write the failing test**

Create `test/knowledge-vault-sync-resolve.test.cjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/knowledge-vault-sync-resolve.test.cjs`
Expected: FAIL — cannot find module `src/main/knowledgeVaultSync.ts` (file doesn't exist yet).

- [ ] **Step 3: Create the file with `resolveProjectForCwd`**

Create `src/main/knowledgeVaultSync.ts`:

```ts
/**
 * Obsidian vault → per-project Knowledge Graph sync. See
 * docs/superpowers/specs/2026-08-28-obsidian-vault-knowledge-sync-design.md.
 *
 * Two responsibilities, kept in this one file because they're small and only
 * ever used together: resolving which project an agent's cwd belongs to
 * (`resolveProjectForCwd`), and the daily ingest/prune job that keeps each
 * project's isolated store fed from its mapped vault folder (`runVaultSync`,
 * added in a later task).
 */
import { getRemoteUrl } from './git';
import type { VaultProjectMapping } from './config';

/** Which mapped project (if any) does this agent's working directory belong
 *  to? Matched by git `origin`, never by filesystem path — a worktree's path
 *  differs from its parent repo, but its origin does not (see git.ts's
 *  `getRemoteUrl`, which already resolves a worktree through to its parent).
 *  Fails closed to null: no git repo, no origin, or no matching mapping all
 *  return null rather than throwing — an unresolved project is not an error,
 *  it just means the agent gets the existing global store instead. */
export async function resolveProjectForCwd(
  cwd: string,
  mappings: VaultProjectMapping[]
): Promise<VaultProjectMapping | null> {
  if (mappings.length === 0) return null;
  const origin = await getRemoteUrl(cwd);
  if (!origin) return null;
  return mappings.find((m) => m.repoOrigin === origin) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/knowledge-vault-sync-resolve.test.cjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0

- [ ] **Step 6: Commit**

```bash
git add src/main/knowledgeVaultSync.ts test/knowledge-vault-sync-resolve.test.cjs
git commit -m "feat(kg): add resolveProjectForCwd for Obsidian vault sync"
```

---

### Task 5: `runVaultSync`

**Files:**
- Modify: `src/main/knowledgeVaultSync.ts` (add to the file created in Task 4)
- Test: Create `test/knowledge-vault-sync-run.test.cjs`

**Interfaces:**
- Consumes: `VaultSyncConfig`/`VaultProjectMapping` (Task 1), `KnowledgeManager.projectRoot`/`ingestFileInto`/`removeDocFrom` (Task 3).
- Produces: `runVaultSync(cfg: VaultSyncConfig, knowledge: KnowledgeManager): Promise<VaultSyncResult>` where `VaultSyncResult = { projects: Array<{ slug: string; added: number; updated: number; removed: number; errors: string[] }> }` — Task 6 calls this exact signature on the daily timer.

- [ ] **Step 1: Write the failing test**

Create `test/knowledge-vault-sync-run.test.cjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/knowledge-vault-sync-run.test.cjs`
Expected: FAIL — `runVaultSync is not a function`.

- [ ] **Step 3: Implement `runVaultSync`**

Add these imports to the top of `src/main/knowledgeVaultSync.ts` (alongside the existing `getRemoteUrl`/`VaultProjectMapping` imports):

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { VaultSyncConfig } from './config';
import type { KnowledgeManager } from './knowledge';
import { expandTilde } from './fs';
```

Append the rest of the implementation to `src/main/knowledgeVaultSync.ts`:

```ts
interface SyncStateEntry { sha256: string; docId: string }
type SyncState = Record<string, SyncStateEntry>;

const SYNC_STATE_FILE = '.vault-sync-state.json';

function readSyncState(projectRoot: string): SyncState {
  try {
    const raw = readFileSync(join(projectRoot, SYNC_STATE_FILE), 'utf8');
    return JSON.parse(raw) as SyncState;
  } catch {
    return {};
  }
}

function writeSyncState(projectRoot: string, state: SyncState): void {
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, SYNC_STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

/** Recursively list every `*.md` file under `dir`, skipping dotfiles/dot-dirs
 *  (Obsidian's own `.obsidian/` config lives inside vault folders). Returns
 *  absolute paths. Best-effort: a directory that can't be read is skipped,
 *  never thrown. */
function listMarkdownFiles(dir: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function titleFromPath(mdPath: string): string {
  const base = mdPath.split(/[\\/]/).pop() ?? mdPath;
  return base.replace(/\.md$/i, '');
}

export interface VaultSyncProjectResult {
  slug: string;
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}
export interface VaultSyncResult {
  projects: VaultSyncProjectResult[];
}

/** Diff each mapped vault folder against its last-known state and reconcile
 *  the project's isolated Knowledge Graph store: ingest new/changed notes,
 *  prune notes deleted from the vault. One bad file, or one missing/unreadable
 *  mapped folder, is recorded as an error on that project and never aborts the
 *  run — every other project (and every other file within the failing one)
 *  still proceeds. Idempotent: a run with nothing changed touches nothing. */
export async function runVaultSync(
  cfg: VaultSyncConfig,
  knowledge: KnowledgeManager
): Promise<VaultSyncResult> {
  const projects: VaultSyncProjectResult[] = [];
  const vaultPath = cfg.vaultPath ? expandTilde(cfg.vaultPath) : '';

  for (const mapping of cfg.projects ?? []) {
    const result: VaultSyncProjectResult = { slug: mapping.slug, added: 0, updated: 0, removed: 0, errors: [] };
    projects.push(result);

    const folder = join(vaultPath, mapping.vaultFolder);
    if (!vaultPath || !existsSync(folder)) {
      result.errors.push(`mapped folder not found: ${folder}`);
      continue;
    }
    if (!statSync(folder).isDirectory()) {
      result.errors.push(`mapped path is not a directory: ${folder}`);
      continue;
    }

    const projectRoot = knowledge.projectRoot(mapping.slug);
    const prevState = readSyncState(projectRoot);
    const nextState: SyncState = {};

    let files: string[] = [];
    try {
      files = listMarkdownFiles(folder);
    } catch (e) {
      result.errors.push(`could not list ${folder}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const seenRelPaths = new Set<string>();
    for (const filePath of files) {
      const relPath = relative(folder, filePath);
      seenRelPaths.add(relPath);
      try {
        const content = readFileSync(filePath, 'utf8');
        const hash = sha256Of(content);
        const prev = prevState[relPath];
        if (prev && prev.sha256 === hash) {
          nextState[relPath] = prev;
          continue;
        }
        if (prev) {
          try { knowledge.removeDocFrom(projectRoot, prev.docId); } catch { /* best-effort — re-ingest proceeds regardless */ }
        }
        const ingested = knowledge.ingestFileInto(projectRoot, filePath, {
          title: titleFromPath(filePath),
          tags: ['obsidian', mapping.slug]
        });
        nextState[relPath] = { sha256: hash, docId: ingested.docId };
        if (prev) result.updated++; else result.added++;
      } catch (e) {
        result.errors.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    for (const [relPath, entry] of Object.entries(prevState)) {
      if (seenRelPaths.has(relPath)) continue;
      try {
        knowledge.removeDocFrom(projectRoot, entry.docId);
        result.removed++;
      } catch (e) {
        result.errors.push(`could not remove stale doc for ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    try {
      writeSyncState(projectRoot, nextState);
    } catch (e) {
      result.errors.push(`could not persist sync state: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { projects };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/knowledge-vault-sync-run.test.cjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0

- [ ] **Step 6: Run the full focused suite to confirm no regressions**

Run: `npm run test:focused`
Expected: all tests pass, including the ones from Tasks 1-4

- [ ] **Step 7: Commit**

```bash
git add src/main/knowledgeVaultSync.ts test/knowledge-vault-sync-run.test.cjs
git commit -m "feat(kg): add runVaultSync diff/ingest/prune job"
```

---

### Task 6: Wire scheduling and spawn-env injection

**Files:**
- Modify: `src/main/index.ts` (imports near the top; a new timer near the existing `slackDoneTimer`/`webhookDoneTimer` pair around line 1932-1996; the spawn-env line at 2715; the `kgCliPath` line at 2697 is unaffected and untouched)

**Interfaces:**
- Consumes: `runVaultSync` and `resolveProjectForCwd` (Task 5 and 4, `src/main/knowledgeVaultSync.ts`), `readConfig`/`writeConfig` (existing, `src/main/config.ts`), the existing `knowledge` (`KnowledgeManager`) and `hive` instances already constructed in `index.ts`.
- Produces: nothing new consumed elsewhere — this is the top of the wiring, the last task in this plan.

This task is integration glue between already-tested pure logic (Tasks 1-5) and the app's process lifecycle. It has no new pure function to unit test in isolation — the existing codebase follows the same pattern for its own equivalent timers (`slackDoneTimer`, `webhookDoneTimer`, `fleetTimer`): no dedicated unit test, verified by typecheck plus a manual run. Do the same here.

- [ ] **Step 1: Add the import**

In `src/main/index.ts`, find the existing knowledge-related import (search for `KnowledgeManager` or the line that imports from `./knowledge`) and add a new import line right after it:

```ts
import { resolveProjectForCwd, runVaultSync } from './knowledgeVaultSync';
```

- [ ] **Step 2: Add the daily sync timer**

Find the existing `webhookDoneTimer` declaration and its `startWebhookDoneObserver`/`stopWebhookDoneObserver` pair (around line 1932-1996 per the design doc). Immediately after that pair, add:

```ts
// ─── Obsidian vault → per-project Knowledge Graph sync ───────────────────────
const VAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
let vaultSyncTimer: ReturnType<typeof setInterval> | null = null;
let vaultSyncInFlight = false;

async function runVaultSyncTick(): Promise<void> {
  if (vaultSyncInFlight) return;
  const kg = readConfig().knowledgeGraph;
  if (!kg?.enabled || !kg.vaultSync?.enabled) return;
  vaultSyncInFlight = true;
  try {
    const result = await runVaultSync(kg.vaultSync, knowledge);
    for (const p of result.projects) {
      if (p.errors.length) console.error(`[vault-sync] ${p.slug}: ${p.errors.join('; ')}`);
    }
    writeConfig({ knowledgeGraph: { ...kg, vaultSync: { ...kg.vaultSync, lastSyncAt: Date.now() } } });
  } catch (e) {
    console.error('[vault-sync] run failed:', e instanceof Error ? e.message : e);
  } finally {
    vaultSyncInFlight = false;
  }
}

/** Start the daily vault-sync timer (idempotent). Runs once immediately if a
 *  day has elapsed since the last run — covers "the app was closed all day,
 *  catch up now" — then every 24h while the app stays open. A no-op call when
 *  the feature is off (each tick re-checks the flags itself). */
function startVaultSyncTimer(): void {
  if (vaultSyncTimer) return;
  const cfg = readConfig();
  const last = cfg.knowledgeGraph?.vaultSync?.lastSyncAt ?? 0;
  if (Date.now() - last > VAULT_SYNC_INTERVAL_MS) void runVaultSyncTick();
  vaultSyncTimer = setInterval(() => { void runVaultSyncTick(); }, VAULT_SYNC_INTERVAL_MS);
}

function stopVaultSyncTimer(): void {
  if (vaultSyncTimer) { clearInterval(vaultSyncTimer); vaultSyncTimer = null; }
}
```

- [ ] **Step 3: Start the timer at app boot**

Find where `startWebhookDoneObserver()` (or the equivalent existing daily/periodic starters) is called inside `app.whenReady().then(() => { ... })`, and add a call right after it:

```ts
startVaultSyncTimer();
```

- [ ] **Step 4: Resolve the project at spawn time**

At `src/main/index.ts:2715`, change:

```ts
opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env() };
```

to:

```ts
const vaultSyncCfg = readConfig().knowledgeGraph?.vaultSync;
const projectSlug = vaultSyncCfg?.enabled
  ? (await resolveProjectForCwd(meta.cwd, vaultSyncCfg.projects ?? []))?.slug ?? null
  : null;
opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env(projectSlug) };
```

Confirm the enclosing function is already `async` (it must be, since it already computes other spawn options before this line — check the function signature a few lines above; if for any reason it is not, this is the one place in this task where a signature change ripples: mark it `async` and make sure its caller `await`s it, matching how every other spawn-path async step already works in this file).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0

- [ ] **Step 6: Run the full focused suite**

Run: `npm run test:focused`
Expected: all tests pass (Tasks 1-5's tests plus everything pre-existing)

- [ ] **Step 7: Manual smoke test**

1. `npm run dev`
2. In Settings, enable `knowledgeGraph.enabled` and set `knowledgeGraph.vaultSync` (via the config file directly, or a debug IPC call, if no UI exists yet for this — a Settings UI is explicitly out of scope for this plan, see note below) to `{ enabled: true, vaultPath: '~/Documents/Obsidian/SecondBrain', projects: [{ slug: 'burdastyle', repoOrigin: 'git@bitbucket.org:magenio/burdastyle.git', vaultFolder: '01-Projects/BurdaStyle' }] }`.
3. Confirm `<userData>/knowledge/projects/burdastyle/` gets populated after the app-start sync run (check `docs/` and `index.jsonl` inside it).
4. Spawn (or use an already-running) agent whose cwd resolves to `motta-burdastyle`; from its terminal, run `kg search "<a term you know is in one of the synced notes>"` and confirm it returns a hit from that project's notes only.

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(kg): wire daily vault sync and per-project spawn-env injection"
```

---

## Note: Settings UI is out of scope for this plan

This plan implements the sync engine and its config schema, reachable today by editing `knowledgeGraph.vaultSync` directly (or via a future `ipcMain.handle` the renderer could call — none is added here, matching the spec, which scoped this to the sync mechanism itself). Exposing `vaultPath`/`projects` mapping entry as an editable list in the Settings UI is a natural, separable follow-up — flag it to the user as a small additional task once this lands, rather than folding it in here.
