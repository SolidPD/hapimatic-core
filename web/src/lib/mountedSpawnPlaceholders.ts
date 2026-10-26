// SPDX-License-Identifier: AGPL-3.0-only
// Which optimistic-create placeholders are on screen right now (issue #4915).
//
// While `SpawningSessionView` is mounted for a placeholder it shows that spawn's
// failure itself (the in-view return-to-Create), so the `spawn-failed`
// notification pop-up for the same placeholder would only repeat it.
// `NotificationListener` checks this set (keyed by the row's
// `context.placeholderId`, the Sub B contract) and suppresses that one pop-up;
// the inbox row is kept.
const mounted = new Map<string, number>();

/** Registers a mounted placeholder; returns the unregister function. */
export function registerMountedSpawnPlaceholder(id: string): () => void {
  mounted.set(id, (mounted.get(id) ?? 0) + 1);
  return () => {
    const n = (mounted.get(id) ?? 0) - 1;
    if (n > 0) mounted.set(id, n);
    else mounted.delete(id);
  };
}

export function isSpawnPlaceholderMounted(id: string): boolean {
  return mounted.has(id);
}
