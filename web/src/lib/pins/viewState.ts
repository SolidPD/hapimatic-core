// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useSyncExternalStore } from "react";
import {
  PINS_VIEW_BUILTIN,
  PINS_VIEW_FACETS,
  PinsViewPreferenceSchema,
  type PinsViewDirection,
  type PinsViewFacet,
  type PinsViewFilters,
  type PinsViewGroup,
  type PinsViewPreference,
  type PinsViewSort,
} from "@hapi/protocol/schemas";
import type { PinsViewState } from "./view";

/**
 * #6451 (R5, R6): a session's Pins view, saved on this device field by field.
 * The architecture of D's staging store (`staging.ts`): one in-memory map is
 * the source of truth, components read it through `useSyncExternalStore`, a
 * `storage` event reloads what another tab changed, and every storage access
 * is guarded so a full or disabled store never throws into render.
 *
 * A record is SPARSE: a field is present only once the operator set it in that
 * session, so every other field keeps following the Preferences default. Each
 * setter re-reads the stored record and changes only its own field, so two
 * tabs never overwrite each other's other fields; while a session's saves are
 * failing it builds on this page's copy instead. Search is never saved.
 */

export const PINS_VIEW_KEY_PREFIX = "hapi:pinsView:v1:";

/** What a session has saved: Preferences' fields plus the timeline toggle. */
export type SavedPinsView = PinsViewPreference & { timeline?: boolean };

const EMPTY: SavedPinsView = Object.freeze({});
const views = new Map<string, SavedPinsView>();
const listeners = new Map<string, Set<() => void>>();
const subscribers = new Map<string, (listener: () => void) => () => void>();
/** Sessions whose last save failed: this page's copy is newer than storage. */
const unsaved = new Set<string>();
let storageListenerInstalled = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The fields of a stored or synced value this build can read, with nothing
 * else: an unknown facet value, sort or grouping drops alone (the loose shared
 * schema), and a field that is absent stays absent.
 */
export function sparsePinsView(value: unknown): SavedPinsView {
  const parsed = PinsViewPreferenceSchema.safeParse(value);
  if (!parsed.success) return EMPTY;
  const out: SavedPinsView = {};
  const filters = Object.fromEntries(
    Object.entries(parsed.data.filters ?? {}).filter(([, v]) => v !== undefined)
  ) as Partial<PinsViewFilters>;
  if (Object.keys(filters).length > 0) out.filters = filters;
  if (parsed.data.sort !== undefined) out.sort = parsed.data.sort;
  if (parsed.data.dir !== undefined) out.dir = parsed.data.dir;
  if (parsed.data.group !== undefined) out.group = parsed.data.group;
  const timeline = (value as { timeline?: unknown }).timeline;
  if (typeof timeline === "boolean") out.timeline = timeline;
  return Object.keys(out).length > 0 ? Object.freeze(out) : EMPTY;
}

/**
 * A session's saved view as stored now, or null when storage cannot be read.
 * Unreadable JSON reads as nothing saved.
 */
function readStored(sessionId: string): SavedPinsView | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(PINS_VIEW_KEY_PREFIX + sessionId);
  } catch {
    return null;
  }
  if (!raw) return EMPTY;
  try {
    return sparsePinsView(JSON.parse(raw));
  } catch {
    return EMPTY;
  }
}

/** A session's saved view, validated field by field (R5). */
export function readSavedView(sessionId: string): SavedPinsView {
  return readStored(sessionId) ?? EMPTY;
}

function notify(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  // Another tab saved a choice: reload what it changed.
  window.addEventListener("storage", event => {
    if (event.key === null) {
      for (const sessionId of [...views.keys()]) reload(sessionId);
    } else if (event.key.startsWith(PINS_VIEW_KEY_PREFIX)) {
      const sessionId = event.key.slice(PINS_VIEW_KEY_PREFIX.length);
      if (views.has(sessionId)) reload(sessionId);
    }
  });
}

function reload(sessionId: string): void {
  const next = readSavedView(sessionId);
  // Another tab's save is now what storage holds; build on it from here.
  unsaved.delete(sessionId);
  if (sameView(views.get(sessionId) ?? EMPTY, next)) return;
  views.set(sessionId, next);
  notify(sessionId);
}

function sameView(a: SavedPinsView, b: SavedPinsView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function load(sessionId: string): SavedPinsView {
  let loaded = views.get(sessionId);
  if (loaded === undefined) {
    installStorageListener();
    loaded = readSavedView(sessionId);
    views.set(sessionId, loaded);
  }
  return loaded;
}

/**
 * Change one session's saved view. The base is the record as stored now (so
 * another tab's fields survive), or this page's copy when storage cannot be
 * read or the last save failed. A full or disabled store keeps every choice
 * made on this page in memory, not only the latest, until a save succeeds or
 * another tab's save arrives (its `storage` event replaces this page's copy).
 */
function update(
  sessionId: string,
  change: (base: SavedPinsView) => SavedPinsView
): void {
  const base = unsaved.has(sessionId)
    ? (views.get(sessionId) ?? EMPTY)
    : (readStored(sessionId) ?? views.get(sessionId) ?? EMPTY);
  const next = sparsePinsView(change(base));
  try {
    const store = storage();
    if (!store) throw new Error("storage unavailable");
    store.setItem(
      PINS_VIEW_KEY_PREFIX + sessionId,
      JSON.stringify({ v: 1, ...next, at: Date.now() })
    );
    unsaved.delete(sessionId);
  } catch {
    // Full or disabled storage: the choice lasts for this page only.
    unsaved.add(sessionId);
  }
  if (sameView(views.get(sessionId) ?? EMPTY, next)) return;
  views.set(sessionId, next);
  notify(sessionId);
}

function isFacetValue(facet: PinsViewFacet, value: string): boolean {
  return (PINS_VIEW_FACETS[facet] as readonly string[]).includes(value);
}

export function setPinsFacet(
  sessionId: string,
  facet: PinsViewFacet,
  value: string
): void {
  if (!isFacetValue(facet, value)) return;
  update(sessionId, base => ({
    ...base,
    filters: { ...base.filters, [facet]: value },
  }));
}

/** "Clear filters": every facet saved as All for this session (KD6). */
export function clearPinsFilters(sessionId: string): void {
  update(sessionId, base => ({
    ...base,
    filters: { ...PINS_VIEW_BUILTIN.filters },
  }));
}

export function setPinsSort(sessionId: string, sort: PinsViewSort): void {
  update(sessionId, base => ({ ...base, sort }));
}

export function setPinsDir(sessionId: string, dir: PinsViewDirection): void {
  update(sessionId, base => ({ ...base, dir }));
}

export function setPinsGroup(sessionId: string, group: PinsViewGroup): void {
  update(sessionId, base => ({ ...base, group }));
}

/** "Clear sort": Priority, Descending, by Status, saved for this session (KD6). */
export function clearPinsSort(sessionId: string): void {
  update(sessionId, base => ({
    ...base,
    sort: PINS_VIEW_BUILTIN.sort,
    dir: PINS_VIEW_BUILTIN.dir,
    group: PINS_VIEW_BUILTIN.group,
  }));
}

export function setPinsTimeline(sessionId: string, timeline: boolean): void {
  update(sessionId, base => ({ ...base, timeline }));
}

/**
 * Each field as `saved in this session ?? Preferences default ?? built-in`
 * (R6); the timeline is off unless this session turned it on.
 */
export function resolvePinsView(
  saved: SavedPinsView,
  defaults: PinsViewPreference
): PinsViewState {
  const filters = { ...PINS_VIEW_BUILTIN.filters } as Record<
    PinsViewFacet,
    string
  >;
  for (const facet of Object.keys(filters) as PinsViewFacet[]) {
    filters[facet] =
      saved.filters?.[facet] ??
      defaults.filters?.[facet] ??
      PINS_VIEW_BUILTIN.filters[facet];
  }
  return {
    filters: filters as PinsViewFilters,
    sort: saved.sort ?? defaults.sort ?? PINS_VIEW_BUILTIN.sort,
    dir: saved.dir ?? defaults.dir ?? PINS_VIEW_BUILTIN.dir,
    group: saved.group ?? defaults.group ?? PINS_VIEW_BUILTIN.group,
    timeline: saved.timeline ?? false,
  };
}

function subscriber(sessionId: string): (listener: () => void) => () => void {
  let subscribe = subscribers.get(sessionId);
  if (!subscribe) {
    subscribe = listener => {
      let set = listeners.get(sessionId);
      if (!set) listeners.set(sessionId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) {
          listeners.delete(sessionId);
          subscribers.delete(sessionId);
        }
      };
    };
    subscribers.set(sessionId, subscribe);
  }
  return subscribe;
}

export type PinsViewActions = {
  setFacet: (facet: PinsViewFacet, value: string) => void;
  clearFilters: () => void;
  setSort: (sort: PinsViewSort) => void;
  setDir: (dir: PinsViewDirection) => void;
  setGroup: (group: PinsViewGroup) => void;
  clearSort: () => void;
  setTimeline: (on: boolean) => void;
};

/**
 * A session's resolved view and its setters. The setters, and `actions`
 * holding them all, are stable per session.
 */
export function usePinsViewState(
  sessionId: string,
  defaults: PinsViewPreference
): PinsViewActions & { view: PinsViewState; actions: PinsViewActions } {
  const read = () => load(sessionId);
  const saved = useSyncExternalStore(subscriber(sessionId), read, read);
  const view = useMemo(
    () => resolvePinsView(saved, defaults),
    [saved, defaults]
  );
  const actions = useMemo<PinsViewActions>(
    () => ({
      setFacet: (facet, value) => setPinsFacet(sessionId, facet, value),
      clearFilters: () => clearPinsFilters(sessionId),
      setSort: sort => setPinsSort(sessionId, sort),
      setDir: dir => setPinsDir(sessionId, dir),
      setGroup: group => setPinsGroup(sessionId, group),
      clearSort: () => clearPinsSort(sessionId),
      setTimeline: on => setPinsTimeline(sessionId, on),
    }),
    [sessionId]
  );
  return { view, actions, ...actions };
}

/** Forget every session not in `validIds` (wired into `pruneOrphanedSessions`). */
export function prunePinsView(validIds: ReadonlySet<string>): void {
  const store = storage();
  try {
    for (const key of Object.keys(store ?? {})) {
      if (!key.startsWith(PINS_VIEW_KEY_PREFIX)) continue;
      if (!validIds.has(key.slice(PINS_VIEW_KEY_PREFIX.length))) {
        store?.removeItem(key);
      }
    }
  } catch {
    // Storage disabled: nothing stored.
  }
  for (const sessionId of [...views.keys()]) {
    if (validIds.has(sessionId)) continue;
    views.delete(sessionId);
    unsaved.delete(sessionId);
    notify(sessionId);
  }
}

/** Tests only: forget every loaded session. */
export function __resetPinsView(): void {
  const loaded = [...views.keys()];
  views.clear();
  unsaved.clear();
  for (const sessionId of loaded) notify(sessionId);
}
