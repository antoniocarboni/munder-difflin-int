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
