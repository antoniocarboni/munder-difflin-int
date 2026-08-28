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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { VaultSyncConfig } from './config';
import type { KnowledgeManager } from './knowledge';
import { expandTilde } from './fs';

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
    try {
      if (!statSync(folder).isDirectory()) {
        result.errors.push(`mapped path is not a directory: ${folder}`);
        continue;
      }
    } catch (e) {
      result.errors.push(`could not stat ${folder}: ${e instanceof Error ? e.message : String(e)}`);
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
        const content = await readFile(filePath, 'utf8');
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
        // A transient failure on a file that was already tracked must not
        // drop its state: without this, the next run would see no prevState
        // entry for it, treat the (unchanged) file as brand-new, and
        // ingestFileInto it again without a prior removeDocFrom — producing
        // a duplicate doc for content that never actually changed.
        if (prevState[relPath]) nextState[relPath] = prevState[relPath];
      } finally {
        // `runVaultSync` is invoked unconditionally at app.whenReady() on first
        // enable, and every file's read/hash/ingest below is synchronous work
        // (kg-core's ingest/removeDoc do writeFileSync/appendFileSync,
        // including a full index.jsonl rewrite per removeDoc). Without a yield
        // here, a large first sync blocks the whole Electron main process —
        // UI, PTY output, IPC — for its entire duration. Yielding once per
        // file caps any single blocking stretch to roughly one file's worth of
        // synchronous work, regardless of which branch above ran.
        await new Promise<void>((resolve) => setImmediate(resolve));
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
