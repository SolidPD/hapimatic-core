// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779 (plan section 6, review W6): the one order function for a drag
 * and for Move up / Move down. Returns the ids with `id` moved to `toIndex`
 * (clamped to the list), or the same ids when `id` is absent.
 */
export function moveCategory(
  ids: readonly string[],
  id: string,
  toIndex: number
): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  const next = ids.filter(other => other !== id);
  const to = Math.max(0, Math.min(Math.trunc(toIndex), next.length));
  next.splice(to, 0, id);
  return next;
}
