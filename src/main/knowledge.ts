/**
 * KnowledgeManager — the Electron-main façade over the file-backed enterprise
 * Knowledge Graph store. Owns ingestion (in-app, over IPC) and exposes the same
 * keyword search the agent CLI uses; agents themselves query out-of-process via
 * `resources/kg.cjs` (see docs/design/knowledge-graph.md).
 *
 * All heavy lifting lives in the pure-JS `kg-core.cjs` sidecar (no native deps),
 * required the same way `slack.ts` requires `slack-trigger.cjs`. Mirrors the
 * MemoryManager surface (`active()` / `env()` / `status()`) so it slots into the
 * existing spawn-injection flow.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './config';

// Pure-JS core, copied to out/main at build (like slack-trigger.cjs) and shipped
// to process.resourcesPath for the agent CLI (electron-builder extraResources).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./kg-core.cjs') as KgCore;

interface KgMeta {
  id: string; title: string; source: string; modality: string; mime: string | null;
  origExt: string; bytes: number; tags: string[]; caption: string | null;
  chunkCount: number; addedAt: string; extractor: string; truncated: boolean;
}
interface KgHit {
  docId: string; title: string; source: string; modality: string;
  chunkIdx: number; score: number; snippet: string;
}
interface KgIngestInput {
  srcPath?: string; text?: string; title?: string; tags?: string[];
  caption?: string; modality?: string; source?: string;
}
interface KgCore {
  ingest(root: string, input: KgIngestInput): { docId: string; chunkCount: number; meta: KgMeta };
  search(root: string, query: string, opts?: { limit?: number }): KgHit[];
  list(root: string): KgMeta[];
  getDoc(root: string, docId: string): { meta: KgMeta; text: string } | null;
  removeDoc(root: string, docId: string): boolean;
  stats(root: string): { docCount: number; chunkCount: number; byModality: Record<string, number> };
}

export interface KnowledgeStatus {
  enabled: boolean;
  root: string;
  docCount: number;
  chunkCount: number;
  byModality: Record<string, number>;
}

export class KnowledgeManager {
  /** Whether the feature flag is on. */
  active(): boolean {
    return readConfig().knowledgeGraph?.enabled === true;
  }

  /** The store directory (config override or <userData>/knowledge). */
  root(): string {
    const override = readConfig().knowledgeGraph?.rootPath;
    if (override && override.trim()) return override;
    return join(app.getPath('userData'), 'knowledge');
  }

  /** The store directory for one project's isolated vault-sync store — always
   *  `<userData>/knowledge/projects/<slug>/`, regardless of any `rootPath`
   *  override (that override only ever applies to the global manual store).
   *  Purely additive: the global store this method sits next to is untouched. */
  projectRoot(slug: string): string {
    return join(app.getPath('userData'), 'knowledge', 'projects', slug);
  }

  /** Absolute path to the agent CLI (dev: repo resources/; packaged: resourcesPath). */
  private cliPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'kg.cjs')
      : join(app.getAppPath(), 'resources', 'kg.cjs');
  }

  /** Absolute path to the pure-JS core for the out-of-process CLI to require. */
  private corePath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'kg-core.cjs')
      : join(app.getAppPath(), 'src', 'main', 'kg-core.cjs');
  }

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

  status(): KnowledgeStatus {
    const enabled = this.active();
    const root = this.root();
    const s = enabled && existsSync(root)
      ? core.stats(root)
      : { docCount: 0, chunkCount: 0, byModality: {} };
    return { enabled, root, docCount: s.docCount, chunkCount: s.chunkCount, byModality: s.byModality };
  }

  /** Ingest a file from disk. No-op-safe when off (callers gate on status). */
  ingestFile(srcPath: string, opts: { title?: string; tags?: string[]; caption?: string } = {}) {
    return core.ingest(this.root(), { srcPath, ...opts });
  }

  /** Ingest inline text (e.g. pasted content). */
  ingestText(text: string, opts: { title?: string; tags?: string[] } = {}) {
    return core.ingest(this.root(), { text, ...opts });
  }

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

  search(query: string, limit?: number): KgHit[] {
    if (!existsSync(this.root())) return [];
    return core.search(this.root(), query, { limit });
  }

  list(): KgMeta[] {
    if (!existsSync(this.root())) return [];
    return core.list(this.root());
  }

  get(docId: string): { meta: KgMeta; text: string } | null {
    return core.getDoc(this.root(), docId);
  }

  remove(docId: string): boolean {
    return core.removeDoc(this.root(), docId);
  }

  /** Project-scoped mirrors of status/list/get, for the Settings → Vault Sync
   *  panel's "N documents indexed" + preview — reads a mapped project's
   *  ISOLATED store instead of the global one. Same existsSync guard as their
   *  global counterparts: a project that has never synced (no store on disk
   *  yet) reads as empty, not an error. */
  statusFor(slug: string): KnowledgeStatus {
    const enabled = this.active();
    const root = this.projectRoot(slug);
    const s = enabled && existsSync(root)
      ? core.stats(root)
      : { docCount: 0, chunkCount: 0, byModality: {} };
    return { enabled, root, docCount: s.docCount, chunkCount: s.chunkCount, byModality: s.byModality };
  }

  listFor(slug: string): KgMeta[] {
    const root = this.projectRoot(slug);
    if (!existsSync(root)) return [];
    return core.list(root);
  }

  getFrom(slug: string, docId: string): { meta: KgMeta; text: string } | null {
    return core.getDoc(this.projectRoot(slug), docId);
  }
}
