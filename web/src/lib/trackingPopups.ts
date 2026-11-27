// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One tracking pop-up per start in this tab (#6780, B14; the note of
 * 2026-11-25, CR-C6 and S12 of #6778).
 *
 * Three sources can tell a person that a new session's tracking is not what
 * the form showed: the inbox notice of kind `tracking-not-applied`
 * (`NotificationListener`, through the toast gate), the spawn hook's warning
 * (`useSpawnSession`) and the read-back after Create (`TrackedStartListener`).
 * Each names the start by the keys it knows. The first source to claim any of
 * a start's keys shows its pop-up; every later source that shares a key stays
 * silent, and its own keys join the start's, so a third source that knows only
 * one of them is paired too.
 *
 * Keys: `corr:<spawnCorrelationId>`, `tag:<tag>`, `session:<id>`. A source
 * that knows none claims nothing and shows, as before this module. A source
 * claims only when it is about to show, so a source that stays quiet (a
 * read-back that found the record equal, a notice the person's pop-up setting
 * hides) never silences the next one.
 *
 * Tab memory only, bounded at {@link TRACKING_POPUP_STARTS_MAX} starts: the
 * oldest start's keys are dropped together. No rate, note or category is ever a
 * key (C7).
 */

/** How many starts this tab remembers. */
export const TRACKING_POPUP_STARTS_MAX = 200;

/** The keys of one start, in the order the starts were first claimed. */
const starts: Array<Set<string>> = [];
/** Every remembered key and the start it belongs to. */
const owner = new Map<string, Set<string>>();

/** The keys a source knows, from the ids it holds (an absent id adds none). */
export function trackingPopupKeys(ids: {
  spawnCorrelationId?: string | null;
  tag?: string | null;
  sessionId?: string | null;
}): string[] {
  const keys: string[] = [];
  if (ids.spawnCorrelationId) keys.push(`corr:${ids.spawnCorrelationId}`);
  if (ids.tag) keys.push(`tag:${ids.tag}`);
  if (ids.sessionId) keys.push(`session:${ids.sessionId}`);
  return keys;
}

/** True when a source already showed the pop-up of a start that has any of these keys. */
export function isTrackingPopupClaimed(keys: readonly string[]): boolean {
  return keys.some(key => owner.has(key));
}

/**
 * Claim the pop-up of a start: true for the first caller of any of the keys
 * (it shows), false for every later one (it stays silent). Either way the keys
 * are recorded with the start. No keys: true, and nothing is recorded.
 */
export function claimTrackingPopup(keys: readonly string[]): boolean {
  if (keys.length === 0) return true;
  const found = keys.map(key => owner.get(key)).find(s => s !== undefined);
  if (found) {
    for (const key of keys) {
      if (!owner.has(key)) {
        found.add(key);
        owner.set(key, found);
      }
    }
    return false;
  }
  const start = new Set(keys);
  starts.push(start);
  for (const key of start) owner.set(key, start);
  while (starts.length > TRACKING_POPUP_STARTS_MAX) {
    const oldest = starts.shift();
    if (!oldest) break;
    for (const key of oldest) {
      if (owner.get(key) === oldest) owner.delete(key);
    }
  }
  return true;
}

/** Test-only: forget every start. */
export function __resetTrackingPopupsForTests(): void {
  starts.length = 0;
  owner.clear();
}
