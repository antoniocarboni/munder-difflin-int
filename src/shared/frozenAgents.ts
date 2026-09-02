/**
 * "Frozen" reuses the persisted `autoDeliveryPausedAgents` list
 * (src/main/config.ts) rather than a parallel flag: an id on that list is
 * already excluded from auto inbox/queue delivery, and restore treats it the
 * same way — stay stopped until called back explicitly.
 */
export function partitionFrozenAgents<T extends { id: string }>(
  agents: readonly T[],
  frozenIds: readonly string[] | undefined | null
): { toRestore: T[]; frozen: T[] } {
  const frozenSet = new Set(frozenIds ?? []);
  const toRestore: T[] = [];
  const frozen: T[] = [];
  for (const a of agents) {
    (frozenSet.has(a.id) ? frozen : toRestore).push(a);
  }
  return { toRestore, frozen };
}
