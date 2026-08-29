# Jira Project Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written `hive/jira-map.json` with a first-class `HarnessConfig` field — schema, save-time validation, a Connections UI panel, broker exposure, and an opt-in poll mission — so Jira project ↔ repo ↔ agent bindings are configured like every other integration in munder-difflin.

**Architecture:** New types + pure validators live in `src/shared/jiraProjects.ts` (framework-agnostic, mirrors `shared/integrations.ts`). Async validation (repo/branch/agent/remote-key checks) and config-backed CRUD live in a new `src/main/jiraProjects.ts`, built on the existing `git.ts` helpers and `hive.registry()` — no new git or registry plumbing. The `IntegrationBroker` gains one read-only route (`GET /jira-bindings`) so the (new, opt-in) `jira-poll` mission can fetch active bindings without a file. UI follows `IntegrationsRegistry.tsx`'s exact pattern, mounted right below it in Settings → Connections.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, `node:test` (`test/*.test.cjs` via `test/load-ts.cjs`), existing `git.ts` / `hive.ts` / `integrations.ts` / `integrationBroker.ts` modules.

**Spec:** `docs/superpowers/specs/2026-08-29-jira-project-mapping-design.md`

## Global Constraints

- Config mirrored in exactly three places: `src/main/config.ts`, `src/renderer/src/store/config.ts`, `src/preload/index.ts` — every field change touches all three.
- Persist config changes only via `writeConfig`/`updateConfig` IPC — never hand-edit `config.json` (app overwrites it live).
- Never write to or delete `hive/jira-map.json` from code — read-only, one-shot import only.
- `Co-Authored-By` trailer forbidden in any commit.
- Every new locale string added to **all three** locale files (`en.json`, `ar.json`, `zh-CN.json`) — `test/arabic-ui.test.cjs` fails the whole suite on key-tree drift between them.
- `npm run typecheck` (node + web) and `npm run test:focused` must stay green after every task.
- All work happens on branch `feature/jira-project-mapping` (already created).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/jiraProjects.ts` (new) | `JiraProjectBinding`/`JiraPollSettings` types, key-format/duplicate validators, `jira-map.json` → config parser. Zero I/O, usable from main and renderer. |
| `src/main/jiraProjects.ts` (new) | Async binding validation (repo/branch/agent/remote-key, dependency-injected like `integrationBroker.ts`) + config-backed CRUD (`listBindings`/`upsertBinding`/`removeBinding`). |
| `src/main/config.ts` (modify) | `HarnessConfig` fields, `DEFAULTS`, one-shot `jira-map.json` migration, `JIRA_POLL_MISSION` definition. |
| `src/main/integrations.ts` (modify) | Extract `probeRecord()` out of the `integrations:test` handler so `jiraProjects.ts` can reuse the exact same upstream-probe logic for the remote Jira-key check. |
| `src/main/integrationBroker.ts` (modify) | New `GET /jira-bindings` route + `getJiraBindings` dependency. |
| `src/main/index.ts` (modify) | New IPC handlers (`jiraProjects:*`), broker dependency wiring, `JIRA_POLL_MISSION` seeding in `ensureDefaultMissions()`. |
| `src/renderer/src/store/config.ts`, `src/preload/index.ts` (modify) | Mirror the two new `HarnessConfig` fields; preload adds the `jiraProjects*` bridge methods. |
| `src/renderer/src/jiraProjects/jiraProjectsClient.ts` (new) | Renderer's single doorway to the new IPC surface (mirrors `registryClient.ts`). |
| `src/renderer/src/components/JiraProjectsRegistry.tsx` (new) | The Settings → Connections panel. |
| `src/renderer/src/components/SettingsModal.tsx` (modify) | Mount the new panel below `<IntegrationsRegistry />`. |
| `resources/skills/capabilities/SKILL.md` (modify) | Document `GET /jira-bindings` for spawned agents (god included). |
| Locale files (modify) | `jiraProjects.*` keys in `en.json`, `ar.json`, `zh-CN.json`. |

---

### Task 1: Shared types, validators, and the jira-map.json parser

**Files:**
- Create: `src/shared/jiraProjects.ts`
- Test: `test/jira-projects-shared.test.cjs`

**Interfaces:**
- Produces: `JiraProjectBinding`, `JiraPollSettings`, `DEFAULT_JIRA_POLL_SETTINGS`, `JIRA_KEY_RE`, `validateJiraKeyFormat(key: string): string | null`, `hasDuplicateKey(key: string, otherBindings: JiraProjectBinding[]): boolean`, `parseJiraMapJson(raw: string): { bindings: JiraProjectBinding[]; poll: Partial<JiraPollSettings> } | null` — all consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  JIRA_KEY_RE,
  validateJiraKeyFormat,
  hasDuplicateKey,
  parseJiraMapJson,
  DEFAULT_JIRA_POLL_SETTINGS
} = loadTs('src/shared/jiraProjects.ts');

test('JIRA_KEY_RE accepts real project keys', () => {
  assert.ok(JIRA_KEY_RE.test('BURD'));
  assert.ok(JIRA_KEY_RE.test('BRAVI'));
  assert.ok(JIRA_KEY_RE.test('A1'));
});

test('JIRA_KEY_RE rejects lowercase, leading digit, and too-short/long keys', () => {
  assert.equal(JIRA_KEY_RE.test('burd'), false);
  assert.equal(JIRA_KEY_RE.test('1BURD'), false);
  assert.equal(JIRA_KEY_RE.test('A'), false);
  assert.equal(JIRA_KEY_RE.test('A'.repeat(11)), false);
});

test('validateJiraKeyFormat returns null for a valid key', () => {
  assert.equal(validateJiraKeyFormat('BURD'), null);
});

test('validateJiraKeyFormat returns a message for an invalid key', () => {
  assert.ok(typeof validateJiraKeyFormat('burd') === 'string' && validateJiraKeyFormat('burd').length > 0);
});

test('hasDuplicateKey is case-insensitive and checks only the given list', () => {
  const others = [{ key: 'BURD', repo: '/r', baseBranch: 'develop', enabled: true }];
  assert.equal(hasDuplicateKey('burd', others), true);
  assert.equal(hasDuplicateKey('BRAVI', others), false);
});

test('parseJiraMapJson maps projects[] and claimFilter into bindings/poll', () => {
  const raw = JSON.stringify({
    claimFilter: { assignee: 'currentUser()', status: 'To Do', pollIntervalMs: 300000 },
    projects: [
      { key: 'BURD', repo: '/Users/shaibon/www/motta-burdastyle', baseBranch: 'develop', agents: ['dwight-mtcttd07'] },
      { key: 'BRAVI', repo: '/Users/shaibon/www/magenio-M2-bravifarmacie', baseBranch: 'develop', agents: [] }
    ]
  });
  const result = parseJiraMapJson(raw);
  assert.deepEqual(result.bindings, [
    { key: 'BURD', repo: '/Users/shaibon/www/motta-burdastyle', baseBranch: 'develop', agents: ['dwight-mtcttd07'], enabled: true },
    { key: 'BRAVI', repo: '/Users/shaibon/www/magenio-M2-bravifarmacie', baseBranch: 'develop', agents: [], enabled: true }
  ]);
  assert.equal(result.poll.pollIntervalMs, 300000);
});

test('parseJiraMapJson returns null for malformed JSON instead of throwing', () => {
  assert.equal(parseJiraMapJson('{not json'), null);
});

test('parseJiraMapJson returns an empty bindings list when projects is missing', () => {
  const result = parseJiraMapJson(JSON.stringify({ claimFilter: {} }));
  assert.deepEqual(result.bindings, []);
});

test('DEFAULT_JIRA_POLL_SETTINGS matches the decided defaults', () => {
  assert.deepEqual(DEFAULT_JIRA_POLL_SETTINGS, {
    pollIntervalMs: 300000,
    assigneeFilter: 'currentUser',
    statusFilter: 'To Do'
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jira-projects-shared.test.cjs`
Expected: FAIL — `src/shared/jiraProjects.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Jira project mapping — canonical types + pure validators.
 *
 * Framework-agnostic (no node:fs, no electron): usable from both main
 * (src/main/jiraProjects.ts, src/main/config.ts, src/main/integrationBroker.ts)
 * and renderer (@shared/jiraProjects) the same way shared/integrations.ts is.
 *
 * Replaces the hand-written hive/jira-map.json. See
 * docs/superpowers/specs/2026-08-29-jira-project-mapping-design.md.
 */

export interface JiraProjectBinding {
  /** Jira project key, e.g. "BURD". Immutable once created (identity for CRUD). */
  key: string;
  /** Absolute path to the local repo. */
  repo: string;
  /** Branch features are cut from and merged back into, e.g. "develop". */
  baseBranch: string;
  /** Agent ids that cover this project. Absent/empty = all agents. */
  agents?: string[];
  /** Exclude a project from the poll without deleting it. */
  enabled: boolean;
}

export interface JiraPollSettings {
  /** Default 300_000 (5 min). */
  pollIntervalMs: number;
  /** Fixed today (decided, not reopened in UI) but kept as data, not a hardcoded
   *  constant scattered across call sites. */
  assigneeFilter: 'currentUser';
  /** Default 'To Do'. */
  statusFilter: string;
}

export const DEFAULT_JIRA_POLL_SETTINGS: JiraPollSettings = {
  pollIntervalMs: 300_000,
  assigneeFilter: 'currentUser',
  statusFilter: 'To Do'
};

/** Jira project key shape: one uppercase letter, then 1-9 uppercase letters/digits
 *  (2-10 chars total) — matches real Atlassian project keys (BURD, BRAVI, ...). */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Returns an error message, or null when the key format is valid. */
export function validateJiraKeyFormat(key: string): string | null {
  if (!key || !key.trim()) return 'Jira key is required.';
  if (!JIRA_KEY_RE.test(key.trim())) {
    return 'Jira key must be 2-10 uppercase letters/digits, starting with a letter (e.g. "BURD").';
  }
  return null;
}

/** Case-insensitive membership check against a list that must already exclude the
 *  binding being validated (the caller's responsibility — see jiraProjects.ts). */
export function hasDuplicateKey(key: string, otherBindings: JiraProjectBinding[]): boolean {
  const k = key.trim().toUpperCase();
  return otherBindings.some((b) => b.key.trim().toUpperCase() === k);
}

/** Parses the legacy hand-written hive/jira-map.json shape into the new config
 *  shape, for the one-shot migration in config.ts. Never throws — malformed JSON
 *  or an unexpected shape returns null so the caller can skip the import rather
 *  than crash config load. */
export function parseJiraMapJson(raw: string): { bindings: JiraProjectBinding[]; poll: Partial<JiraPollSettings> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const rawProjects = Array.isArray(obj.projects) ? obj.projects : [];
  const bindings: JiraProjectBinding[] = [];
  for (const p of rawProjects) {
    if (!p || typeof p !== 'object') continue;
    const rp = p as Record<string, unknown>;
    if (typeof rp.key !== 'string' || typeof rp.repo !== 'string' || typeof rp.baseBranch !== 'string') continue;
    bindings.push({
      key: rp.key,
      repo: rp.repo,
      baseBranch: rp.baseBranch,
      agents: Array.isArray(rp.agents) ? rp.agents.filter((a): a is string => typeof a === 'string') : undefined,
      enabled: true
    });
  }

  const poll: Partial<JiraPollSettings> = {};
  const rawFilter = obj.claimFilter;
  if (rawFilter && typeof rawFilter === 'object') {
    const rf = rawFilter as Record<string, unknown>;
    if (typeof rf.pollIntervalMs === 'number' && rf.pollIntervalMs > 0) poll.pollIntervalMs = rf.pollIntervalMs;
    if (typeof rf.status === 'string' && rf.status.trim()) poll.statusFilter = rf.status;
  }

  return { bindings, poll };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/jira-projects-shared.test.cjs`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/jiraProjects.ts test/jira-projects-shared.test.cjs
git commit -m "feat(jira): add shared JiraProjectBinding types and pure validators"
```

---

### Task 2: HarnessConfig schema — fields, defaults, JIRA_POLL_MISSION

**Files:**
- Modify: `src/main/config.ts`
- Modify: `src/renderer/src/store/config.ts`
- Modify: `src/preload/index.ts`
- Test: `test/jira-projects-config-defaults.test.cjs`

**Interfaces:**
- Consumes: `JiraProjectBinding`, `JiraPollSettings`, `DEFAULT_JIRA_POLL_SETTINGS` from Task 1 (`../shared/jiraProjects` in main/preload, `@shared/jiraProjects` in renderer).
- Produces: `HarnessConfig.jiraProjects: JiraProjectBinding[]`, `HarnessConfig.jiraPoll: JiraPollSettings`, `HarnessConfig.jiraProjectsImported?: boolean`, `HarnessConfig.jiraPollSeeded?: boolean`, `JIRA_POLL_MISSION: ScheduledMission` — consumed by Tasks 3, 5, 6, 9.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-config-defaults-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { readConfig, JIRA_POLL_MISSION } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('a fresh config defaults jiraProjects to an empty list', () => {
  assert.deepEqual(readConfig().jiraProjects, []);
});

test('a fresh config defaults jiraPoll to the decided settings', () => {
  const cfg = readConfig();
  assert.equal(cfg.jiraPoll.pollIntervalMs, 300000);
  assert.equal(cfg.jiraPoll.assigneeFilter, 'currentUser');
  assert.equal(cfg.jiraPoll.statusFilter, 'To Do');
});

test('a config.json written before this field existed still loads (no crash)', () => {
  const p = path.join(userData, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ onboardingComplete: true, registeredRepos: ['/x'] }));
  const cfg = readConfig();
  assert.deepEqual(cfg.jiraProjects, []);
  assert.equal(cfg.registeredRepos[0], '/x');
});

test('JIRA_POLL_MISSION targets god, is disabled by default, and has a 5 min cadence', () => {
  assert.equal(JIRA_POLL_MISSION.id, 'jira-poll');
  assert.equal(JIRA_POLL_MISSION.to, 'god');
  assert.equal(JIRA_POLL_MISSION.enabled, false);
  assert.equal(JIRA_POLL_MISSION.intervalMs, 300000);
  assert.ok(JIRA_POLL_MISSION.body.includes('/jira-bindings'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jira-projects-config-defaults.test.cjs`
Expected: FAIL — `jiraProjects`/`jiraPoll` undefined, `JIRA_POLL_MISSION` not exported.

- [ ] **Step 3: Implement — `src/main/config.ts`**

Add the import near the other shared imports (top of file, alongside `import { defaultMcpDefaults } from '../shared/mcpCatalog';`):

```typescript
import {
  type JiraProjectBinding,
  type JiraPollSettings,
  DEFAULT_JIRA_POLL_SETTINGS,
  parseJiraMapJson
} from '../shared/jiraProjects';
```

Add the mission constant right after `HEARTBEAT_MISSION` (config.ts, after the block ending `quietThresholdMs: 300_000\n};`):

```typescript
/** The Jira claim poll: fetches active project bindings from the loopback
 *  broker (GET /jira-bindings — see integrationBroker.ts) and, for each, claims
 *  any issue assigned to the user in "To Do" (transition + kanban card + branch
 *  + delegate the Jira comment to Pam). Data (which projects/repos/agents) lives
 *  in jiraProjects config, NOT here — adding a project never touches this body.
 *
 *  Shipped DISABLED (opt-in, like the heartbeat): it makes Jira state
 *  transitions and creates kanban cards, not just a message. */
export const JIRA_POLL_MISSION: ScheduledMission = {
  id: 'jira-poll',
  label: 'Jira claim poll',
  intervalMs: DEFAULT_JIRA_POLL_SETTINGS.pollIntervalMs,
  to: 'god',
  body:
    'Jira claim poll. Fetch the active project bindings from the loopback broker ' +
    '(GET /jira-bindings via MD_BROKER_URL, with your MD_BROKER_TOKEN capability ' +
    'header) — it returns { bindings: [{key, repo, baseBranch, agents}], poll }. ' +
    'For each enabled binding, look up Jira issues assigned to the current user ' +
    'in status "To Do" for that project key. For every issue found: (1) claim it ' +
    '— transition it automatically on Jira (no comment on the transition itself); ' +
    '(2) create a card in tasks.json with project=<key>, repo=<binding.repo>, ' +
    'status="doing", and assign it to one of binding.agents (or any capable agent ' +
    'if the list is empty); (3) branch convention is feature/<KEY>-<num>-<slug> ' +
    'cut from binding.baseBranch (sprints use stage/sprint-<NN>); (4) only Pam ' +
    'posts Jira comments — a fixed template, capped ~600 characters, only at the ' +
    'steps that matter (claimed, ready for QA, closed). Never paste logs, diffs, ' +
    'or agent reports into a Jira comment — technical detail stays on the hive card.',
  enabled: false
};
```

Add `jiraProjectsImported?: boolean` and `jiraPollSeeded?: boolean` to `HarnessConfig` right after `heartbeatSeeded?: boolean;` (~line 259):

```typescript
  /** One-time guard: has hive/jira-map.json been imported into jiraProjects?
   *  Prevents re-importing after the user deletes bindings on purpose. */
  jiraProjectsImported?: boolean;
  /** Mirrors opsStandupSeeded/heartbeatSeeded for JIRA_POLL_MISSION. */
  jiraPollSeeded?: boolean;
```

Add `jiraProjects: JiraProjectBinding[];` and `jiraPoll: JiraPollSettings;` to `HarnessConfig` right after `registeredRepos: string[];` (~line 220):

```typescript
  /** Jira project → repo → base branch → agents bindings. Replaces the
   *  hand-written hive/jira-map.json. Empty by default; see JiraProjectBinding
   *  in shared/jiraProjects.ts. */
  jiraProjects: JiraProjectBinding[];
  /** Global settings for the Jira claim poll (interval + claim filter). */
  jiraPoll: JiraPollSettings;
```

Add to `DEFAULTS` right after `registeredRepos: [],`:

```typescript
  jiraProjects: [],
  jiraPoll: DEFAULT_JIRA_POLL_SETTINGS,
```

- [ ] **Step 4: Implement — mirror types in `src/renderer/src/store/config.ts`**

Add near the top import block:

```typescript
import type { JiraProjectBinding, JiraPollSettings } from '@shared/jiraProjects';
export type { JiraProjectBinding, JiraPollSettings } from '@shared/jiraProjects';
```

Add to the renderer `HarnessConfig` interface, right after `registeredRepos: string[];`:

```typescript
  /** Mirrors src/main/config.ts. */
  jiraProjects: JiraProjectBinding[];
  jiraPoll: JiraPollSettings;
  jiraProjectsImported?: boolean;
  jiraPollSeeded?: boolean;
```

- [ ] **Step 5: Implement — mirror types in `src/preload/index.ts`**

Add near the other `../shared/*` type imports:

```typescript
import type { JiraProjectBinding, JiraPollSettings } from '../shared/jiraProjects';
export type { JiraProjectBinding, JiraPollSettings } from '../shared/jiraProjects';
```

Add to the preload `HarnessConfig` interface, right after `registeredRepos: string[];`:

```typescript
  jiraProjects: JiraProjectBinding[];
  jiraPoll: JiraPollSettings;
  jiraProjectsImported?: boolean;
  jiraPollSeeded?: boolean;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/jira-projects-config-defaults.test.cjs`
Expected: PASS (4 tests)

- [ ] **Step 7: Run the full focused suite + typecheck to catch mirror drift**

Run: `npm run test:focused && npm run typecheck`
Expected: PASS — confirms the three mirrored `HarnessConfig` shapes still line up.

- [ ] **Step 8: Commit**

```bash
git add src/main/config.ts src/renderer/src/store/config.ts src/preload/index.ts test/jira-projects-config-defaults.test.cjs
git commit -m "feat(jira): add jiraProjects/jiraPoll to HarnessConfig, define JIRA_POLL_MISSION"
```

---

### Task 3: One-shot migration from `hive/jira-map.json`

**Files:**
- Modify: `src/main/config.ts`
- Test: `test/jira-projects-migration.test.cjs`

**Interfaces:**
- Consumes: `parseJiraMapJson` (Task 1), `JiraProjectBinding`/`JiraPollSettings` (Task 1), the `jiraProjects`/`jiraPoll`/`jiraProjectsImported` fields (Task 2), `expandTilde` from `./fs` (already imported in config.ts).
- Produces: `readConfig()` returning imported bindings on first read when `hive/jira-map.json` exists.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jira-projects-migration.test.cjs`
Expected: FAIL — no migration wired yet, `jiraProjects` stays `[]` even when `jira-map.json` exists.

- [ ] **Step 3: Implement in `src/main/config.ts`**

Add a one-shot latch next to `triggersMigrationRan` (~line 564):

```typescript
let jiraProjectsMigrationRan = false;
```

Add the migration function right after `migrateTriggersV1` (mirrors its exact guard shape):

```typescript
/** One-shot import of the legacy hive/jira-map.json into `jiraProjects`. Reads
 *  from <harnessHome>/hive/jira-map.json (HiveManager.root(), duplicated here
 *  as a plain path since config.ts must not import hive.ts). Never mutates or
 *  deletes the file — the user removes it once they're done relying on it. */
function migrateJiraProjectsV1(cfg: HarnessConfig): HarnessConfig {
  if (cfg.jiraProjectsImported || jiraProjectsMigrationRan) return cfg;
  jiraProjectsMigrationRan = true;
  if (!cfg.harnessHome || (cfg.jiraProjects?.length ?? 0) > 0) {
    return { ...cfg, jiraProjectsImported: true };
  }
  try {
    const mapPath = join(expandTilde(cfg.harnessHome), 'hive', 'jira-map.json');
    if (!existsSync(mapPath)) return { ...cfg, jiraProjectsImported: true };
    const parsed = parseJiraMapJson(readFileSync(mapPath, 'utf8'));
    if (!parsed) return { ...cfg, jiraProjectsImported: true };
    const next: HarnessConfig = {
      ...cfg,
      jiraProjects: parsed.bindings,
      jiraPoll: { ...cfg.jiraPoll, ...parsed.poll },
      jiraProjectsImported: true
    };
    persistConfig(next);
    return next;
  } catch {
    // Leave jiraProjects at its current value; the latch above stays set for
    // this process, and jiraProjectsImported never got persisted, so a fixed
    // file gets picked up on the next launch.
    return cfg;
  }
}
```

Wire it into `readConfig()`'s migration chain (currently `return normalizeStoredHomes(migrateTriggersV1(withTriggerDefaults({ ...DEFAULTS, ...parsed })));`):

```typescript
    return migrateJiraProjectsV1(normalizeStoredHomes(migrateTriggersV1(withTriggerDefaults({ ...DEFAULTS, ...parsed }))));
```

Also reset the new latch in `resetConfig()` alongside `triggersMigrationRan = false;`:

```typescript
  jiraProjectsMigrationRan = false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/jira-projects-migration.test.cjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full focused suite**

Run: `npm run test:focused`
Expected: PASS — confirms this doesn't disturb `migrateTriggersV1`/`config-write-notify` behavior.

- [ ] **Step 6: Commit**

```bash
git add src/main/config.ts test/jira-projects-migration.test.cjs
git commit -m "feat(jira): one-shot import of hive/jira-map.json into config"
```

---

### Task 4: Async binding validation and config-backed CRUD (`src/main/jiraProjects.ts`)

**Files:**
- Create: `src/main/jiraProjects.ts`
- Test: `test/jira-projects-validate.test.cjs`

**Interfaces:**
- Consumes: `JiraProjectBinding`, `validateJiraKeyFormat`, `hasDuplicateKey` (Task 1); real `isRepo`/`getBranches` from `./git` (existing) for the integration-style tests; `readConfig`/`writeConfig` from `./config` (existing).
- Produces: `JiraValidationDeps` interface, `validateJiraProjectBinding(binding, otherBindings, deps): Promise<{ ok: true } | { ok: false; error: string }>`, `listBindings(): JiraProjectBinding[]`, `upsertBinding(binding, deps): Promise<{ ok: true; bindings: JiraProjectBinding[] } | { ok: false; error: string }>`, `removeBinding(key: string): JiraProjectBinding[]` — all consumed by Task 6 (IPC wiring) and, transitively, Task 10 (`listBindings` in the broker's `getJiraBindings`).

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { validateJiraProjectBinding } = loadTs('src/main/jiraProjects.ts');
const { isRepo, getBranches } = loadTs('src/main/git.ts');

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-validate-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  spawnSync('git', ['branch', 'develop'], { cwd: dir });
  return dir;
}

const okDeps = (overrides = {}) => ({
  isRepo, getBranches, agentExists: () => true, testJiraKey: undefined, ...overrides
});

test('rejects an invalid key format before touching the filesystem', async () => {
  const res = await validateJiraProjectBinding(
    { key: 'burd', repo: '/nonexistent', baseBranch: 'develop', enabled: true },
    [],
    okDeps({ isRepo: () => { throw new Error('should not be called'); } })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /uppercase/i);
});

test('rejects a duplicate key (case-insensitive)', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'burd', repo: dir, baseBranch: 'develop', enabled: true },
    [{ key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }],
    okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /already exists/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a repo path that does not exist', async () => {
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: '/definitely/not/a/real/path', baseBranch: 'develop', enabled: true },
    [], okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /does not exist/i);
});

test('rejects a repo path that exists but is not a git repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-notrepo-'));
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, [], okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /not a git repo/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a base branch that does not exist locally or on origin', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'nope-branch', enabled: true }, [], okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /branch/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts a base branch that only exists on origin/', async () => {
  const upstream = initRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-clone-'));
  spawnSync('git', ['clone', '-q', upstream, dir]);
  spawnSync('git', ['branch', '-D', 'develop'], { cwd: dir }); // local copy removed, origin/develop remains
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, [], okDeps()
  );
  assert.equal(res.ok, true);
  fs.rmSync(upstream, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects an agent id that does not exist or is archived', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', agents: ['ghost'], enabled: true },
    [], okDeps({ agentExists: (id) => id !== 'ghost' })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /agent/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skips the remote Jira key check when testJiraKey is not provided (integration not configured)', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, [], okDeps({ testJiraKey: undefined })
  );
  assert.equal(res.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects when testJiraKey reports the project does not exist', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true },
    [], okDeps({ testJiraKey: async () => ({ ok: false, status: 404 }) })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /jira/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts a fully valid binding', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', agents: ['dwight'], enabled: true },
    [{ key: 'BRAVI', repo: dir, baseBranch: 'develop', enabled: true }],
    okDeps({ testJiraKey: async () => ({ ok: true, status: 200 }) })
  );
  assert.deepEqual(res, { ok: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jira-projects-validate.test.cjs`
Expected: FAIL — `src/main/jiraProjects.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Jira project binding validation + config-backed CRUD (main process).
 *
 * Async validation is dependency-injected (isRepo/getBranches/agentExists/
 * testJiraKey) the same way integrationBroker.ts injects getRecord/getSecret —
 * so this stays unit-testable with fakes AND with the real git.ts helpers
 * against throwaway repos (see test/jira-projects-validate.test.cjs).
 */
import { existsSync } from 'node:fs';
import {
  type JiraProjectBinding,
  validateJiraKeyFormat,
  hasDuplicateKey
} from '../shared/jiraProjects';
import { readConfig, writeConfig } from './config';

export interface JiraValidationDeps {
  isRepo: (cwd: string) => Promise<boolean>;
  getBranches: (cwd: string) => Promise<
    { local: string[]; remote: string[]; current: string | null } | { error: string }
  >;
  /** True when the agent id exists in the hive registry and is not archived. */
  agentExists: (id: string) => boolean;
  /** Probes the Jira REST API for the project key. Undefined when the `jira`
   *  integration isn't configured/enabled/has-a-secret yet — the check is then
   *  skipped rather than blocking (see spec §B.6). */
  testJiraKey?: (key: string) => Promise<{ ok: boolean; status?: number }>;
}

/** Validates one binding. `otherBindings` MUST already exclude the binding being
 *  edited (the caller filters by key before calling) — this function has no way
 *  to tell "editing myself" from "a real duplicate" otherwise. */
export async function validateJiraProjectBinding(
  binding: JiraProjectBinding,
  otherBindings: JiraProjectBinding[],
  deps: JiraValidationDeps
): Promise<{ ok: true } | { ok: false; error: string }> {
  const formatError = validateJiraKeyFormat(binding.key);
  if (formatError) return { ok: false, error: formatError };

  if (hasDuplicateKey(binding.key, otherBindings)) {
    return { ok: false, error: `A binding for "${binding.key.toUpperCase()}" already exists.` };
  }

  if (!existsSync(binding.repo)) {
    return { ok: false, error: `Repo path does not exist: ${binding.repo}` };
  }
  if (!(await deps.isRepo(binding.repo))) {
    return { ok: false, error: `${binding.repo} is not a git repo.` };
  }

  const branches = await deps.getBranches(binding.repo);
  if ('error' in branches) {
    return { ok: false, error: `Could not read branches: ${branches.error}` };
  }
  const branchOk = branches.local.includes(binding.baseBranch)
    || branches.remote.includes(`origin/${binding.baseBranch}`);
  if (!branchOk) {
    return { ok: false, error: `Branch "${binding.baseBranch}" was not found locally or as origin/${binding.baseBranch}.` };
  }

  for (const agentId of binding.agents ?? []) {
    if (!deps.agentExists(agentId)) {
      return { ok: false, error: `Agent "${agentId}" does not exist or is archived.` };
    }
  }

  if (deps.testJiraKey) {
    const probe = await deps.testJiraKey(binding.key);
    if (!probe.ok) {
      return { ok: false, error: `Jira project "${binding.key}" was not found (status ${probe.status ?? 'error'}).` };
    }
  }

  return { ok: true };
}

/** All configured bindings, unfiltered (enabled and disabled). */
export function listBindings(): JiraProjectBinding[] {
  return readConfig().jiraProjects ?? [];
}

/** Create or replace a binding by `key` (case-insensitive), after validating it
 *  against every OTHER binding. Rejects without writing on validation failure. */
export async function upsertBinding(
  binding: JiraProjectBinding,
  deps: JiraValidationDeps
): Promise<{ ok: true; bindings: JiraProjectBinding[] } | { ok: false; error: string }> {
  const current = listBindings();
  const others = current.filter((b) => b.key.toUpperCase() !== binding.key.toUpperCase());
  const result = await validateJiraProjectBinding(binding, others, deps);
  if (!result.ok) return result;
  const next = [...others, binding];
  writeConfig({ jiraProjects: next });
  return { ok: true, bindings: next };
}

/** Remove a binding by key (case-insensitive). No-op if it doesn't exist. */
export function removeBinding(key: string): JiraProjectBinding[] {
  const k = key.trim().toUpperCase();
  const next = listBindings().filter((b) => b.key.toUpperCase() !== k);
  writeConfig({ jiraProjects: next });
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/jira-projects-validate.test.cjs`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/jiraProjects.ts test/jira-projects-validate.test.cjs
git commit -m "feat(jira): add async binding validation and config-backed CRUD"
```

---

### Task 5: Extract `probeRecord` from the `integrations:test` handler

**Files:**
- Modify: `src/main/integrations.ts`
- Modify: `src/main/index.ts`
- Test: `test/jira-projects-probe-record.test.cjs`

**Interfaces:**
- Consumes: `validateBaseUrl`, `resolveUpstreamUrl`, `buildAuthHeaders` from `../shared/integrations` (already imported in `index.ts`, now imported in `integrations.ts` instead); `getRecord`/`getSecret` (already in `integrations.ts`).
- Produces: `probeRecord(id: string, path?: string): Promise<{ ok: boolean; status?: number; error?: string; code?: string }>` — consumed by Task 6's `testJiraKey` dependency and by the existing `integrations:test` IPC handler (behavior-preserving refactor).

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// integrations.ts reads readConfig() (electron app.getPath), so it needs the
// same mock as test/config-write-notify.test.cjs, pointed at a throwaway dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-probe-record-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } }
};

const { probeRecord } = loadTs('src/main/integrations.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('probeRecord returns an error for an unknown integration id', async () => {
  const res = await probeRecord('does-not-exist');
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown integration/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jira-projects-probe-record.test.cjs`
Expected: FAIL — `probeRecord` is not exported.

- [ ] **Step 3: Implement — extract into `src/main/integrations.ts`**

Add the import (integrations.ts doesn't currently import these):

```typescript
import { validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl } from '../shared/integrations';
```

Add the function (place it after `listRecordsRedacted`):

```typescript
/** Probes one integration's reachability through its own auth path. Runs in
 *  main so the secret is used but NEVER returned — only the upstream status.
 *  Shared by the admin-only `integrations:test` IPC handler and by
 *  jiraProjects.ts's remote Jira-key existence check (same upstream call,
 *  different caller). */
export async function probeRecord(
  id: string,
  path?: string
): Promise<{ ok: boolean; status?: number; error?: string; code?: string }> {
  const rec = getRecord(id);
  if (!rec) return { ok: false, error: 'unknown integration' };
  const probe = validateBaseUrl(rec.baseUrl);
  if (!probe.ok) return { ok: false, error: probe.error };
  const target = resolveUpstreamUrl(rec.baseUrl, typeof path === 'string' ? path : '');
  if (!target) return { ok: false, error: 'path escapes the integration baseUrl', code: 'bad_request' };
  const secret = getSecret(rec.secretRef);
  const headers = buildAuthHeaders(rec.authType, rec.authHeader, secret);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
    clearTimeout(timer);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Update the IPC handler in `src/main/index.ts`**

Replace the body of `ipcMain.handle('integrations:test', ...)` (~line 3148-3169) to delegate:

```typescript
ipcMain.handle('integrations:test', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; path?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  return integrations.probeRecord(p.id, typeof p.path === 'string' ? p.path : undefined);
});
```

This removes the now-unused direct imports `validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl` from `index.ts`'s own import line (~line 63) if nothing else there still uses them — check with a grep before deleting:

Run: `grep -n "validateBaseUrl\|buildAuthHeaders\|resolveUpstreamUrl" src/main/index.ts`

If the only remaining hits are the import line itself, remove those three names from the `from '../shared/integrations'` import on line 63 (keep `secretRefFor, INTEGRATION_TEMPLATES` if still used elsewhere in the file).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/jira-projects-probe-record.test.cjs`
Expected: PASS

- [ ] **Step 6: Typecheck (this touched index.ts's import list)**

Run: `npm run typecheck:node`
Expected: PASS — no unused-import or missing-import errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/integrations.ts src/main/index.ts test/jira-projects-probe-record.test.cjs
git commit -m "refactor(integrations): extract probeRecord for reuse by jiraProjects validation"
```

---

### Task 6: Wire real dependencies + IPC handlers in `src/main/index.ts`

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `validateJiraProjectBinding`/`listBindings`/`upsertBinding`/`removeBinding` (Task 4), `probeRecord` (Task 5), `isRepo`/`getBranches` (already imported), `hive.registry()` (already available in this file's scope).
- Produces: IPC channels `jiraProjects:list`, `jiraProjects:validate`, `jiraProjects:upsert`, `jiraProjects:remove` — consumed by Task 8 (preload).

No isolated `node:test` coverage here — `ipcMain.handle` callbacks aren't unit-testable without a running Electron main process, matching how `config:update`/`integrations:upsert` themselves have no dedicated test file. Correctness is covered transitively (Task 4/5's tests exercise the real logic these handlers call) and directly by Task 12's manual smoke test.

- [ ] **Step 1: Add the import**

`index.ts` already has `import * as integrations from './integrations';` at line 62 (Task 5 calls `integrations.probeRecord`, confirming it's in scope — no new import needed for that). Add the new one right after it:

```typescript
import * as jiraProjects from './jiraProjects';
```

- [ ] **Step 2: Add an `agentExists` helper**

Place it near `archiveOrphanedAgents()` (~line 878), since both read `hive.registry()`:

```typescript
/** True when `id` is god, or a non-archived agent in the hive registry. Used to
 *  validate JiraProjectBinding.agents at save time (jiraProjects.ts). */
function agentExists(id: string): boolean {
  const reg = hive.registry();
  if (id === reg.godId) return true;
  const a = reg.agents[id];
  return !!a && !a.archived;
}
```

- [ ] **Step 3: Add the IPC handlers**

Place them right after the `config:update` handler block (after its closing `});`):

```typescript
// ─── IPC: Jira project bindings ─────────────────────────────────────────────
function jiraValidationDeps(): jiraProjects.JiraValidationDeps {
  const jiraRecord = integrations.getRecord('jira');
  const jiraUsable = !!jiraRecord?.enabled && integrations.hasSecret(jiraRecord.secretRef);
  return {
    isRepo,
    getBranches,
    agentExists,
    testJiraKey: jiraUsable
      ? async (key: string) => {
        const r = await integrations.probeRecord('jira', `/project/${encodeURIComponent(key)}`);
        return { ok: r.ok, status: r.status };
      }
      : undefined
  };
}

ipcMain.handle('jiraProjects:list', () => jiraProjects.listBindings());

ipcMain.handle('jiraProjects:validate', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { binding?: unknown };
  const binding = p.binding as import('../shared/jiraProjects').JiraProjectBinding | undefined;
  if (!binding || typeof binding.key !== 'string') return { ok: false, error: 'binding required' };
  const others = jiraProjects.listBindings().filter((b) => b.key.toUpperCase() !== binding.key.toUpperCase());
  return jiraProjects.validateJiraProjectBinding(binding, others, jiraValidationDeps());
});

ipcMain.handle('jiraProjects:upsert', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { binding?: unknown };
  const binding = p.binding as import('../shared/jiraProjects').JiraProjectBinding | undefined;
  if (!binding || typeof binding.key !== 'string') return { ok: false, error: 'binding required' };
  return jiraProjects.upsertBinding(binding, jiraValidationDeps());
});

ipcMain.handle('jiraProjects:remove', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { key?: unknown };
  if (typeof p.key !== 'string' || !p.key) return { ok: false };
  jiraProjects.removeBinding(p.key);
  return { ok: true };
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:node`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(jira): wire jiraProjects IPC handlers with real git/registry/broker deps"
```

---

### Task 7: Preload bridge + renderer client

**Files:**
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/jiraProjects/jiraProjectsClient.ts`

**Interfaces:**
- Consumes: IPC channels from Task 6; `JiraProjectBinding` type (Task 2's preload mirror).
- Produces: `window.cth.jiraProjectsList/Validate/Upsert/Remove`; `jiraProjectsClient: { list, validate, save, remove }` — consumed by Task 8 (UI).

- [ ] **Step 1: Add preload bridge methods**

In `src/preload/index.ts`, right after the `integrationsTest` method (~line 1324):

```typescript
  // ─── Jira project bindings (Settings → Connections) ──────────────────────
  jiraProjectsList: (): Promise<JiraProjectBinding[]> =>
    ipcRenderer.invoke('jiraProjects:list'),
  jiraProjectsValidate: (binding: JiraProjectBinding): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jiraProjects:validate', { binding }),
  jiraProjectsUpsert: (binding: JiraProjectBinding): Promise<{ ok: true; bindings: JiraProjectBinding[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jiraProjects:upsert', { binding }),
  jiraProjectsRemove: (key: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('jiraProjects:remove', { key }),
```

- [ ] **Step 2: Write the renderer client**

```typescript
// Jira project bindings — the renderer's single doorway to the jiraProjects IPC
// surface (mirrors src/renderer/src/integrations/registryClient.ts). No mock
// fallback: unlike integrations (built before the preload bridge landed), this
// bridge ships with its IPC handlers from day one.

import type { JiraProjectBinding } from '@shared/jiraProjects';
export type { JiraProjectBinding, JiraPollSettings } from '@shared/jiraProjects';

interface JiraProjectsBridge {
  jiraProjectsList(): Promise<JiraProjectBinding[]>;
  jiraProjectsValidate(binding: JiraProjectBinding): Promise<{ ok: true } | { ok: false; error: string }>;
  jiraProjectsUpsert(binding: JiraProjectBinding): Promise<{ ok: true; bindings: JiraProjectBinding[] } | { ok: false; error: string }>;
  jiraProjectsRemove(key: string): Promise<{ ok: boolean }>;
}

function bridge(): JiraProjectsBridge {
  const b = (window as unknown as { cth: JiraProjectsBridge }).cth;
  return b;
}

export const jiraProjectsClient = {
  list: (): Promise<JiraProjectBinding[]> => bridge().jiraProjectsList(),
  validate: (binding: JiraProjectBinding) => bridge().jiraProjectsValidate(binding),
  save: (binding: JiraProjectBinding) => bridge().jiraProjectsUpsert(binding),
  remove: (key: string) => bridge().jiraProjectsRemove(key)
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/renderer/src/jiraProjects/jiraProjectsClient.ts
git commit -m "feat(jira): add preload bridge and renderer client for jiraProjects"
```

---

### Task 8: `JiraProjectsRegistry.tsx` UI + i18n + mount

**Files:**
- Create: `src/renderer/src/components/JiraProjectsRegistry.tsx`
- Modify: `src/renderer/src/components/SettingsModal.tsx`
- Modify: `src/renderer/src/i18n/locales/en.json`, `ar.json`, `zh-CN.json`
- Test: existing `test/arabic-ui.test.cjs` (key-tree parity — no new test file, this task must keep it green)

**Interfaces:**
- Consumes: `jiraProjectsClient` (Task 7), `integrationsClient` (existing, to check Jira integration usability), `window.cth.hiveRegistry()` (existing) for the agent multi-select, `JiraProjectBinding` type.
- Produces: the mounted `<JiraProjectsRegistry />` panel.

- [ ] **Step 1: Add locale keys**

In `src/renderer/src/i18n/locales/en.json`, add a new top-level key right after the `"integrations": { ... }` block closes (before the next top-level key):

```json
  "jiraProjects": {
    "title": "Jira projects",
    "desc": "Which Jira project maps to which local repo, base branch, and agents.",
    "needsIntegration": "Configure the Jira integration above first — bindings can be added, but the remote key check is skipped until it's connected.",
    "addProject": "+ Add project",
    "key": "Jira key",
    "keyHint": "e.g. \"BURD\". Cannot be changed after creation.",
    "repo": "Repo path",
    "baseBranch": "Base branch",
    "agents": "Agents",
    "agentsHint": "Leave empty for any agent.",
    "enabled": "Enabled",
    "pollSettings": "Poll settings",
    "pollInterval": "Poll interval (minutes)",
    "claimFilterFixed": "Claims issues assigned to you in \"To Do\" (fixed).",
    "saveProject": "Save project",
    "saveChanges": "Save changes",
    "couldNotSave": "Could not save.",
    "removed": "Removed \"{{key}}\".",
    "test": "Test",
    "testing": "Testing…",
    "testOk": "✓ Valid",
    "testFailed": "✕",
    "backToList": "← Jira projects",
    "noProjects": "No Jira projects configured yet."
  },
```

Add the matching block to `ar.json` (same key order, Arabic values):

```json
  "jiraProjects": {
    "title": "مشاريع Jira",
    "desc": "أي مشروع Jira يتطابق مع أي مستودع محلي وفرع أساسي ووكلاء.",
    "needsIntegration": "قم أولاً بتهيئة تكامل Jira أعلاه — يمكن إضافة الربط، لكن التحقق من المفتاح عن بُعد سيُتخطى حتى الاتصال.",
    "addProject": "+ إضافة مشروع",
    "key": "مفتاح Jira",
    "keyHint": "مثال: \"BURD\". لا يمكن تغييره بعد الإنشاء.",
    "repo": "مسار المستودع",
    "baseBranch": "الفرع الأساسي",
    "agents": "الوكلاء",
    "agentsHint": "اتركه فارغًا لأي وكيل.",
    "enabled": "مفعّل",
    "pollSettings": "إعدادات الاستطلاع",
    "pollInterval": "فترة الاستطلاع (دقائق)",
    "claimFilterFixed": "يأخذ القضايا المسندة إليك في \"To Do\" (ثابت).",
    "saveProject": "حفظ المشروع",
    "saveChanges": "حفظ التغييرات",
    "couldNotSave": "تعذر الحفظ.",
    "removed": "تمت إزالة \"{{key}}\".",
    "test": "اختبار",
    "testing": "جارٍ الاختبار…",
    "testOk": "✓ صالح",
    "testFailed": "✕",
    "backToList": "← مشاريع Jira",
    "noProjects": "لا توجد مشاريع Jira مهيأة بعد."
  },
```

Add the matching block to `zh-CN.json`:

```json
  "jiraProjects": {
    "title": "Jira 项目",
    "desc": "Jira 项目与本地仓库、基础分支和执行代理的对应关系。",
    "needsIntegration": "请先在上方配置 Jira 集成——绑定仍可添加，但远程密钥校验将被跳过，直到连接完成。",
    "addProject": "+ 添加项目",
    "key": "Jira 键",
    "keyHint": "例如“BURD”。创建后不可更改。",
    "repo": "仓库路径",
    "baseBranch": "基础分支",
    "agents": "代理",
    "agentsHint": "留空表示任意代理。",
    "enabled": "已启用",
    "pollSettings": "轮询设置",
    "pollInterval": "轮询间隔（分钟）",
    "claimFilterFixed": "认领分配给你且状态为“To Do”的问题（固定）。",
    "saveProject": "保存项目",
    "saveChanges": "保存更改",
    "couldNotSave": "无法保存。",
    "removed": "已移除“{{key}}”。",
    "test": "测试",
    "testing": "测试中…",
    "testOk": "✓ 有效",
    "testFailed": "✕",
    "backToList": "← Jira 项目",
    "noProjects": "尚未配置 Jira 项目。"
  },
```

- [ ] **Step 2: Run the locale-parity test to verify it fails**

Run: `node --test test/arabic-ui.test.cjs`
Expected: If the three blocks above were added with mismatched keys, this fails with a `missing`/`extra` diff. Reconcile until:

Run: `node --test test/arabic-ui.test.cjs`
Expected: PASS

(If it already passes because all three blocks have identical key sets, this step just confirms it — don't skip running it.)

- [ ] **Step 3: Write `JiraProjectsRegistry.tsx`**

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { jiraProjectsClient, type JiraProjectBinding } from '@/jiraProjects/jiraProjectsClient';
import { integrationsClient } from '@/integrations/registryClient';
import { authTypeNeedsSecret as needsSecret } from '@shared/integrations';
import { PixelButton } from './PixelButton';

// Jira project bindings — Settings → Connections, mounted right below
// IntegrationsRegistry (the natural continuation: that panel says HOW to talk
// to Jira, this one says WHICH projects/repos/agents it applies to).
// Structurally mirrors IntegrationsRegistry.tsx: a list view + a configure
// view, one `err` message per draft (not per-field), a `Test` action per row.

type View = 'list' | 'configure';

interface Draft {
  isNew: boolean;
  key: string;
  repo: string;
  baseBranch: string;
  agentsCsv: string; // comma-separated agent ids, parsed to string[] on save
  enabled: boolean;
}

interface TestResult { ok: boolean; error?: string }

function draftFromBinding(b: JiraProjectBinding): Draft {
  return {
    isNew: false, key: b.key, repo: b.repo, baseBranch: b.baseBranch,
    agentsCsv: (b.agents ?? []).join(', '), enabled: b.enabled
  };
}
function emptyDraft(): Draft {
  return { isNew: true, key: '', repo: '', baseBranch: '', agentsCsv: '', enabled: true };
}
function bindingFromDraft(d: Draft): JiraProjectBinding {
  const agents = d.agentsCsv.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    key: d.key.trim().toUpperCase(),
    repo: d.repo.trim(),
    baseBranch: d.baseBranch.trim(),
    agents: agents.length > 0 ? agents : undefined,
    enabled: d.enabled
  };
}

const dispLabel: CSSProperties = { fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-500)', textTransform: 'uppercase' };
const fieldLabel: CSSProperties = { ...dispLabel, color: 'var(--cth-ink-700)' };
const subText: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' };
const hint: CSSProperties = { fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' };
const inputStyle: CSSProperties = { width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)' };

export function JiraProjectsRegistry() {
  const { t: tr } = useTranslation();
  const [bindings, setBindings] = useState<JiraProjectBinding[]>([]);
  const [jiraUsable, setJiraUsable] = useState(false);
  const [view, setView] = useState<View>('list');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowTest, setRowTest] = useState<Record<string, TestResult>>({});
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [pollMinutes, setPollMinutes] = useState(5);

  const refresh = async () => setBindings(await jiraProjectsClient.list());

  useEffect(() => {
    let alive = true;
    (async () => {
      const [bs, ints] = await Promise.all([jiraProjectsClient.list(), integrationsClient.list()]);
      if (!alive) return;
      setBindings(bs);
      const jira = ints.find((r) => r.id === 'jira');
      setJiraUsable(!!jira?.enabled && (!needsSecret(jira.authType) || jira.hasSecret));
    })();
    return () => { alive = false; };
  }, []);

  const goList = () => { setView('list'); setDraft(null); setErr(''); };
  const startAdd = () => { setDraft(emptyDraft()); setErr(''); setView('configure'); };
  const startEdit = (b: JiraProjectBinding) => { setDraft(draftFromBinding(b)); setErr(''); setView('configure'); };
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const onSave = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    try {
      const res = await jiraProjectsClient.save(bindingFromDraft(draft));
      if (!res.ok) { setErr(res.error || tr('jiraProjects.couldNotSave')); return; }
      await refresh();
      goList();
    } catch {
      setErr(tr('jiraProjects.couldNotSave'));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (key: string) => {
    await jiraProjectsClient.remove(key);
    await refresh();
  };

  const onTestRow = async (b: JiraProjectBinding) => {
    setTestingKey(b.key);
    try {
      const res = await jiraProjectsClient.validate(b);
      setRowTest((m) => ({ ...m, [b.key]: res.ok ? { ok: true } : { ok: false, error: res.error } }));
    } finally {
      setTestingKey(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={dispLabel}>{tr('jiraProjects.title')}</span>
        <span style={subText}>{tr('jiraProjects.desc')}</span>
      </div>

      {!jiraUsable && (
        <div style={{ padding: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-500)' }}>
          {tr('jiraProjects.needsIntegration')}
        </div>
      )}

      {view === 'list' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bindings.length === 0 && <span style={subText}>{tr('jiraProjects.noProjects')}</span>}
            {bindings.map((b) => {
              const test = rowTest[b.key];
              return (
                <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 2 }}>
                    <span style={{ fontSize: 13, color: 'var(--cth-ink-900)' }}>{b.key} {!b.enabled && `(${tr('jiraProjects.enabled')}: off)`}</span>
                    <span style={hint}>{b.repo} → {b.baseBranch}</span>
                  </div>
                  {test && (
                    <span style={{ fontSize: 12, color: test.ok ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-danger, #6E1423)' }}>
                      {test.ok ? tr('jiraProjects.testOk') : `${tr('jiraProjects.testFailed')} ${test.error ?? ''}`}
                    </span>
                  )}
                  <PixelButton variant="secondary" size="sm" onClick={() => void onTestRow(b)} disabled={testingKey === b.key}>
                    {testingKey === b.key ? tr('jiraProjects.testing') : tr('jiraProjects.test')}
                  </PixelButton>
                  <PixelButton variant="secondary" size="sm" onClick={() => startEdit(b)}>{tr('jiraProjects.saveChanges')}</PixelButton>
                  <PixelButton variant="secondary" size="sm" onClick={() => void onRemove(b.key)}>×</PixelButton>
                </div>
              );
            })}
          </div>
          <PixelButton variant="secondary" size="sm" onClick={startAdd}>{tr('jiraProjects.addProject')}</PixelButton>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            <span style={fieldLabel}>{tr('jiraProjects.pollSettings')}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={subText}>{tr('jiraProjects.pollInterval')}</span>
              <input
                type="number" min={1} value={pollMinutes}
                onChange={(e) => setPollMinutes(Math.max(1, Number(e.target.value) || 1))}
                style={{ ...inputStyle, width: 64 }}
              />
            </div>
            <span style={hint}>{tr('jiraProjects.claimFilterFixed')}</span>
          </div>
        </>
      )}

      {view === 'configure' && draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" onClick={goList} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start', fontSize: 12, color: 'var(--cth-ink-500)' }}>
            {tr('jiraProjects.backToList')}
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.key')}</span>
            <input
              value={draft.key} disabled={!draft.isNew}
              onChange={(e) => patch({ key: e.target.value.toUpperCase() })}
              style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
            />
            <span style={hint}>{tr('jiraProjects.keyHint')}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.repo')}</span>
            <input value={draft.repo} onChange={(e) => patch({ repo: e.target.value })} style={inputStyle} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.baseBranch')}</span>
            <input value={draft.baseBranch} onChange={(e) => patch({ baseBranch: e.target.value })} style={inputStyle} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.agents')}</span>
            <input value={draft.agentsCsv} onChange={(e) => patch({ agentsCsv: e.target.value })} style={inputStyle} />
            <span style={hint}>{tr('jiraProjects.agentsHint')}</span>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cth-ink-700)' }}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            {tr('jiraProjects.enabled')}
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {err && <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--cth-danger, #6E1423)' }}>{err}</span>}
            <PixelButton variant="primary" size="sm" onClick={() => { void onSave(); }} disabled={busy}>
              {busy ? '…' : draft.isNew ? tr('jiraProjects.saveProject') : tr('jiraProjects.saveChanges')}
            </PixelButton>
          </div>
        </div>
      )}
    </div>
  );
}
```

Note: the poll-interval input (`pollMinutes`) is display/edit state only in this step — Step 4 below wires it to `jiraPoll.pollIntervalMs` via `updateConfig`. Flagging this explicitly rather than leaving it disconnected silently.

- [ ] **Step 4: Wire `pollMinutes` to config**

Add to the `useEffect` that loads bindings (fetch current config too) and to a save handler. Replace the `useEffect` body with:

```typescript
  useEffect(() => {
    let alive = true;
    (async () => {
      const [bs, ints, cfg] = await Promise.all([
        jiraProjectsClient.list(), integrationsClient.list(), window.cth.getConfig()
      ]);
      if (!alive) return;
      setBindings(bs);
      const jira = ints.find((r) => r.id === 'jira');
      setJiraUsable(!!jira?.enabled && (!needsSecret(jira.authType) || jira.hasSecret));
      setPollMinutes(Math.round((cfg.jiraPoll?.pollIntervalMs ?? 300000) / 60000));
    })();
    return () => { alive = false; };
  }, []);
```

Add an `onBlur` handler on the poll-interval `<input>` that persists it:

```tsx
              <input
                type="number" min={1} value={pollMinutes}
                onChange={(e) => setPollMinutes(Math.max(1, Number(e.target.value) || 1))}
                onBlur={() => { void window.cth.updateConfig({ jiraPoll: { pollIntervalMs: pollMinutes * 60000, assigneeFilter: 'currentUser', statusFilter: 'To Do' } }); }}
                style={{ ...inputStyle, width: 64 }}
              />
```

- [ ] **Step 5: Mount in `SettingsModal.tsx`**

Add the import near `import { IntegrationsRegistry } from './IntegrationsRegistry';` (~line 24):

```typescript
import { JiraProjectsRegistry } from './JiraProjectsRegistry';
```

Add the component right after `<IntegrationsRegistry />` (~line 1786):

```tsx
                      <IntegrationsRegistry />
                      <JiraProjectsRegistry />
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 7: Manual smoke test in the dev app**

Run: `npm run dev` (or use the project's existing dev-run flow), open Settings → Connections, scroll below Integrations, confirm the "Jira projects" panel renders, "+ Add project" opens the configure view, and saving a binding with a bogus repo path shows the inline error from `validateJiraProjectBinding`.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/JiraProjectsRegistry.tsx src/renderer/src/components/SettingsModal.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json
git commit -m "feat(jira): add JiraProjectsRegistry UI panel in Settings → Connections"
```

---

### Task 9: Broker route `GET /jira-bindings`

**Files:**
- Modify: `src/main/integrationBroker.ts`
- Test: `test/jira-bindings-broker.test.cjs`

**Interfaces:**
- Consumes: `JiraProjectBinding`, `JiraPollSettings`, `DEFAULT_JIRA_POLL_SETTINGS` (Task 1).
- Produces: `IntegrationBrokerDeps.getJiraBindings?: () => { bindings: JiraProjectBinding[]; poll: JiraPollSettings }` (optional — see Step 3 note); route `GET /jira-bindings` — consumed by Task 10 (wiring in index.ts) and by the `jira-poll` mission body at runtime.

Note: `getJiraBindings` is optional on the deps interface, not required. `index.ts`'s existing `new IntegrationBroker({ getRecord, getSecret })` call site isn't updated until Task 10 — if this field were required, that call would stop typechecking the moment this task lands, leaving the branch red for one commit. Optional-with-a-safe-default keeps this task's typecheck green on its own; Task 10 supplies the real implementation.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

function makeBroker(bindings) {
  return new IntegrationBroker({
    getRecord: () => undefined,
    getSecret: () => undefined,
    getJiraBindings: () => ({
      bindings,
      poll: { pollIntervalMs: 300000, assigneeFilter: 'currentUser', statusFilter: 'To Do' }
    })
  });
}

test('GET /jira-bindings falls back to an empty list when getJiraBindings is not supplied', async () => {
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.bindings, []);
  broker.stop();
});

test('GET /jira-bindings requires a valid capability token', async () => {
  const broker = makeBroker([]);
  await broker.start();
  const res = await fetch(`${broker.url()}/jira-bindings`);
  assert.equal(res.status, 401);
  broker.stop();
});

test('GET /jira-bindings returns bindings + poll settings for any valid token', async () => {
  const binding = { key: 'BURD', repo: '/r/burd', baseBranch: 'develop', enabled: true };
  const broker = makeBroker([binding]);
  await broker.start();
  // A token granted for an UNRELATED integration id still works — this route
  // isn't gated by allowedIds, it's a config-data read, not an integration proxy.
  const token = broker.grant('god', ['some-other-integration']);
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.bindings, [binding]);
  assert.equal(body.poll.pollIntervalMs, 300000);
  broker.stop();
});

test('GET /jira-bindings only ever returns what getJiraBindings hands back (already-filtered)', async () => {
  // The broker itself does no enabled-filtering — that's jiraProjects.ts's job
  // when it builds the deps in index.ts. This just proves the route is a
  // transparent passthrough, not that it filters (it must not double-filter).
  const disabled = { key: 'OLD', repo: '/r/old', baseBranch: 'main', enabled: false };
  const broker = makeBroker([disabled]);
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  const body = await res.json();
  assert.deepEqual(body.bindings, [disabled]);
  broker.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jira-bindings-broker.test.cjs`
Expected: FAIL — `getJiraBindings` not in `IntegrationBrokerDeps`, route returns 404.

- [ ] **Step 3: Implement in `src/main/integrationBroker.ts`**

Add the import (top of file, alongside the existing `../shared/integrations` import):

```typescript
import type { JiraProjectBinding, JiraPollSettings } from '../shared/jiraProjects';
import { DEFAULT_JIRA_POLL_SETTINGS } from '../shared/jiraProjects';
```

Add the field to `IntegrationBrokerDeps` — **optional**, see the note above:

```typescript
export interface IntegrationBrokerDeps {
  getRecord: (id: string) => IntegrationRecord | undefined;
  getSecret: (secretRef: string | undefined) => string | undefined;
  /** Active (already enabled-filtered by the caller) Jira project bindings +
   *  global poll settings, for the jira-poll mission's GET /jira-bindings call.
   *  Unlike /i/<id>/<path>, this is config data, not a credentialed proxy — any
   *  valid capability token can read it, regardless of allowedIds. Optional:
   *  wired in by Task 10; absent means "no Jira bindings feature configured
   *  yet" (e.g. an older construction site), not an error. */
  getJiraBindings?: () => { bindings: JiraProjectBinding[]; poll: JiraPollSettings };
}
```

Insert the route check in `handle()`, right after step 2 (capability check) and before step 3 (the `/i/<id>/<path>` regex parse):

```typescript
    // 2b) GET /jira-bindings — config data, not an integration proxy, so any
    // valid token (not just ones scoped to a specific integration id) may read
    // it. Checked before the /i/<id>/<path> parse below.
    if (req.method === 'GET' && /^\/jira-bindings\/?(\?[^#]*)?$/.test(rawUrl)) {
      const { bindings, poll } = this.deps.getJiraBindings?.() ?? { bindings: [], poll: DEFAULT_JIRA_POLL_SETTINGS };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bindings, poll }));
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/jira-bindings-broker.test.cjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck (confirms the existing `new IntegrationBroker({ getRecord, getSecret })` call site in index.ts still compiles with the new field left optional)**

Run: `npm run typecheck:node`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/integrationBroker.ts test/jira-bindings-broker.test.cjs
git commit -m "feat(jira): add GET /jira-bindings route to the loopback broker"
```

---

### Task 10: Wire the broker dependency + document the endpoint for agents

**Files:**
- Modify: `src/main/index.ts`
- Modify: `resources/skills/capabilities/SKILL.md`

**Interfaces:**
- Consumes: `IntegrationBroker` constructor (Task 9), `jiraProjects.listBindings()` (Task 4), `readConfig()` (existing).

- [ ] **Step 1: Find and update the `IntegrationBroker` construction site**

Run: `grep -n "new IntegrationBroker(" src/main/index.ts`

Add `getJiraBindings` to the deps object passed there:

```typescript
  getJiraBindings: () => ({
    bindings: jiraProjects.listBindings().filter((b) => b.enabled),
    poll: readConfig().jiraPoll
  })
```

- [ ] **Step 2: Document the endpoint in the bundled capabilities skill**

In `resources/skills/capabilities/SKILL.md`, add a bullet inside section "3. Integrations — via the loopback broker", right after the "MCP integrations" bullet and before "As additional brokered integrations land...":

```markdown
- **Jira project bindings** (if you're the orchestrator running the Jira claim
  poll). `GET /jira-bindings` on the same loopback broker returns
  `{ bindings: [{key, repo, baseBranch, agents}], poll: {pollIntervalMs,
  assigneeFilter, statusFilter} }` — the active Jira project ↔ repo ↔ agent
  map, config-backed, no file to read. Any valid broker token can call it
  (it's config data, not a credentialed integration proxy).
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:node`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts resources/skills/capabilities/SKILL.md
git commit -m "feat(jira): wire getJiraBindings into the broker, document it for agents"
```

---

### Task 11: Seed `JIRA_POLL_MISSION` on boot

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `JIRA_POLL_MISSION` (Task 2), `jiraPollSeeded` field (Task 2), `ensureDefaultMissions()` (existing, ~line 899).

- [ ] **Step 1: Import the mission constant**

Add `JIRA_POLL_MISSION` to the existing `import { ..., OPS_STANDUP_MISSION, HEARTBEAT_MISSION, ... } from './config';` line in `index.ts` (find the exact line with `grep -n "OPS_STANDUP_MISSION" src/main/index.ts` and extend it).

- [ ] **Step 2: Extend `ensureDefaultMissions()`**

Add this block inside `ensureDefaultMissions()`, right after the `heartbeatSeeded` block and before the "maint-1 RETIREMENT" comment:

```typescript
  // Seed the Jira claim poll once. Shipped DISABLED (like the heartbeat) — it
  // makes Jira transitions and creates kanban cards, so the user opts in from
  // the Schedules panel once bindings are configured.
  const cfg3 = readConfig();
  if (!cfg3.jiraPollSeeded) {
    const missions = cfg3.missions ?? [];
    const has = missions.some((m) => m.id === JIRA_POLL_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...JIRA_POLL_MISSION, lastFiredAt: Date.now() }],
      jiraPollSeeded: true
    });
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:node`
Expected: PASS

- [ ] **Step 4: Manual verification**

Run the dev app once with a throwaway/test userData profile (or accept the seeding on the real profile — it's additive and disabled by default, matching how `heartbeat` was seeded historically), open Command Center → Triggers → Schedules, confirm "Jira claim poll" appears, disabled, 5 min cadence.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(jira): seed the disabled jira-poll mission on boot"
```

---

### Task 12: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS (node + web)

- [ ] **Step 2: Full focused test suite**

Run: `npm run test:focused`
Expected: PASS — every `test/*.test.cjs` including all files added in Tasks 1-9 and the pre-existing `test/arabic-ui.test.cjs` locale-parity check.

- [ ] **Step 3: Confirm no code path still reads `jira-map.json`**

Run: `grep -rn "jira-map" src/`
Expected: no matches (the only remaining reference to the filename is in `parseJiraMapJson`'s doc comment and `config.ts`'s migration function — confirm with a second, narrower check):

Run: `grep -rn "jira-map.json" src/`
Expected: matches only inside `migrateJiraProjectsV1`'s implementation and its doc comment in `src/main/config.ts` — i.e., the one-shot importer, nothing else.

- [ ] **Step 4: End-to-end manual smoke test**

Using the real hive at `/Users/shaibon/HarnessAgents/hive` (which has a real `jira-map.json` with BURD/BRAVI):
1. Start the dev app against that hive.
2. Open Settings → Connections. Confirm the Jira projects panel shows BURD and BRAVI already populated (migrated from the file).
3. Edit BRAVI's `baseBranch` to a nonexistent branch name and save — confirm the inline error names the branch.
4. Click "Test" on BURD — confirm it reports success (repo + branch are real) even without the Jira integration configured (remote key check skipped, not blocking).
5. Open Command Center → Triggers → Schedules — confirm "Jira claim poll" is listed, disabled.
6. Confirm `hive/jira-map.json` still exists on disk, unmodified.

- [ ] **Step 5: Final commit (only if any fixups were needed above)**

```bash
git add -A
git commit -m "chore(jira): fix up issues found in end-to-end verification"
```
