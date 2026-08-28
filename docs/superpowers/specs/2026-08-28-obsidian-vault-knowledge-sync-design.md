# Obsidian Vault → Knowledge Graph Sync (Design, v1)

**Feature:** Per-project, provider-agnostic access to an Obsidian vault's project notes
**Status:** design, not yet implemented
**Flag:** `knowledgeGraph.enabled` (existing) + `knowledgeGraph.vaultSync.enabled` (new) — both default **OFF**, zero behaviour change when off

---

## 1. Goal & scope

The user keeps a personal "second brain" in Obsidian (`~/Documents/Obsidian/SecondBrain`), organized with one folder per client/project under `01-Projects`, that self-updates daily. They want every hive agent — regardless of which CLI/model it runs (Claude, Codex, DeepCode, Antigravity, …) — to be able to query the notes for **its own project only**, the same way agents already query the existing enterprise Knowledge Graph (`kg search "<query>"`, documented in `docs/design/knowledge-graph.md`) or MemPalace.

This is **not** a new connector. It is:
1. A **sync job** that ingests markdown notes from mapped vault folders into the existing KG store, kept fresh on a daily cadence.
2. A **per-project isolation layer** on top of the existing (currently single, global) KG store, so an agent assigned to one client's repo can never see another client's notes.

Rejected explicitly during brainstorming: an MCP server per CLI provider (the user's own objection — doesn't scale across non-Claude providers, and MCP config lives per-CLI, not centrally). The existing `kg` CLI mechanism is already provider-agnostic (verified in code: the prompt line that teaches `kg search` is injected for both Claude and non-Claude/non-hiveAware providers — see `src/main/hive.ts`, the `injectedPrompt`/`isHiveAwareProvider` branch around line 748).

## 2. Non-goals (v1)

- **Multimodal ingestion.** Only `*.md` files are synced. PDFs/images/attachments in the vault are ignored. (User's explicit choice — narrower scope, avoids accidentally ingesting sensitive non-text material.)
- **Sub-daily / real-time sync.** The job runs once per day (plus once at app start if a day has elapsed since `lastSyncAt`). Not a file watcher.
- **A shared, cross-project knowledge layer.** Every agent gets exactly one `KG_ROOT`: its own project's if resolved, otherwise the existing global/manual store, unchanged. No agent ever sees two stores at once. (If a genuinely shared layer is wanted later, it's a clean v2 addition — not required today.)
- **Feeding the vault's own writing/formatting conventions into the Curator agent's `goal`.** The user mentioned this vault has house rules for how notes should be written, and wants the Curator (see `munder-difflin-hires/angela-curator.hire.json`) instructed to follow them when it writes summaries back. Deferred — needs the actual rules read from the vault first (blocked today on macOS Full Disk Access for this session; see §9).
- **Writing back to the vault.** This is read-only ingestion. No agent writes into Obsidian.
- **A general-purpose project registry** shared with the (separately paused) Jira-ingestion design. The project↔repo mapping introduced here is scoped to this feature only.

## 3. Architecture

The retrieval/ingestion engine (`resources/kg-core.cjs`: `ingest`, `search`, `list`, `getDoc`, `removeDoc`, `stats`) already takes a `root` directory as an explicit parameter — it has no notion of "the one global store" baked in. Only the `KnowledgeManager` façade (`src/main/knowledge.ts`) and today's config (`knowledgeGraph.rootPath`, singular) assume one store for the whole app.

This design adds a **second, additive root convention** — one physically separate directory per mapped project — without touching the existing global store or its manual "add files" UI:

```
<userData>/knowledge/                  ← existing global store, UNCHANGED
<userData>/knowledge/projects/<slug>/  ← NEW: one isolated store per mapped project
```

A daily job scans each mapped Obsidian folder and ingests/reconciles its notes into that project's own store. When an agent is spawned, its project is resolved from its working directory's git `origin` (never its filesystem path — a worktree's path differs from its parent repo, but the origin is identical; this is the same lesson already encoded in the hive's `PROJECT BOUNDARY` standing rule). The resolved project's store — or, if unresolved, the existing global store — is the *only* `KG_ROOT` that agent ever receives. Physical directory separation is the isolation boundary, not a filter inside a shared index: a bug in a filter is a cross-client data leak, a bug in a path is a missing feature.

## 4. Config

Extend `KnowledgeGraphConfig` in `src/main/config.ts`:

```ts
export interface KnowledgeGraphConfig {
  enabled?: boolean;       // existing master switch
  rootPath?: string;       // existing — global/manual store override
  vaultSync?: VaultSyncConfig;   // NEW
}

export interface VaultSyncConfig {
  enabled?: boolean;              // default false — sync job is fully opt-in
  vaultPath?: string;             // e.g. "~/Documents/Obsidian/SecondBrain"
  projects?: VaultProjectMapping[];
  lastSyncAt?: number;            // epoch ms of the last completed run (partial or full)
}

export interface VaultProjectMapping {
  /** Stable id — becomes the `<userData>/knowledge/projects/<slug>/` folder name.
   *  Free-form but should be filesystem-safe (lowercase, hyphens); not required to
   *  match the repo folder name or the vault folder name (both differ in practice —
   *  see §9 naming survey). */
  slug: string;
  /** `git remote get-url origin` output for the target repo, verbatim. Matched by
   *  exact string against the agent's resolved cwd origin — never the filesystem
   *  path. */
  repoOrigin: string;
  /** Folder name directly under `vaultPath` (today: under `01-Projects`, but the
   *  config stores the full relative path from `vaultPath` so the user isn't
   *  locked into that one subfolder if the vault is reorganized), e.g.
   *  "01-Projects/BurdaStyle". */
  vaultFolder: string;
}
```

Both `knowledgeGraph.enabled` and `knowledgeGraph.vaultSync.enabled` must be true for any of this to run — matching the existing "everything dark when off" convention for this feature. If only the former is on, behavior is exactly what it is today (manual global store, no vault sync, no per-project stores).

## 5. Components

### 5.1 Project resolution — `src/main/knowledgeVaultSync.ts` (new file)

```ts
export function resolveProjectForCwd(
  cwd: string,
  mappings: VaultProjectMapping[]
): VaultProjectMapping | null
```

Runs `git -C <cwd> remote get-url origin` (async, short timeout, swallow errors → null). Trims the result and matches it exactly against each mapping's `repoOrigin`. Works unmodified for a worktree cwd, since git resolves `origin` through to the parent repo transparently (verified manually this session against `motta-burdastyle` and its `dwight-mtcttd07` worktree — both report the same origin).

### 5.2 `KnowledgeManager` changes — `src/main/knowledge.ts`

- New method `projectRoot(slug: string): string` → `join(<userData>/knowledge/projects, slug)`. Existing `root()` is untouched.
- `env()` gains an optional parameter: `env(projectSlug?: string | null): Record<string,string>`. When `active()` and a non-null `projectSlug` is given, returns `KG_ROOT` = `projectRoot(slug)` (plus the existing `KG_CLI`/`KG_CORE`, unchanged). Otherwise falls back to today's exact behavior (`root()`, the global/manual store). The agent-facing contract (`kg search`, `kg list`, `kg get`) and the injected prompt line are **unchanged** — only which directory `KG_ROOT` points at changes.
- New method `ingestFileInto(root: string, srcPath: string, opts): {...}` — thin wrapper calling `core.ingest(root, {srcPath, ...opts})` directly (bypassing the implicit `this.root()`), so the sync job can target a project's store explicitly. `removeDocFrom(root, docId)` similarly wraps `core.removeDoc`.

### 5.3 Sync job — `src/main/knowledgeVaultSync.ts`

```ts
export async function runVaultSync(
  cfg: VaultSyncConfig,
  knowledge: KnowledgeManager
): Promise<{ projects: Array<{ slug: string; added: number; updated: number; removed: number; errors: string[] }> }>
```

For each mapping in `cfg.projects`:
1. `folder = join(expandTilde(cfg.vaultPath), mapping.vaultFolder)`. Missing folder → record an error for that project, skip it, continue with the rest (never abort the whole run).
2. Recursively list `*.md` files under `folder` (skip dotfiles/dot-directories, e.g. Obsidian's own `.obsidian/`).
3. Load the project's sync-state file, `<projectRoot>/.vault-sync-state.json`: `{ [relPath]: { sha256: string; docId: string } }`. Missing/unreadable → treat as empty (first run).
4. For each current file: compute its sha256. New path, or changed hash → if a prior `docId` exists for that path, `removeDocFrom(projectRoot, oldDocId)` first (an edited note must not accumulate duplicate chunks), then `ingestFileInto(projectRoot, fullPath, { title: <filename without .md>, tags: ['obsidian', mapping.slug] })`; record the new `{sha256, docId}`.
5. For each path present in the OLD state but absent from the current file list (deleted or renamed in Obsidian) → `removeDocFrom(projectRoot, docId)`, drop it from the state. (A rename is a delete + an add under the new name — acceptable for v1; content is never lost from search, just re-indexed under its new title.)
6. Write the updated state file. Per-file errors are caught individually and appended to that project's `errors[]` — one bad file never blocks the rest of the project, and one project's failure never blocks the others.
7. On completion (even partial), update `knowledgeGraph.vaultSync.lastSyncAt` via `writeConfig`.

### 5.4 Scheduling — `src/main/index.ts`

Mirrors the existing `slackDoneTimer`/`webhookDoneTimer` pattern (simple `setInterval`, started near `app.whenReady()`, guarded so it's a no-op when the feature is off):

- On start: if `vaultSync.enabled` and `Date.now() - (lastSyncAt ?? 0) > 24h`, run once immediately (covers "app was closed all day, catch up now").
- Then `setInterval(() => void runVaultSync(...), 24 * 60 * 60 * 1000)`.
- An in-flight guard (boolean) prevents an overlapping run if a previous one is somehow still going.

### 5.5 Spawn wiring — `src/main/index.ts:2715`

```ts
// before
opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env() };
// after
const projectSlug = resolveProjectForCwd(meta.cwd, readConfig().knowledgeGraph?.vaultSync?.projects ?? [])?.slug ?? null;
opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env(projectSlug) };
```

`kgCliPath` at line 2697 (`knowledge.env().KG_CLI`) is unaffected — `KG_CLI`/`KG_CORE` never change, only `KG_ROOT` does.

## 6. Data flow

1. App starts, or 24h have elapsed → `runVaultSync` fires (if both flags are on).
2. For each mapped project, the job diffs its vault folder against the last-known state, ingests new/changed notes into that project's *own* store under `<userData>/knowledge/projects/<slug>/`, and prunes notes removed from the vault.
3. When an agent is spawned, `resolveProjectForCwd(meta.cwd, mappings)` determines its project from its cwd's git origin.
4. `knowledge.env(slug)` returns that project's `KG_ROOT` (or the untouched global store if unresolved), merged into the agent's spawn env exactly as today.
5. The agent runs `kg search "<query>"` — unchanged CLI, unchanged prompt-injection line — and only ever sees its own project's notes.

## 7. Error handling

- Vault path missing/unreadable, a mapped folder missing, or a single note unreadable → logged, that item skipped, everything else proceeds. Never a crash, never blocks agent spawn (spawn always falls back to "no project resolved → global store" if resolution or the KG subsystem errors).
- `git remote get-url origin` failing (not a git repo, no origin) → `resolveProjectForCwd` returns `null`, agent gets the existing global-store behavior — never an error, never a stall.
- These follow the codebase's existing defensive convention (e.g. `copyBundledSkills` in `hive.ts`): best-effort, fully tolerant, an IO error is swallowed and logged rather than propagated.

## 8. Testing plan

- **Unit — `resolveProjectForCwd`:** match, no-match, multiple mappings, a worktree cwd resolving to its parent's origin.
- **Unit — sync diff logic:** against a temp-dir fake vault — add, modify (hash change + old-doc removal), delete (removed from state + `removeDoc` called), and a no-op pass (nothing re-ingested when nothing changed) — asserted via `kg-core`'s own `list()`/`getDoc()`.
- **Manual E2E:** enable both flags, map `motta-burdastyle` (vault folder `01-Projects/BurdaStyle`, this session's verified origin `git@bitbucket.org:magenio/burdastyle.git`) and `bravifarmacie` (vault folder `01-Projects/Bravi Farmacie`, origin `git@bitbucket.org:magenio/bravifarmacie.git`) — exact vault folder names to be confirmed by the user against the real vault (see §9); run a sync; spawn an agent on each repo and confirm `kg search` returns only that project's notes.

## 9. Open items / future work

- **Curator writing-rules ingestion (deferred by user request this session).** The vault has house rules for how notes should be written; once this sync ships, read them (needs Full Disk Access granted to this session's terminal, or the user pasting the relevant note) and fold them into `munder-difflin-hires/angela-curator.hire.json`'s `goal` so the Curator writes summaries back in the vault's own style.
- **Exact vault folder names.** This session could not list `~/Documents/Obsidian/SecondBrain` directly (macOS TCC blocked it even after the user's attempted grant). Folder names above come from a screenshot and the user's direct answers; confirm exact spelling (including the space in "Bravi Farmacie") before configuring `vaultProjectMapping` entries.
- **Non-project vault folders.** `01-Projects` contains several folders with no corresponding munder-difflin repo (Accenture Partnership, HRM, JTI, PersonalAI, …). These are simply never mapped — no code needs to know they exist.
