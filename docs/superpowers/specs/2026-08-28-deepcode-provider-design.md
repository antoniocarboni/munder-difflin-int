# DeepCode Provider Integration (Design, v1)

**Feature:** First-class `AgentProvider` support for DeepCode CLI (`@vegamo/deepcode-cli`)
**Status:** design, not yet implemented
**Flag:** none — a new provider choice is additive; existing providers are unaffected

---

## 1. Goal & scope

Add DeepCode (a terminal coding CLI tuned for DeepSeek models, `@vegamo/deepcode-cli`) as a full hive-citizen provider, on par with `codex`/`agy`/`grok` — live status on the office floor, Stop-triggered inbox drain, model selection in the Add-Agent modal — not the "custom command" fallback (zero live status, zero bridge).

Ground truth for this spec comes from the CLI actually installed on the user's machine (`/Users/shaibon/.local/bin/deepcode`, `@vegamo/deepcode-cli@0.3.1`) — its `--help` output and its own bundled docs (`bundled/deepcode-self-refer/references/{notify,permission}.md`), not the marketing page, which under-documents the CLI surface.

## 2. Non-goals (v1)

- **MCP wiring for DeepCode.** It supports MCP (`mcpServers` in its `settings.json`, `/mcp` to inspect), but this spec only adds the provider/bridge — connecting it to the app's own MCP catalog is a separate, later piece of work if wanted.
- **Fine-grained live status.** DeepCode's only lifecycle signal is its `notify` hook, which fires once per *completed turn* — there is no PreToolUse/PostToolUse equivalent. A DeepCode agent's card will show idle ⇄ busy, never "running tool X." This already matches the app's existing `pi`/`opencode` bridges, which are similarly coarse — not a new class of limitation.
- **A `deepcode` hook_event_name beyond `Stop`.** The shim only ever emits one event.
- **Windows support beyond what git-portable shell scripting already gives every other provider.** DeepCode ships a Node CLI; nothing here is POSIX-only, but it hasn't been verified on Windows this session.

## 3. Architecture

DeepCode fits the app's existing `{kind:'hooks'}` bridge shape (`src/shared/agentProvider.ts`'s `BridgeDescriptor`) — the same family as `agy`/`codex`/`pi`/`opencode`/`grok` — **not** the `{kind:'proxy'}` shape `qwen` uses. The distinction that matters: a proxy bridge exists because a CLI has *no* hook surface at all and the app has to sniff its LLM traffic to synthesize status; DeepCode has a real, documented lifecycle hook (`notify`, configured in `settings.json`), just a coarser one (env vars, not JSON stdin/stdout, and one event instead of several). That makes it the *simplest* shim in the family: no stdin to parse, no response contract to satisfy (`notify` is fire-and-forget — DeepCode never reads the script's output as a decision, unlike Claude/agy's hook responses which can allow/deny a tool call).

Two things about DeepCode's own design map cleanly onto how the hive already isolates a Claude agent's per-session `settings.json`:
- `settings.json` is read at **project level** (`./.deepcode/settings.json`) as well as user level (`~/.deepcode/settings.json`), and the two merge — so the hive can write only what it needs (`notify`, `permissions.defaultMode`, `env.MODEL`) into the agent's own cwd/worktree without touching the user's global API key/`BASE_URL`.
- Because that project-level file is scoped to `cwd`, and every isolated hive agent already has its own `cwd` (a worktree), **no extra isolation mechanism is needed** — unlike Codex, which needed a dedicated per-agent `CODEX_HOME` because its own config has no natural per-project scope.

## 4. Components

### 4.1 `src/shared/agentProvider.ts`

- Add `'deepcode'` to the `AgentProvider` union.
- Add `'deepcode'` to `BridgeDescriptor`'s `{kind:'hooks'; shim: ...}` union.
- Add a new field to `AgentProviderPreset`:
  ```ts
  /** How a chosen model reaches this CLI. undefined (every existing provider) =
   *  today's behavior: `modelFlag` is spliced onto the spawn command line.
   *  'settingsFile' = this CLI has no model flag; the chosen model is instead
   *  written into its own persistent config before spawn (see the provider's
   *  bridge-install step). Only meaningful when `supportsModel` is true. */
  modelDeliveredVia?: 'flag' | 'settingsFile';
  ```
- New preset entry:
  ```ts
  {
    id: 'deepcode',
    label: 'DeepCode',
    defaultCommand: 'deepcode',
    commandGroups: [], // no slash-command reference exists yet for this CLI; empty is valid (matches a provider with no bundled reference)
    autoModeFlag: '', // no CLI flag — see §4.2, permissions are file-config, not argv
    supportsModel: true,
    modelDeliveredVia: 'settingsFile',
    hiveAware: false,
    bridge: { kind: 'hooks', shim: 'deepcode' },
    canReceiveInbox: true,
    initialPromptFlag: '-p',
    resumeFlag: '--resume',
    installCommand: 'npm install -g @vegamo/deepcode-cli',
    docsUrl: 'https://deepcode.vegamo.cn/en'
  }
  ```
  `autoFlag` is intentionally omitted (undefined) — there is no flag; the auto/manual distinction is expressed entirely through the settings-file write in §4.2.

### 4.2 `src/main/hive.ts` — shim + settings-file bridge install

Add a shim constant next to the existing `AGY_HOOK_SHIM`/`HOOK_SHIM`:

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

New method, called from the same `!isHiveAwareProvider` bridge-install branch that already dispatches on `desc.shim` (where `agy`/`codex` are installed today):

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
private installDeepcodeSettings(meta: AgentMeta, autoMode: boolean, model?: string): void {
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

Dispatch: alongside the existing `if (desc.shim === 'agy') this.installAgyHooks();` line (inside `hive.ensureAgent`, `src/main/hive.ts`), add `if (desc.shim === 'deepcode') this.installDeepcodeSettings(meta, opts.autoMode, opts.model);` — `opts` here is `ensureAgent`'s existing second parameter (the options object that already carries `semanticMemory`/`knowledgeGraph`/`kgCliPath`/etc.), extended per §4.3 below.

### 4.3 Getting the chosen model from the renderer to `installDeepcodeSettings`

**Verified, not assumed** — this needed checking because `buildSpawnCommand`'s existing guard (`src/renderer/src/store/config.ts:350`, `if (preset.supportsModel && model && preset.modelFlag)`) already skips splicing when `modelFlag` is unset, which DeepCode's preset leaves unset on purpose (§4.1). That's correct — it stops a bogus flag from being spliced — but it means the chosen model is silently dropped in the renderer today and never reaches main at all, for ANY provider with `supportsModel: true` and no `modelFlag`. `AgentMeta` (`src/main/hive.ts:133`) has no `model` field either, and `SpawnPtyOptions` (`src/preload/index.ts:200`) has no `model` field — the model value genuinely only exists today baked into the composed command string. This needs real (small) plumbing, not just a branch in an existing function:

1. **`src/preload/index.ts`** — add one field to `SpawnPtyOptions`: `model?: string`.
2. **Renderer call sites** — every caller of `buildSpawnCommand(cfg, model, provider)` already has `model` in scope by construction (it's the same variable passed to `buildSpawnCommand`). Add `model` to the `spawnPty({...})` payload alongside it, at each of: `CommandCenterPanel.tsx:487`, `EditAgentModal.tsx:78`, `AddAgentModal.tsx` (the `spawnPty` call built from its local form state), `useHive.ts:401` and `:1203`, `useRestoreTeam.ts:103`.
3. **`src/main/index.ts`**, the `ensureAgent` call site (~line 2688, shown in §5): add `model: opts.model` and `autoMode: readConfig().autoMode` to the second argument object, alongside the existing `semanticMemory`/`knowledgeGraph`/`kgCliPath`/etc. fields.
4. **`hive.ensureAgent`'s options type** (`src/main/hive.ts`, wherever that second parameter's shape is declared) — add `model?: string; autoMode: boolean;` to it, threaded to the `installDeepcodeSettings` dispatch in §4.2.

Every existing provider is unaffected: `model` simply rides along unused for them (their command-string splicing in `buildSpawnCommand` already works and is untouched).

## 5. Data flow

1. Operator picks provider `DeepCode` and (optionally) a model in the Add-Agent modal — the modal's existing model picker UI is unchanged; only where the choice ends up differs per `modelDeliveredVia`.
2. On spawn, `hive.ensureAgent` sees `bridgeOf('deepcode') = {kind:'hooks', shim:'deepcode'}`, calls `installDeepcodeSettings(meta, opts.autoMode, opts.model)` (the model and auto-mode flag having traveled renderer → `spawnPty` → `ensureAgent`'s options, per §4.3) — this writes the shim once (idempotent across agents) and merges this agent's own `.deepcode/settings.json`.
3. The hive spawns `deepcode -p "<injected hive protocol prompt>"` in a persistent PTY (same interactive-session model every provider uses — never `-x` exec mode, which would run one prompt and exit, incompatible with a long-lived hive worker).
4. The agent works through its normal TUI. When a turn completes (success or failure), DeepCode runs the configured `notify` script — `deepcode-notify.cjs` posts one `{hook_event_name:'Stop', agent_id, status, fail_reason}` payload to `HIVE_SOCK`.
5. The existing `HookServer` handles that `Stop` event exactly as it does for every other provider's Stop: status → idle, inbox drained, eligible for the next mail delivery.

## 6. Error handling

- Shim write failure, or settings.json write failure → logged, spawn proceeds regardless (a DeepCode agent that can't get live status still works — it's a degraded floor experience, never a blocked spawn).
- An existing project `.deepcode/settings.json` that is present but unparseable → treated as `{}`; the hive's write proceeds and the malformed content is replaced (there is nothing meaningful to preserve from JSON that doesn't parse).
- `HIVE_SOCK` unset or connection failure at notify-time (the shim's own runtime, not the hive's) → the shim exits 0 silently — DeepCode's `notify` execution must never be visibly disrupted by a hive-side problem, matching every other shim's fail-open philosophy.

## 7. Testing plan

- **Unit — settings-file merge (`installDeepcodeSettings`, or the pure merge function it's built from, extracted for testability):**
  - No existing file → writes `{ notify, permissions: { defaultMode }, }` (no stray `env` key when no model was chosen).
  - Existing file with unrelated fields (`env.BASE_URL`, `env.API_KEY`, a hand-written `mcpServers` block) → those survive untouched; only `notify`/`permissions.defaultMode`/`env.MODEL` change.
  - `autoMode: true` → `defaultMode: "allowAll"`; `autoMode: false` → `defaultMode: "askAll"`.
  - Malformed existing JSON → does not throw; write proceeds against `{}`.
- **Unit — model plumbing reaches `installDeepcodeSettings`:** a spawn-path test (or an integration test around the `ensureAgent` call site) confirming a `model` value passed into `spawnPty` ends up in the written `.deepcode/settings.json`'s `env.MODEL` — the one part of this feature that's plumbing across several files rather than one self-contained function, so it's the one most likely to silently regress.
- **Manual E2E:** add a DeepCode agent via the modal (with a model chosen), confirm `<cwd>/.deepcode/settings.json` has the expected merged shape, let it complete one turn, confirm the office-floor card flips to idle and the hive's inbox-drain fires (same observable behavior already used to smoke-test the `agy`/`codex` bridges).

## 8. Open items / future work

- **MCP wiring** (non-goal above) — a natural v2 once this lands, reusing the app's existing MCP catalog/consent model.
- **`commandGroups: []`** — no slash-command reference file exists yet for DeepCode in this codebase (unlike `CLAUDE_COMMAND_GROUPS`/`CODEX_COMMAND_GROUPS`/`GROK_COMMAND_GROUPS`). An empty array is valid today (some UI surface may simply show nothing to reference), but a real reference doc would be a nice small follow-up.
- **`recommendedOrchestratorModel`** left unset — no strong case yet for DeepCode ever powering "Michael" (the god orchestrator); can be added later with a concrete recommendation if a user wants that.
