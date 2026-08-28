# DeepCode Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DeepCode CLI (`@vegamo/deepcode-cli`) as a full hive-citizen `AgentProvider` — live status via a lifecycle-hook bridge, model selection in the Add-Agent modal — on par with `codex`/`agy`/`grok`.

**Architecture:** DeepCode gets a `{kind:'hooks'}` bridge (the same family as `agy`/`codex`, not the heavier `{kind:'proxy'}` bridge `qwen` uses) because it has a real, if coarse, lifecycle hook (`notify`, fired once per completed turn, context via env vars — no stdin to parse, no response contract to satisfy). Its `.deepcode/settings.json` is read at both user and project level and the two merge, so the hive writes only `notify`/`permissions.defaultMode`/`env.MODEL` into the agent's own cwd, never touching the user's global API key. Because DeepCode has no `--model` CLI flag, model selection needs a small amount of new plumbing (a `model` field carried from the renderer's spawn call through to the settings-file write) that every other provider's flag-splicing already made unnecessary.

**Tech Stack:** TypeScript (Electron main + renderer), Node's built-in `node:test` + `node:assert/strict`, `test/load-ts.cjs` to run TS test targets directly.

**Spec:** `docs/superpowers/specs/2026-08-28-deepcode-provider-design.md`

## Global Constraints

- No CLI flag exists for DeepCode's model selection — it is written into `.deepcode/settings.json`'s `env.MODEL`, never spliced onto argv.
- DeepCode's `permissions.defaultMode` mirrors the hive's `autoMode` toggle: `allowAll` when on, `askAll` when off (DeepCode itself defaults to `allowAll` regardless, so this explicit write is the only way "auto mode off" means anything for this provider).
- An existing project `.deepcode/settings.json` is merged, never overwritten — everything the hive doesn't need to touch (API key, `BASE_URL`, a hand-configured `mcpServers` block) must survive untouched.
- The `deepcode-notify.cjs` shim is written once (idempotent across every agent) to `<hive>/bin/deepcode-notify.cjs`; a write failure degrades to "spawns, but no live status" — never blocks a spawn.
- Every existing provider's spawn/model behavior is unaffected: `modelDeliveredVia` is `undefined` for all of them, and the new `model` field on spawn options simply rides along unused.

---

### Task 1: `deepcode` provider registration in `agentProvider.ts`

**Files:**
- Modify: `src/shared/agentProvider.ts`
- Test: Create `test/deepcode-provider.test.cjs`

**Interfaces:**
- Produces: `'deepcode'` as a valid `AgentProvider` value; `'deepcode'` as a valid `BridgeDescriptor` hooks-shim value; `AgentProviderPreset.modelDeliveredVia?: 'flag' | 'settingsFile'`; a registered preset with `id: 'deepcode'`, `bridge: {kind:'hooks', shim:'deepcode'}`, `modelDeliveredVia: 'settingsFile'`, `initialPromptFlag: '-p'`, `resumeFlag: '--resume'`. Task 2 references `bridgeOf('deepcode')` and the shim id. Task 3 references `providerPreset('deepcode').modelDeliveredVia`.

- [ ] **Step 1: Write the failing test**

Create `test/deepcode-provider.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const ap = loadTs('src/shared/agentProvider.ts');

test('deepcode is a recognized, selectable provider', () => {
  assert.ok(ap.isAgentProvider('deepcode'));
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'deepcode'));
});

test('deepcode preset uses a hooks bridge with the deepcode shim, not a proxy bridge', () => {
  const p = ap.providerPreset('deepcode');
  assert.deepEqual(p.bridge, { kind: 'hooks', shim: 'deepcode' });
  assert.equal(ap.bridgeOf('deepcode')?.kind, 'hooks');
});

test('deepcode preset has no CLI model flag and delivers the model via its settings file instead', () => {
  const p = ap.providerPreset('deepcode');
  assert.equal(p.supportsModel, true);
  assert.equal(p.modelFlag, undefined);
  assert.equal(p.modelDeliveredVia, 'settingsFile');
});

test('deepcode preset takes its initial hive prompt under -p and resumes with --resume', () => {
  const p = ap.providerPreset('deepcode');
  assert.equal(p.initialPromptFlag, '-p');
  assert.equal(p.resumeFlag, '--resume');
});

test('deepcode is not hiveAware (it is not Claude) and has no autoFlag (permissions are file-config, not argv)', () => {
  const p = ap.providerPreset('deepcode');
  assert.equal(p.hiveAware, false);
  assert.equal(p.autoFlag, undefined);
});

test('every existing provider is unaffected: modelDeliveredVia is undefined for all of them', () => {
  for (const p of ap.AGENT_PROVIDER_PRESETS) {
    if (p.id === 'deepcode') continue;
    assert.equal(p.modelDeliveredVia, undefined, `${p.id} should not have modelDeliveredVia set`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deepcode-provider.test.cjs`
Expected: FAIL — `deepcode` is not a recognized provider (first test fails; later tests fail on `providerPreset('deepcode')` returning undefined or throwing).

- [ ] **Step 3: Register the provider**

In `src/shared/agentProvider.ts`, add `'deepcode'` to the `AgentProvider` union (currently lines 24-37):

```ts
export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'kimi'
  | 'gemini'
  | 'antigravity'
  | 'qwen'
  | 'deepcode'
  | 'opencode'
  | 'crush'
  | 'pi'
  | 'copilot'
  | 'cursor'
  | 'custom';
```

Add `'deepcode'` to `BridgeDescriptor`'s hooks-shim union (currently line 54):

```ts
export type BridgeDescriptor =
  | { kind: 'hooks'; shim: 'agy' | 'codex' | 'pi' | 'opencode' | 'grok' | 'gemini' | 'deepcode' }
```

Add the `modelDeliveredVia` field to `AgentProviderPreset` right after the existing `modelFlag?: string;` field:

```ts
  /** Flag that selects the session model, e.g. `--model`. */
  modelFlag?: string;
  /** How a chosen model reaches this CLI. undefined (every existing provider) =
   *  today's behavior: `modelFlag` is spliced onto the spawn command line.
   *  'settingsFile' = this CLI has no model flag; the chosen model is instead
   *  written into its own persistent config before spawn (see the provider's
   *  bridge-install step in hive.ts). Only meaningful when `supportsModel` is
   *  true — set alongside it. */
  modelDeliveredVia?: 'flag' | 'settingsFile';
```

Add the preset entry to `AGENT_PROVIDER_PRESETS`, immediately before the `custom` entry (currently starting at line 568):

```ts
  {
    // DeepCode — a terminal CLI tuned for DeepSeek models (@vegamo/deepcode-cli).
    // Its `notify` hook fires once per COMPLETED TURN (not per tool call) and
    // hands context via env vars, not stdin — no request to parse, no response
    // it reads back (unlike Claude/agy's hooks, which can allow/deny a tool
    // call), so it rides the same {kind:'hooks'} bridge family as agy/codex,
    // just the simplest shim in it. No CLI --model flag exists; the chosen
    // model is written into its own settings.json instead (modelDeliveredVia).
    id: 'deepcode',
    label: 'DeepCode',
    defaultCommand: 'deepcode',
    commandGroups: [],
    // No CLI auto-mode flag — permissions.defaultMode in its own settings.json
    // is the only thing that means anything for this provider (see hive.ts's
    // installDeepcodeSettings).
    autoModeFlag: '',
    supportsModel: true,
    modelDeliveredVia: 'settingsFile',
    hiveAware: false,
    bridge: { kind: 'hooks', shim: 'deepcode' },
    canReceiveInbox: true,
    initialPromptFlag: '-p', // `deepcode -p "<prompt>"`: launches the TUI WITH the prompt submitted (never -x, which runs once and exits)
    resumeFlag: '--resume',
    installCommand: 'npm install -g @vegamo/deepcode-cli',
    docsUrl: 'https://deepcode.vegamo.cn/en'
  },
  {
    id: 'custom',
```

Finally, add `'deepcode'` to the `isAgentProvider` type guard (currently lines 580-595):

```ts
export function isAgentProvider(value: unknown): value is AgentProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'grok' ||
    value === 'kimi' ||
    value === 'gemini' ||
    value === 'antigravity' ||
    value === 'qwen' ||
    value === 'deepcode' ||
    value === 'opencode' ||
    value === 'crush' ||
    value === 'pi' ||
    value === 'copilot' ||
    value === 'cursor' ||
    value === 'custom'
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deepcode-provider.test.cjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0

- [ ] **Step 6: Commit**

```bash
git add src/shared/agentProvider.ts test/deepcode-provider.test.cjs
git commit -m "feat(deepcode): register DeepCode as a hive-aware hooks-bridge provider"
```

---

### Task 2: `deepcode-notify` shim + `installDeepcodeSettings` in `hive.ts`

**Files:**
- Modify: `src/main/hive.ts`
- Test: Create `test/deepcode-settings-merge.test.cjs`

**Interfaces:**
- Consumes: `bridgeOf`/`providerPreset` from Task 1 (`src/shared/agentProvider.ts`) — used only by the dispatch branch, not by `installDeepcodeSettings` itself, which takes plain parameters.
- Produces: `HiveManager.installDeepcodeSettings(meta: AgentMeta, autoMode: boolean, model?: string): void` (private method). `ensureAgent`'s options type gains `model?: string; autoMode?: boolean;` in this task (both optional, so this task's own typecheck passes standalone without needing Task 3's call-site change yet) — the dispatch branch defaults a missing `autoMode` to `true` (matching `HarnessConfig.autoMode`'s own default) before calling `installDeepcodeSettings`, which itself keeps a plain required `boolean` parameter. Task 3 later threads a REAL `autoMode`/`model` from the live config into this same options object, overriding the default.

- [ ] **Step 1: Write the failing test**

Create `test/deepcode-settings-merge.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-deepcode-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function agentCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-deepcode-agent-'));
}

function readSettings(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.deepcode', 'settings.json'), 'utf8'));
}

test('installDeepcodeSettings writes notify + permissions on a fresh cwd with no prior settings file', () => {
  const hive = new HiveManager();
  const cwd = agentCwd();
  hive.installDeepcodeSettings({ id: 'a1', name: 'A', cwd }, true);
  const s = readSettings(cwd);
  assert.equal(s.permissions.defaultMode, 'allowAll');
  assert.ok(s.notify.endsWith('deepcode-notify.cjs'));
  assert.equal(s.env, undefined, 'no model chosen → no stray env key');
});

test('autoMode:false maps to permissions.defaultMode "askAll"', () => {
  const hive = new HiveManager();
  const cwd = agentCwd();
  hive.installDeepcodeSettings({ id: 'a2', name: 'A', cwd }, false);
  const s = readSettings(cwd);
  assert.equal(s.permissions.defaultMode, 'askAll');
});

test('a chosen model is written into env.MODEL', () => {
  const hive = new HiveManager();
  const cwd = agentCwd();
  hive.installDeepcodeSettings({ id: 'a3', name: 'A', cwd }, true, 'deepseek-v4-pro');
  const s = readSettings(cwd);
  assert.equal(s.env.MODEL, 'deepseek-v4-pro');
});

test('an existing settings.json with unrelated fields (API key, BASE_URL, mcpServers) survives untouched', () => {
  const hive = new HiveManager();
  const cwd = agentCwd();
  fs.mkdirSync(path.join(cwd, '.deepcode'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.deepcode', 'settings.json'),
    JSON.stringify({ env: { API_KEY: 'sk-secret', BASE_URL: 'https://api.deepseek.com' }, mcpServers: { github: {} } }),
    'utf8'
  );
  hive.installDeepcodeSettings({ id: 'a4', name: 'A', cwd }, true, 'deepseek-v4-pro');
  const s = readSettings(cwd);
  assert.equal(s.env.API_KEY, 'sk-secret');
  assert.equal(s.env.BASE_URL, 'https://api.deepseek.com');
  assert.equal(s.env.MODEL, 'deepseek-v4-pro');
  assert.deepEqual(s.mcpServers, { github: {} });
  assert.equal(s.permissions.defaultMode, 'allowAll');
});

test('a malformed existing settings.json does not throw — the write proceeds against an empty base', () => {
  const hive = new HiveManager();
  const cwd = agentCwd();
  fs.mkdirSync(path.join(cwd, '.deepcode'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.deepcode', 'settings.json'), '{not valid json', 'utf8');
  assert.doesNotThrow(() => hive.installDeepcodeSettings({ id: 'a5', name: 'A', cwd }, true));
  const s = readSettings(cwd);
  assert.equal(s.permissions.defaultMode, 'allowAll');
});

test('the shim is written once to <hive>/bin/deepcode-notify.cjs, shared across agents', () => {
  const hive = new HiveManager();
  const cwd1 = agentCwd();
  const cwd2 = agentCwd();
  hive.installDeepcodeSettings({ id: 'a6', name: 'A', cwd: cwd1 }, true);
  hive.installDeepcodeSettings({ id: 'a7', name: 'A', cwd: cwd2 }, true);
  const s1 = readSettings(cwd1);
  const s2 = readSettings(cwd2);
  assert.equal(s1.notify, s2.notify, 'both agents point at the same shared shim path');
  assert.ok(fs.existsSync(s1.notify));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deepcode-settings-merge.test.cjs`
Expected: FAIL — `hive.installDeepcodeSettings is not a function`.

- [ ] **Step 3: Add the shim constant**

In `src/main/hive.ts`, add this constant immediately after the existing `AGY_HOOK_SHIM` constant (currently starting at line 2827, ending with its closing backtick):

```js
// ─── deepcode-notify shim (written to <hive>/bin/deepcode-notify.cjs) ────────
// DeepCode's `notify` hook fires ONCE per completed/failed turn (not per tool
// call) and hands context via ENV VARS, not stdin — the simplest bridge shape
// in this family: no request to parse, no response DeepCode reads back (notify
// is fire-and-forget, unlike Claude/agy's hook responses which can allow/deny
// a tool call). This just posts one Stop-shaped HIVE_SOCK payload per turn.
const DEEPCODE_NOTIFY_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const sock = process.env.HIVE_SOCK;
const agentId = process.env.AGENT_ID || null;
if (!agentId || !sock) process.exit(0); // not a hive worker → no-op
const payload = {
  hook_event_name: 'Stop',
  agent_id: agentId,
  status: process.env.STATUS || null,
  fail_reason: process.env.FAIL_REASON || null
};
try {
  const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
  c.on('error', () => {});
  c.on('close', () => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
} catch (_) { process.exit(0); }
`;
```

- [ ] **Step 4: Add `installDeepcodeSettings`**

Add this method to the `HiveManager` class, right after the existing `installAgyHooks` method (currently starting at line 1877 — add it right after that method's closing brace):

```ts
  /** Write (once) the deepcode-notify shim, then merge this agent's OWN
   *  `.deepcode/settings.json` (project-level, scoped by its own cwd — no
   *  CODEX_HOME-style isolation needed) with exactly three fields: `notify`
   *  (the shim path), `permissions.defaultMode` (mirrors hive auto mode:
   *  'allowAll' when on, 'askAll' when off — DeepCode itself defaults to
   *  allowAll regardless, so an explicit write is the only way "auto mode off"
   *  means anything for this provider), and `env.MODEL` (only when the operator
   *  picked one). Everything else already in the file — API key, BASE_URL, a
   *  hand-configured mcpServers block — is preserved untouched. Never throws:
   *  a missing/malformed existing file is treated as `{}`, and any write
   *  failure is logged and degrades to "spawns, but no live status" — the same
   *  philosophy already used for the pi/opencode bridges. */
  installDeepcodeSettings(meta: AgentMeta, autoMode: boolean, model?: string): void {
    const root = this.root();
    if (!root) return;
    const shimPath = join(root, 'bin', 'deepcode-notify.cjs');
    try {
      if (!existsSync(shimPath)) {
        mkdirSync(dirname(shimPath), { recursive: true });
        writeFileSync(shimPath, DEEPCODE_NOTIFY_SHIM, { mode: 0o755 });
      }
    } catch (e) { console.error('[deepcode] could not write notify shim:', e); return; }

    const settingsPath = join(meta.cwd, '.deepcode', 'settings.json');
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(settingsPath)) existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch { existing = {}; }
    const merged = {
      ...existing,
      notify: shimPath,
      permissions: {
        ...(typeof existing.permissions === 'object' && existing.permissions ? existing.permissions : {}),
        defaultMode: autoMode ? 'allowAll' : 'askAll'
      },
      ...(model ? { env: { ...(typeof existing.env === 'object' && existing.env ? existing.env : {}), MODEL: model } } : {})
    };
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    } catch (e) { console.error('[deepcode] could not write project settings.json:', e); }
  }
```

Check the top of `src/main/hive.ts` for its existing `node:fs` import line and confirm `existsSync`, `mkdirSync`, `writeFileSync`, `readFileSync` are already imported (they are used elsewhere in the file, e.g. by `installAgyHooks`) — add any that are missing rather than assuming, and confirm `dirname` is imported from `node:path` (also already used elsewhere in this file for the shim paths) the same way.

- [ ] **Step 5: Wire the dispatch branch**

Find the existing dispatch line `if (desc.shim === 'agy') this.installAgyHooks();` (currently at line 774) and add a sibling branch immediately after it:

```ts
if (desc.shim === 'agy') this.installAgyHooks();
if (desc.shim === 'deepcode') this.installDeepcodeSettings(meta, opts.autoMode ?? true, opts.model);
```

`?? true` matches `HarnessConfig.autoMode`'s own default (`src/main/config.ts`'s `DEFAULTS.autoMode: true`) — so a caller that doesn't yet pass `autoMode` (i.e., before Task 3 wires the real one through) gets the same default the rest of the app already assumes, rather than an undefined-behaves-as-false surprise.

This is inside `ensureAgent`, so `opts` here is `ensureAgent`'s own second parameter. Extend that parameter's inline type (currently spanning lines 614-637, ending with `extraWritableDirs?: string[];` before its closing `} = {}`) to add two new fields, right after `extraWritableDirs`:

```ts
      extraWritableDirs?: string[];
      /** Chosen model for a provider whose model has no CLI flag (currently
       *  only 'deepcode') — written into that provider's own settings file
       *  instead of spliced onto argv. Ignored by every other provider. */
      model?: string;
      /** Mirrors the hive's global auto-mode toggle. Currently read only by
       *  the deepcode bridge install (permissions.defaultMode); every other
       *  provider's auto-mode behavior is still driven by its own CLI flag,
       *  spliced in the renderer's buildSpawnCommand, unaffected by this.
       *  Optional — undefined defaults to `true` at the one call site that
       *  reads it (see the dispatch branch above), matching
       *  HarnessConfig.autoMode's own default, so this task's own typecheck
       *  passes without needing Task 3's call-site change first. */
      autoMode?: boolean;
    } = {}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/deepcode-settings-merge.test.cjs`
Expected: PASS (6 tests)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck:node`
Expected: exits 0 — both `model` and `autoMode` are optional additions to `ensureAgent`'s options type, so the existing call site in `src/main/index.ts` (unmodified until Task 3) keeps compiling exactly as it did before this task.

- [ ] **Step 8: Commit**

```bash
git add src/main/hive.ts test/deepcode-settings-merge.test.cjs
git commit -m "feat(deepcode): add notify shim and per-agent settings.json bridge install"
```

---

### Task 3: Thread `model` from the Add-Agent modal through to spawn, and wire `ensureAgent`'s new options

**Files:**
- Modify: `src/preload/index.ts` (add one field to `SpawnPtyOptions`)
- Modify: `src/main/index.ts` (add one field to the `AgentSpawnOptions` type alias; extend the `ensureAgent` call site)
- Modify: `src/renderer/src/components/AddAgentModal.tsx`, `src/renderer/src/components/CommandCenterPanel.tsx`, `src/renderer/src/hooks/useHive.ts`, `src/renderer/src/hooks/useRestoreTeam.ts` (thread the already-in-scope `model` value into each `spawnPty({...})` call)

**Interfaces:**
- Consumes: `HiveManager.installDeepcodeSettings` (Task 2), `AgentProviderPreset.modelDeliveredVia` (Task 1, referenced only in the spec's rationale — no code in this task actually branches on it, since the fix is "thread `model` through unconditionally; every non-deepcode provider already ignores an extra field it doesn't ask for").
- Produces: nothing further downstream — this is the last task. `ensureAgent`'s optional `autoMode`/`model` fields (Task 2) get a real, live value from this task's call site, overriding Task 2's `?? true` default.

This task is integration glue across several files, each edited identically in shape (thread one already-in-scope variable into one already-existing object literal) — no dedicated new unit test for the plumbing itself (mirrors how the previous feature's equivalent wiring task, Task 6 of the Obsidian vault sync plan, was verified by typecheck + full suite + a manual smoke test rather than a new test file). The plumbing's actual correctness is proven at the `hive.ts` boundary already, by Task 2's tests (`installDeepcodeSettings` receiving a real `model` value and writing it correctly) — this task's job is only to prove that value actually reaches that boundary from the UI, which typecheck (every `spawnPty` call is a typed object literal — an omitted required field or a typo'd key fails to compile) plus the manual smoke test cover.

- [ ] **Step 1: Add `model` to `SpawnPtyOptions`**

In `src/preload/index.ts`, in the `SpawnPtyOptions` interface (currently starting at line 200), add one field — anywhere among its existing optional fields is fine, e.g. right after `provider?: AgentProvider;`:

```ts
  /** Which CLI to spawn; usually inferred from `command` in the main process. */
  provider?: AgentProvider;
  /** Chosen model, for a provider whose model has no CLI flag and instead needs
   *  it written into that provider's own settings file (currently only
   *  'deepcode' — see AgentProviderPreset.modelDeliveredVia). Every other
   *  provider already gets its model spliced onto `command` by
   *  buildSpawnCommand and ignores this field. */
  model?: string;
```

- [ ] **Step 2: Add `model` to `AgentSpawnOptions` and thread it into the `ensureAgent` call**

In `src/main/index.ts`, find the `AgentSpawnOptions` type alias (currently line 2554):

```ts
type AgentSpawnOptions = SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean; requireResume?: boolean; resumeSessionId?: string; provider?: AgentProvider; noAutoInstall?: boolean };
```

Add `model?: string;` to it:

```ts
type AgentSpawnOptions = SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean; requireResume?: boolean; resumeSessionId?: string; provider?: AgentProvider; noAutoInstall?: boolean; model?: string };
```

Find the `hive.ensureAgent(...)` call (currently starting at line 2733) and add `model` and `autoMode` to its options object, right after the existing `extraWritableDirs` field:

```ts
      const inj = await hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        {
          semanticMemory: memory.active(),
          knowledgeGraph: knowledge.active(),
          kgCliPath: knowledge.env().KG_CLI,
          theme: readConfig().terminalTheme ?? 'light',
          mcpDefaults: readConfig().mcpDefaults,
          skillsDir: skillsResourceDir(),
          extraWritableDirs: [memory.env().MEMPALACE_PALACE_PATH].filter((p): p is string => !!p),
          model: opts.model,
          autoMode: readConfig().autoMode
        }
      );
```

(Keep every existing field exactly as it is — only the two new ones are added. The exact surrounding comments in the current file are fine to leave in place; this shows only the object literal's fields for clarity.)

- [ ] **Step 3: Thread `model` at each renderer `spawnPty` call site**

Four files, five call sites, each adding one line to an existing object literal — a value that is ALREADY in scope at that exact point in the code (verified: each site already reads that same variable one or two lines earlier, either to build the display command via `buildSpawnCommand` or directly off a stored agent record):

In `src/renderer/src/components/AddAgentModal.tsx`, the `spawnPty({...})` call (currently starting at line 406) already has `model` in scope (component state from `const [model, setModel] = useState<string | undefined>(...)` at line 199). Add `model,` to the object literal, e.g. right after `provider,`:

```ts
    const spawnRes = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      provider,
      model,
      args,
      cols: 100,
      rows: 30,
```

In `src/renderer/src/components/CommandCenterPanel.tsx`, the `spawnPty({...})` call (currently starting at line 498) already has `model` in scope (used one line above at `const command = buildSpawnCommand(cfg, model, provider);`). Add `model,` to the object literal, e.g. right after `provider,`:

```ts
      const res = await window.cth.spawnPty({
        id: a.ptyId,
        cwd: a.cwd,
        command: exe,
        args,
        provider,
        model,
        cols,
        rows,
```

In `src/renderer/src/hooks/useHive.ts`, there are TWO call sites:
1. The god-spawn call (currently starting at line 403), where `godModel` is in scope (used one line above at `const command = buildSpawnCommand(config, godModel, godProvider);`). Add `model: godModel,` to the object literal, e.g. right after `provider: godProvider,`:

```ts
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.harnessHome!,
        command: exe,
        provider: godProvider,
        model: godModel,
        args,
        cols: 100,
        rows: 30,
```

2. The revive call (currently starting at line 1215), where `a.model` is in scope (the same `a` object used two lines above at `const command = (a.command ?? '').trim() || buildSpawnCommand(cfg, a.model, provider);`, at line 1203). Add `model: a.model,` to the object literal, e.g. right after `provider,`:

```ts
        const res = await window.cth.spawnPty({
          id: deadId,
          cwd,
          command: exe,
          provider,
          model: a.model,
          args,
          cols,
          rows,
```

In `src/renderer/src/hooks/useRestoreTeam.ts`, the restore call (currently starting at line 132), where `a.model` is in scope (the same `a` object used a few lines above at `const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');`, at line 103). Add `model: a.model,` to the object literal, e.g. right after `provider,`:

```ts
          const res = await window.cth.spawnPty({
            id: ptyId,
            cwd,
            command: exe,
            provider,
            model: a.model,
            args,
            cols: 100,
            rows: 30,
```

(`src/renderer/src/components/EditAgentModal.tsx` does NOT call `spawnPty` — its `buildSpawnCommand` call at line 78 only builds a command string that gets persisted via `updateAgent(...)`, and any actual respawn later goes through one of the call sites above, reading the persisted `model` back off the stored agent record. No change needed there.)

- [ ] **Step 4: Typecheck both processes**

Run: `npm run typecheck:node`
Expected: exits 0

Run: `npm run typecheck:web`
Expected: exits 0

- [ ] **Step 5: Run the full regression suite**

Run: `npm run test:focused`
Expected: all tests pass, including Task 1's and Task 2's new files, with no regressions

- [ ] **Step 6: Manual smoke test**

1. `npm run dev`
2. In the Add-Agent modal, select provider `DeepCode`, pick a model (or type one), point the agent at a real directory, and spawn it.
3. Confirm `<that directory>/.deepcode/settings.json` was created with the expected `notify`/`permissions.defaultMode`/`env.MODEL` shape.
4. Let the agent complete one turn (or a short interactive exchange) and confirm the office-floor card transitions to idle after it — proving the `deepcode-notify.cjs` shim's `Stop` payload reached `HIVE_SOCK` and the existing `HookServer` handled it exactly as it does for every other provider's Stop event.
5. If DeepCode isn't installed in this environment, install it first: `npm install -g @vegamo/deepcode-cli` (matches the preset's `installCommand`), or note in the task report that this step could not be attempted and why — same convention as the previous feature's Task 6, which disclosed its own inability to run a live Electron smoke test in a non-interactive session rather than skipping the step silently.

- [ ] **Step 7: Commit**

```bash
git add src/preload/index.ts src/main/index.ts src/renderer/src/components/AddAgentModal.tsx src/renderer/src/components/CommandCenterPanel.tsx src/renderer/src/hooks/useHive.ts src/renderer/src/hooks/useRestoreTeam.ts
git commit -m "feat(deepcode): thread chosen model from Add-Agent modal through to spawn"
```
