// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Pin, PinSubmissionRequest } from "@hapi/protocol";

/**
 * The operator's staged pin answers (#6450), per session, on this device.
 *
 * Choices, notes, questions and step ticks wait here until Submit, survive a
 * reload, and never cross sessions. The in-memory map is the truth and notifies
 * at once, so a pin answered in the chat shows answered on the Pins tab in the
 * same frame; storage is written behind it with one trailing debounce, flushed
 * when the page is hidden, because iOS kills a backgrounded PWA without unmounting.
 *
 * Zod-free and React-light on purpose: the chat's Submit strip imports it into
 * the main bundle, which sits close to the PWA precache limit (vite.config.ts).
 * Type imports are erased, so `Pin` costs nothing.
 */

export type StagedVia = "pins" | "chat";

export type StagedPin = {
  /**
   * The pin's revision at the last choice, tick or dismissal; a note or question
   * keeps it.
   */
  rev: number;
  kind: string;
  choice?: string;
  /** The option's label when chosen, for a later revision that dropped it. */
  label?: string;
  /** Where the choice was made, so Completed says "in the chat" truthfully. */
  via: StagedVia;
  note?: string;
  questions?: string[];
  /** Ticked step ids. Kept after a partial Submit, so the list still shows them. */
  ticks?: string[];
  /** How many ticks the last Submit sent; ticks equal to it have nothing new. */
  ticksSent?: number;
  /**
   * #6453: this device saved the pin's files, so its Submit is enabled. A hint
   * only: the server's own record of the unreported save decides what is sent.
   */
  saved?: true;
  /**
   * #6539: the operator chose to dismiss this pin. It stays open, marked Will
   * dismiss, until Submit closes it and tells the agent. A dismissal carries a
   * note and `saved` and nothing else: staging it drops a choice, questions and
   * ticks.
   */
  dismiss?: true;
  /**
   * #6539 (ruling Q4): the automatic pick's time (epoch ms) that staging the
   * dismissal turned off, so Undo can turn it back on. Only beside `dismiss`.
   */
  pickAt?: number;
  updatedAt: number;
};

export type StagedPins = Readonly<Record<string, Readonly<StagedPin>>>;

/** What staging needs of a pin; a cached `Pin` satisfies it. */
export type StagingPin = Pick<Pin, "key" | "revision" | "kind">;
/** What Use all recommendations needs of a pin. */
export type RecommendablePin = StagingPin &
  Pick<Pin, "status" | "recommended" | "options">;

export const STAGING_KEY_PREFIX = "hapi:pinsStaged:v1:";
export const PENDING_KEY_PREFIX = "hapi:pinsPending:v1:";
export const STAGED_QUESTIONS_MAX = 5;
/** `PIN_SUBMISSION_QUESTION_MAX_CHARS`, copied (Zod-free); staging.test.ts keeps them equal. */
export const STAGED_QUESTION_MAX_CHARS = 1000;
export const STAGED_NOTE_MAX_CHARS = 2048;
/** Kinds answered by a choice (KD12). */
export const ANSWERABLE_KINDS: ReadonlySet<string> = new Set([
  "decision",
  "variants",
]);
/**
 * `PIN_RESERVED_KEY_PREFIXES`, copied because shared/src/pins.ts loads Zod;
 * staging.test.ts keeps the two equal.
 */
export const RESERVED_KEY_PREFIXES = ["prompt:", "detected:"] as const;

const PERSIST_DELAY_MS = 300;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY: StagedPins = Object.freeze({});

export function isReservedKey(key: string): boolean {
  return RESERVED_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** True when a staged pin has something a Submit would send. */
export function hasUpdates(entry: StagedPin | undefined): boolean {
  if (!entry) return false;
  const ticks = entry.ticks?.length ?? 0;
  return (
    entry.choice !== undefined ||
    Boolean(entry.note?.trim()) ||
    (entry.questions?.length ?? 0) > 0 ||
    (ticks > 0 && ticks !== (entry.ticksSent ?? 0)) ||
    entry.saved === true ||
    entry.dismiss === true
  );
}

// ── State ────────────────────────────────────────────────────────────────────

const sessions = new Map<string, StagedPins>();
const sessionListeners = new Map<string, Set<() => void>>();
const keyListeners = new Map<string, Set<() => void>>();
const dirty = new Set<string>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleInstalled = false;
let pruned = false;
let failure: { failed: boolean; reported: boolean } = {
  failed: false,
  reported: false,
};
const failureListeners = new Set<() => void>();

const keyId = (sessionId: string, key: string) => `${sessionId}\u0000${key}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isStagedPin(value: unknown): value is StagedPin {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown) =>
    x === undefined ||
    (Array.isArray(x) && x.every(s => typeof s === "string"));
  return (
    typeof v.rev === "number" &&
    typeof v.kind === "string" &&
    (v.via === "pins" || v.via === "chat") &&
    typeof v.updatedAt === "number" &&
    (v.choice === undefined || typeof v.choice === "string") &&
    (v.label === undefined || typeof v.label === "string") &&
    (v.note === undefined || typeof v.note === "string") &&
    (v.ticksSent === undefined || typeof v.ticksSent === "number") &&
    (v.saved === undefined || v.saved === true) &&
    (v.dismiss === undefined || v.dismiss === true) &&
    (v.pickAt === undefined || typeof v.pickAt === "number") &&
    strings(v.questions) &&
    strings(v.ticks)
  );
}

/** A session's stored entries; anything unreadable reads as nothing staged. */
function readStored(sessionId: string): StagedPins {
  const raw = storage()?.getItem(STAGING_KEY_PREFIX + sessionId);
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as { pins?: unknown };
    if (!parsed.pins || typeof parsed.pins !== "object") return EMPTY;
    const out: Record<string, StagedPin> = {};
    for (const [key, entry] of Object.entries(parsed.pins)) {
      if (isStagedPin(entry)) out[key] = Object.freeze({ ...entry });
    }
    return Object.keys(out).length > 0 ? Object.freeze(out) : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Drop sessions untouched for 30 days, once per page load. */
function pruneStale(): void {
  if (pruned) return;
  pruned = true;
  const store = storage();
  if (!store) return;
  const cutoff = Date.now() - STALE_MS;
  try {
    for (const key of Object.keys(store)) {
      if (!key.startsWith(STAGING_KEY_PREFIX)) continue;
      try {
        const parsed = JSON.parse(store.getItem(key) ?? "") as {
          updatedAt?: unknown;
        };
        if (typeof parsed.updatedAt !== "number" || parsed.updatedAt < cutoff) {
          store.removeItem(key);
        }
      } catch {
        store.removeItem(key);
      }
    }
  } catch {
    // Storage disabled: nothing to prune.
  }
}

/**
 * The 30-day prune lists every localStorage key, so it runs once the page is
 * idle, never inside the render that first reads staging.
 */
function schedulePrune(): void {
  if (pruned) return;
  const idle = (
    globalThis as {
      requestIdleCallback?: (cb: () => void) => unknown;
    }
  ).requestIdleCallback;
  if (idle) idle(pruneStale);
  else setTimeout(pruneStale, 0);
}

function load(sessionId: string): StagedPins {
  let loaded = sessions.get(sessionId);
  if (loaded === undefined) {
    schedulePrune();
    installLifecycle();
    loaded = readStored(sessionId);
    sessions.set(sessionId, loaded);
  }
  return loaded;
}

function notify(sessionId: string, keys: Iterable<string>): void {
  for (const key of keys) {
    for (const listener of keyListeners.get(keyId(sessionId, key)) ?? []) {
      listener();
    }
  }
  for (const listener of sessionListeners.get(sessionId) ?? []) listener();
}

function setFailed(): void {
  if (failure.failed) return;
  failure = { failed: true, reported: false };
  for (const listener of failureListeners) listener();
}

/** Write every changed session now; called by the debounce and on page hide. */
export function flushStaging(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const store = storage();
  for (const sessionId of dirty) {
    const pins = sessions.get(sessionId) ?? EMPTY;
    try {
      if (!store) throw new Error("no storage");
      if (Object.keys(pins).length === 0) {
        store.removeItem(STAGING_KEY_PREFIX + sessionId);
      } else {
        store.setItem(
          STAGING_KEY_PREFIX + sessionId,
          JSON.stringify({ updatedAt: Date.now(), pins })
        );
      }
    } catch {
      // Full or disabled storage: staging keeps working in memory for this
      // page, and the bars say so once.
      setFailed();
    }
  }
  dirty.clear();
}

function schedulePersist(sessionId: string): void {
  dirty.add(sessionId);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushStaging, PERSIST_DELAY_MS);
}

function installLifecycle(): void {
  if (lifecycleInstalled || typeof window === "undefined") return;
  lifecycleInstalled = true;
  window.addEventListener("pagehide", flushStaging);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushStaging();
  });
  // Another tab staged or submitted: reload what it changed.
  window.addEventListener("storage", event => {
    if (event.key === null) {
      for (const sessionId of [...sessions.keys()]) reload(sessionId);
    } else if (event.key.startsWith(STAGING_KEY_PREFIX)) {
      const sessionId = event.key.slice(STAGING_KEY_PREFIX.length);
      if (sessions.has(sessionId)) reload(sessionId);
    }
  });
}

function reload(sessionId: string): void {
  if (dirty.has(sessionId)) return; // this tab's unsaved edits win
  const before = sessions.get(sessionId) ?? EMPTY;
  const after = readStored(sessionId);
  const changed = new Set([...Object.keys(before), ...Object.keys(after)]);
  sessions.set(sessionId, after);
  notify(sessionId, changed);
}

/**
 * Apply `update` to the given keys' entries. An entry that ends up with nothing
 * staged is removed; an unchanged one keeps its identity, so nothing re-renders.
 */
function mutate(
  sessionId: string,
  keys: readonly string[],
  update: (
    entry: Readonly<StagedPin> | undefined,
    key: string
  ) => StagedPin | undefined
): void {
  const current = load(sessionId);
  let next: Record<string, Readonly<StagedPin>> | null = null;
  const changed: string[] = [];
  for (const key of keys) {
    const before = current[key];
    // An updater returns the entry it was given to mean "no change".
    const updated = update(before, key);
    if (updated === before) continue;
    const kept = updated && isEmptyEntry(updated) ? undefined : updated;
    if (kept === undefined && before === undefined) continue;
    next ??= { ...current };
    if (kept === undefined) delete next[key];
    else next[key] = Object.freeze({ ...kept, updatedAt: Date.now() });
    changed.push(key);
  }
  if (!next) return;
  sessions.set(
    sessionId,
    Object.keys(next).length === 0 ? EMPTY : Object.freeze(next)
  );
  schedulePersist(sessionId);
  notify(sessionId, changed);
}

/**
 * `mutate` deletes an entry this calls empty. A dismissal is content on its own
 * (#6539), or one staged with no note would be deleted as it is written;
 * `pickAt` is not, because it only says what Undo restores.
 */
function isEmptyEntry(entry: StagedPin): boolean {
  return (
    entry.choice === undefined &&
    !entry.note &&
    !entry.questions?.length &&
    !entry.ticks?.length &&
    entry.saved !== true &&
    entry.dismiss !== true
  );
}

function base(
  entry: StagedPin | undefined,
  pin: StagingPin,
  via: StagedVia
): StagedPin {
  return entry ?? { rev: pin.revision, kind: pin.kind, via, updatedAt: 0 };
}

// ── Writers ──────────────────────────────────────────────────────────────────

/**
 * Choose an option; the revision and the label are taken as they are now. A
 * choice replaces a staged dismissal (#6539): the last act wins.
 */
export function stageChoice(
  sessionId: string,
  pin: StagingPin,
  option: { id: string; label: string },
  via: StagedVia
): void {
  mutate(sessionId, [pin.key], entry => ({
    ...withoutDismiss(base(entry, pin, via)),
    rev: pin.revision,
    kind: pin.kind,
    choice: option.id,
    label: option.label,
    via,
  }));
}

function withoutDismiss(entry: StagedPin): StagedPin {
  const { dismiss: _dismiss, pickAt: _pickAt, ...rest } = entry;
  return rest;
}

/**
 * #6539: stage a dismissal. The pin stays open, marked Will dismiss, until
 * Submit. It binds to the revision the operator confirmed (unlike a note, which
 * keeps an older entry's), keeps the note and a staged save, and drops what a
 * dismissal contradicts: a choice, questions and ticks. `pickAt` is the
 * automatic pick's time when confirming turned the pick off (ruling Q4).
 */
export function stageDismiss(
  sessionId: string,
  pin: StagingPin,
  via: StagedVia,
  pickAt?: number
): void {
  mutate(sessionId, [pin.key], entry => ({
    rev: pin.revision,
    kind: pin.kind,
    via,
    ...(entry?.note ? { note: entry.note } : {}),
    ...(entry?.saved === true ? { saved: true as const } : {}),
    dismiss: true,
    ...(pickAt !== undefined ? { pickAt } : {}),
    updatedAt: 0,
  }));
}

/** #6539: Undo. Removes the staged dismissal and its held pick time, nothing else. */
export function unstageDismiss(sessionId: string, key: string): void {
  mutate(sessionId, [key], entry => {
    if (!entry || (entry.dismiss !== true && entry.pickAt === undefined)) {
      return entry;
    }
    return withoutDismiss(entry);
  });
}

export function clearChoice(sessionId: string, key: string): void {
  mutate(sessionId, [key], entry => {
    if (!entry) return undefined;
    const { choice: _choice, label: _label, ...rest } = entry;
    return rest;
  });
}

/**
 * Tick or untick a step. It refreshes `rev`, like a choice: a revised steps pin
 * may reuse step ids, so a tick confirms the content the operator saw.
 */
export function toggleTick(
  sessionId: string,
  pin: StagingPin,
  stepId: string,
  via: StagedVia
): void {
  mutate(sessionId, [pin.key], entry => {
    // #6539: a dismissed pin's steps are read-only; a tick beside a dismissal
    // would contradict it, like a question.
    if (entry?.dismiss === true) return entry;
    const current = base(entry, pin, via);
    const ticks = new Set(current.ticks ?? []);
    if (ticks.has(stepId)) ticks.delete(stepId);
    else ticks.add(stepId);
    return {
      ...current,
      rev: pin.revision,
      kind: pin.kind,
      ticks: [...ticks],
      ...(entry?.choice === undefined ? { via } : {}),
    };
  });
}

/** Set the note; an existing entry keeps its revision (KD4). */
export function setNote(
  sessionId: string,
  pin: StagingPin,
  note: string,
  via: StagedVia
): void {
  const text = note.slice(0, STAGED_NOTE_MAX_CHARS);
  mutate(sessionId, [pin.key], entry => {
    const current = base(entry, pin, via);
    if ((current.note ?? "") === text) return entry;
    const { note: _old, ...rest } = current;
    return text.trim() ? { ...rest, note: text } : rest;
  });
}

/**
 * Add a question; false when it is empty, the pin already has five, or a
 * dismissal is staged (#6539): a question beside a dismissal would be dropped
 * unsent, so it is refused here, where the caller can say so.
 */
export function addQuestion(
  sessionId: string,
  pin: StagingPin,
  question: string,
  via: StagedVia
): boolean {
  const text = question.trim().slice(0, STAGED_QUESTION_MAX_CHARS);
  const staged = load(sessionId)[pin.key];
  const existing = staged?.questions?.length ?? 0;
  if (!text || existing >= STAGED_QUESTIONS_MAX || staged?.dismiss === true) {
    return false;
  }
  mutate(sessionId, [pin.key], entry => {
    const current = base(entry, pin, via);
    return { ...current, questions: [...(current.questions ?? []), text] };
  });
  return true;
}

export function removeQuestion(
  sessionId: string,
  key: string,
  index: number
): void {
  mutate(sessionId, [key], entry => {
    if (!entry?.questions) return entry;
    const questions = entry.questions.filter((_, i) => i !== index);
    const { questions: _old, ...rest } = entry;
    return questions.length > 0 ? { ...rest, questions } : rest;
  });
}

/**
 * #6453: the pin's files were saved here, so Submit tells the agent. An existing
 * entry keeps its revision, like a note: a save does not answer the content.
 */
export function stageSaved(
  sessionId: string,
  pin: StagingPin,
  via: StagedVia
): void {
  mutate(sessionId, [pin.key], entry =>
    entry?.saved ? entry : { ...base(entry, pin, via), saved: true }
  );
}

/** True when Use all recommendations would stage this pin's recommendation. */
export function canStageRecommendation(
  pin: RecommendablePin,
  entry: StagedPin | undefined
): boolean {
  return (
    pin.status === "open" &&
    ANSWERABLE_KINDS.has(pin.kind) &&
    !isReservedKey(pin.key) &&
    entry?.choice === undefined &&
    // #6539: a pin the operator chose to dismiss takes no recommendation.
    entry?.dismiss !== true &&
    pin.recommended !== undefined &&
    (pin.options ?? []).some(option => option.id === pin.recommended)
  );
}

/**
 * Use all recommendations (R5): stage the recommended option on every open
 * answerable pin that names a real one and has no staged choice. The count staged.
 */
export function stageRecommendations(
  sessionId: string,
  pins: readonly RecommendablePin[],
  via: StagedVia
): number {
  const current = load(sessionId);
  const eligible = pins.filter(pin =>
    canStageRecommendation(pin, current[pin.key])
  );
  const byKey = new Map(eligible.map(pin => [pin.key, pin]));
  mutate(
    sessionId,
    eligible.map(pin => pin.key),
    (entry, key) => {
      const pin = byKey.get(key) as RecommendablePin;
      const option = (pin.options ?? []).find(o => o.id === pin.recommended);
      if (!option) return entry;
      return {
        ...base(entry, pin, via),
        rev: pin.revision,
        kind: pin.kind,
        choice: option.id,
        label: option.label,
        via,
      };
    }
  );
  return eligible.length;
}

/**
 * Clear what a Submit sent. An entry changed since the dialog read it (another
 * tab, or a tick after opening) keeps its newer edit. Partial step ticks stay,
 * marked sent, so the list still shows them; all ticked resolves the pin.
 */
export function clearSubmitted(
  sessionId: string,
  submitted: Readonly<Record<string, Readonly<StagedPin>>>
): void {
  mutate(sessionId, Object.keys(submitted), (entry, key) => {
    const sent = submitted[key];
    if (!entry || !sent || entry.updatedAt !== sent.updatedAt) return entry;
    const ticks = entry.ticks ?? [];
    return ticks.length > 0
      ? {
          rev: entry.rev,
          kind: entry.kind,
          via: entry.via,
          ticks,
          ticksSent: ticks.length,
          updatedAt: entry.updatedAt,
        }
      : undefined;
  });
}

/** Forget pins entirely: dropped by a Submit, or gone from the session. */
export function dropPins(sessionId: string, keys: readonly string[]): void {
  mutate(sessionId, keys, () => undefined);
}

/** Forget every session not in `validIds` (wired into `pruneOrphanedSessions`). */
export function pruneStaging(validIds: ReadonlySet<string>): void {
  const store = storage();
  try {
    for (const key of Object.keys(store ?? {})) {
      const prefix = key.startsWith(STAGING_KEY_PREFIX)
        ? STAGING_KEY_PREFIX
        : key.startsWith(PENDING_KEY_PREFIX)
          ? PENDING_KEY_PREFIX
          : null;
      if (!prefix) continue;
      const sessionId = key.slice(prefix.length);
      if (!validIds.has(sessionId)) store?.removeItem(key);
    }
  } catch {
    // Storage disabled: nothing stored.
  }
  for (const sessionId of [...sessions.keys()]) {
    if (validIds.has(sessionId)) continue;
    const keys = Object.keys(sessions.get(sessionId) ?? EMPTY);
    sessions.delete(sessionId);
    dirty.delete(sessionId);
    notify(sessionId, keys);
  }
}

/** Forget one removed session's staging, memory and storage. */
export function removeSessionStaging(sessionId: string): void {
  const keys = Object.keys(sessions.get(sessionId) ?? EMPTY);
  sessions.delete(sessionId);
  dirty.delete(sessionId);
  try {
    storage()?.removeItem(STAGING_KEY_PREFIX + sessionId);
    storage()?.removeItem(PENDING_KEY_PREFIX + sessionId);
  } catch {
    // Storage disabled: nothing stored.
  }
  notify(sessionId, keys);
}

// ── A Submit in flight ──────────────────────────────────────────────────────

/**
 * A Submit sent without a definitive answer yet (a lost response, a closed app).
 * Kept in storage so the next opening reuses its `submissionId` while the staged
 * entries it was built from are unchanged: the server then replays instead of
 * delivering a second message. `stamps` is each entry's `updatedAt` when sent.
 */
export type PendingSubmission = {
  submissionId: string;
  request: PinSubmissionRequest;
  stamps: Record<string, number>;
  at: number;
};

export function savePendingSubmission(
  sessionId: string,
  pending: PendingSubmission
): void {
  try {
    storage()?.setItem(PENDING_KEY_PREFIX + sessionId, JSON.stringify(pending));
  } catch {
    setFailed();
  }
}

export function loadPendingSubmission(
  sessionId: string
): PendingSubmission | null {
  try {
    const raw = storage()?.getItem(PENDING_KEY_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingSubmission>;
    if (
      typeof parsed.submissionId !== "string" ||
      !parsed.request ||
      !Array.isArray(parsed.request.entries) ||
      !parsed.stamps ||
      typeof parsed.stamps !== "object"
    ) {
      return null;
    }
    return parsed as PendingSubmission;
  } catch {
    return null;
  }
}

export function clearPendingSubmission(sessionId: string): void {
  try {
    storage()?.removeItem(PENDING_KEY_PREFIX + sessionId);
  } catch {
    // Storage disabled: nothing stored.
  }
}

/** True while every entry a pending Submit was built from is staged unchanged. */
export function pendingStillStaged(
  pending: PendingSubmission,
  staged: StagedPins
): boolean {
  return Object.entries(pending.stamps).every(
    ([key, at]) => staged[key]?.updatedAt === at
  );
}

// ── Readers ──────────────────────────────────────────────────────────────────

export function getStagedPins(sessionId: string): StagedPins {
  return load(sessionId);
}

const sessionSubscribers = new Map<string, (l: () => void) => () => void>();
const keySubscribers = new Map<string, (l: () => void) => () => void>();

function subscriber(
  registry: Map<string, Set<() => void>>,
  cache: Map<string, (l: () => void) => () => void>,
  id: string
): (listener: () => void) => () => void {
  let subscribe = cache.get(id);
  if (!subscribe) {
    subscribe = listener => {
      let set = registry.get(id);
      if (!set) registry.set(id, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) {
          registry.delete(id);
          // A key nobody watches keeps no closure; the next reader makes one.
          cache.delete(id);
        }
      };
    };
    cache.set(id, subscribe);
  }
  return subscribe;
}

/** Every staged pin of a session; one stable object until something changes. */
export function useStagedPins(sessionId: string): StagedPins {
  const subscribe = subscriber(sessionListeners, sessionSubscribers, sessionId);
  const read = () => load(sessionId);
  return useSyncExternalStore(subscribe, read, read);
}

/** One pin's staged entry; re-renders only when that pin changes. */
export function useStagedPin(
  sessionId: string,
  key: string
): Readonly<StagedPin> | undefined {
  const id = keyId(sessionId, key);
  const subscribe = subscriber(keyListeners, keySubscribers, id);
  const read = () => load(sessionId)[key];
  return useSyncExternalStore(subscribe, read, read);
}

/** How many pins have something a Submit would send. */
export function countUpdates(pins: StagedPins): number {
  let count = 0;
  for (const entry of Object.values(pins)) if (hasUpdates(entry)) count++;
  return count;
}

export function useStagedCount(sessionId: string): number {
  const subscribe = subscriber(sessionListeners, sessionSubscribers, sessionId);
  const read = () => countUpdates(load(sessionId));
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * A steps pin's ticks, as C's local hook gave them (#6449): ids no longer among
 * the pin's steps are dropped when read, so a revised pin never counts a removed
 * step.
 */
export function useStepTicks(
  sessionId: string,
  pin: StagingPin,
  stepIds: readonly string[],
  via: StagedVia
): { checked: ReadonlySet<string>; toggle: (stepId: string) => void } {
  const entry = useStagedPin(sessionId, pin.key);
  const stored = entry?.ticks;
  const idsKey = stepIds.join("\u0000");
  const checked = useMemo(() => {
    const present = new Set(idsKey ? idsKey.split("\u0000") : []);
    return new Set((stored ?? []).filter(stepId => present.has(stepId)));
  }, [stored, idsKey]);
  const { key, revision, kind } = pin;
  const toggle = useCallback(
    (stepId: string) =>
      toggleTick(sessionId, { key, revision, kind }, stepId, via),
    [sessionId, key, revision, kind, via]
  );
  return { checked, toggle };
}

// ── Storage failure ──────────────────────────────────────────────────────────

function subscribeFailure(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/**
 * True once, after storage refused a write and before anyone said so. The
 * caller shows its toast and calls `markStagingFailureReported`.
 */
export function useStagingFailure(): boolean {
  const read = () => failure.failed && !failure.reported;
  return useSyncExternalStore(subscribeFailure, read, read);
}

export function markStagingFailureReported(): void {
  if (!failure.failed || failure.reported) return;
  failure = { failed: true, reported: true };
  for (const listener of failureListeners) listener();
}

/** Test-only: forget everything in memory, without touching storage. */
export function __resetStaging(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  dirty.clear();
  const loaded = [...sessions.entries()];
  sessions.clear();
  pruned = false;
  failure = { failed: false, reported: false };
  for (const [sessionId, pins] of loaded) notify(sessionId, Object.keys(pins));
}
