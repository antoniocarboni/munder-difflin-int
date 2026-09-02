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

/**
 * Should a queued message THAW its frozen target instead of being held back?
 *
 * Only a deliberate dispatch does. `manual` is set solely by the store's
 * `releaseQueuedMessage()` ("Send now"), which is already the app's existing
 * definition of "the user meant this one, now" — see the pause gate in
 * useHive.ts. Ordinary automatic delivery must never wake a frozen agent, or
 * freezing would buy nothing.
 */
export function shouldThawForDispatch(
  msg: { manual?: boolean; isFrozen?: boolean }
): boolean {
  return msg.manual === true && msg.isFrozen === true;
}
