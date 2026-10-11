// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useSyncExternalStore } from "react";
import { getStorageKey } from "@/lib/storage-keys";
import {
  DEFAULT_COMPOSER_SUBMIT_BEHAVIOR,
  type ComposerSubmitBehavior,
} from "@/lib/composerSubmitBehavior";
import type { PermissionMode } from "@hapi/protocol/modes";
import {
  AUTO_RECOVER_DEFAULT_ENABLED,
  AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED,
  AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED,
  CHAT_SECTIONS_DEFAULT,
  ChatSectionsPreferenceSchema,
  DEFAULT_OUTPUT_STYLE_DEFAULT,
  type ChatSectionsPreference,
} from "@hapi/protocol/schemas";

const STORAGE_KEY = getStorageKey("hapi:adminPreferences:v1");

export type DensityMode = "normal" | "compact" | "ultra";

// #3276: which end of the session list the control bar renders at. Default "top".
export type ControlBarPosition = "top" | "bottom";

export type AdminPreferences = {
  version: 1;
  density: DensityMode;
  autoExpandRepoGroups: boolean;
  // #3276: position of the session-list control bar ("top" default / "bottom").
  // A per-device layout-chrome preference (localStorage, no server sync) — a new
  // v1 field that back-fills onto pre-existing cached blobs via the readStored
  // `{ ...DEFAULT, ...parsed }` merge (no migration needed).
  sessionListControlBarPosition: ControlBarPosition;
  autoRecoverFromApiErrors: boolean;
  // #3618: server-mirrored no-flash cache for the "Auto-switch account on rate
  // limit" toggle (the displayed truth is the server value via
  // useAutoSwitchOnRateLimitPreference; this is only the no-flash first-paint
  // cache). Default from the shared AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED
  // (OFF) so web + server defaults can never diverge (#2486 discipline).
  autoSwitchOnRateLimit: boolean;
  // The literal "FED" (federation worst-case) or a federation nodeId. Kept as a
  // string (not a union) because node IDs are open-ended; "FED" is the sentinel.
  systemHealthDisplayTarget: string;
  // Which keystroke sends a composer message (#1525). Defaults to the #1524
  // shipped default `shift-to-send` (a bare Enter inserts a newline).
  composerSubmitBehavior: ComposerSubmitBehavior;
  // Default spawn permission mode (#1951 A4) — pre-selected on the Create-Session
  // form. Defaults to "bypassPermissions" (YOLO) to preserve the prior YOLO-on
  // default (the form's `yoloMode` previously defaulted to true).
  defaultSpawnPermissionMode: PermissionMode;
  // #2042 (A4): when creating a session, pre-select the most-underutilized
  // healthy account (lowest utilization `score`). Default false (OFF) — a true
  // no-op: with it off, no usage fetch occurs and default selection is unchanged.
  autoSelectOptimalAccount: boolean;
  // #2988 (epic #2987 S1): per-category chat-sections matrix (successor to the
  // retired chat-verbosity enum) alongside default output style. Server-mirrored
  // (localStorage is only the no-flash cache; the server is the displayed truth
  // via useChatSectionPrefs / useDefaultOutputStyle). Default from the shared
  // CHAT_SECTIONS_DEFAULT so web + server can never diverge; an older cached blob
  // without `chatSections` back-fills the default via the { ...DEFAULT, ...parsed }
  // merge in readStored (no cache migration needed).
  chatSections: ChatSectionsPreference;
  defaultOutputStyle: string;
  // #4550 (operator ruling R2-2, #4516): when ON, the Terminal tab's compose-line
  // Send delivers the text and then a CR so the command runs; when OFF (the
  // default), Send leaves the text at the prompt to be edited and run manually.
  // Per-device (localStorage, no server reader — the CR is written by the browser
  // over the terminal socket), so no shared default / server-sync is needed. A new
  // v1 field that back-fills onto existing cached blobs via the readStored
  // `{ ...DEFAULT, ...parsed }` merge (no migration). The round-1 flat key
  // `hapi.terminal.composeEnterAfterSend` (default ON) is deliberately NOT read.
  terminalComposeEnterAfterSend: boolean;
};

export const DEFAULT_ADMIN_PREFERENCES: AdminPreferences = {
  version: 1,
  density: "normal",
  autoExpandRepoGroups: false,
  // #3276: default the control bar to the top (R4).
  sessionListControlBarPosition: "top",
  // Auto-recover is opt-out: on by default. The default lives ONCE in the shared
  // `AUTO_RECOVER_DEFAULT_ENABLED` constant (also consumed by the server schema),
  // so the web and server defaults can never diverge again (#2486). The
  // detection/recovery logic lives in epic #1231; this preference only stores
  // the user's choice.
  autoRecoverFromApiErrors: AUTO_RECOVER_DEFAULT_ENABLED,
  // #3618: OFF by default (the shared constant) → preserves current behavior;
  // with it off, no auto-switch decision is ever armed.
  autoSwitchOnRateLimit: AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED,
  systemHealthDisplayTarget: "FED",
  composerSubmitBehavior: DEFAULT_COMPOSER_SUBMIT_BEHAVIOR,
  // #1951 A4: "bypassPermissions" (YOLO) preserves the prior YOLO-on default.
  defaultSpawnPermissionMode: "bypassPermissions",
  // #2042 (A4): auto-select OFF by default → preserves current selection behavior.
  // #3611: default from the shared AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED (also
  // consumed by the server schema) so the web cache default and the server default
  // can never diverge (#2486). The displayed truth is the server value via
  // useAutoSelectOptimalAccountPreference; this is only the no-flash first-paint cache.
  autoSelectOptimalAccount: AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED,
  // #2988: seed from the shared CHAT_SECTIONS_DEFAULT (also consumed by the
  // server schema) so the web cache default and server default can't diverge.
  chatSections: CHAT_SECTIONS_DEFAULT,
  defaultOutputStyle: DEFAULT_OUTPUT_STYLE_DEFAULT,
  // #4550: default OFF (operator ruling R2-2) → Send does not press Enter.
  terminalComposeEnterAfterSend: false,
};

function readStored(): AdminPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_ADMIN_PREFERENCES;
    }
    const parsed = JSON.parse(raw);
    // Future migrations live here. A version mismatch falls back to defaults.
    if (parsed?.version !== 1) {
      return DEFAULT_ADMIN_PREFERENCES;
    }
    // Spread over defaults so a partial blob never returns undefined fields
    // (this is also how new v1 fields back-fill onto pre-existing v1 blobs).
    const merged: AdminPreferences = {
      ...DEFAULT_ADMIN_PREFERENCES,
      ...parsed,
      version: 1,
    };
    // #3003 F4: the shallow merge above back-fills a MISSING `chatSections`, but a
    // present-but-corrupted blob (e.g. one missing the nested `reasoning` leaf)
    // replaces the default wholesale and would pass through unvalidated — a
    // consumer reading `chatSections.reasoning.previewLines` during the no-flash
    // window could then throw. Re-parse the merged `chatSections` through its
    // schema (which fills any missing leaf from its own defaults) and fall back to
    // the shared default on a hard failure. readStored stays non-throwing.
    const sectionsParsed = ChatSectionsPreferenceSchema.safeParse(
      merged.chatSections
    );
    return {
      ...merged,
      chatSections: sectionsParsed.success
        ? sectionsParsed.data
        : CHAT_SECTIONS_DEFAULT,
    };
  } catch {
    return DEFAULT_ADMIN_PREFERENCES;
  }
}

function writeStored(prefs: AdminPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors (e.g. quota) per the useServerUrl convention.
  }
}

// Module-level store: one shared value + a listener set. Every mounted
// useAdminPreferences() instance subscribes via useSyncExternalStore, so a
// setter notifies ALL of them in the same React update (the cross-subtree sync
// behind the "icon updates within one render cycle" acceptance criterion).
let current: AdminPreferences = readStored();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AdminPreferences {
  return current;
}

function update(patch: Partial<AdminPreferences>): void {
  current = { ...current, ...patch, version: 1 };
  writeStored(current);
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Re-read module state from localStorage and notify listeners. Tests call this
 * after `localStorage.clear()` so module state does not leak between cases.
 */
export function __resetAdminPreferencesForTests(): void {
  current = readStored();
  for (const listener of listeners) {
    listener();
  }
}

// #3018 (R1): cross-tab bridge. A native `storage` event fires only in OTHER
// documents of the same origin (never the tab that wrote), so this single
// module-level listener observes admin-preference writes made in other tabs. On a
// matching event it re-reads module state — so every mounted useAdminPreferences
// re-renders with the new cache — and, ONLY when the chat-sections matrix changed
// by value, dispatches a dedicated `hapi:chat-sections-storage-changed` window event
// carrying `{ origin: "storage", value }` for useChatSectionPrefs to adopt() without
// a PUT. It deliberately does NOT dispatch for density or any other admin preference,
// and does NOT reuse the SSE event name (that one is payload-free and means "refetch
// the authoritative value"; this one carries the cache value for immediate adoption).
// Registered once (idempotent guard) so tests / HMR reloads cannot create duplicates.
let storageBridgeRegistered = false;
function ensureChatSectionsStorageBridge(): void {
  if (storageBridgeRegistered) return;
  if (typeof window === "undefined") return;
  storageBridgeRegistered = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    const prevChatSections = current.chatSections;
    // localStorage is already the new value in this document (shared across tabs),
    // so re-read module state and notify every mounted snapshot subscriber.
    current = readStored();
    for (const listener of listeners) {
      listener();
    }
    // Fire the dedicated cross-tab adoption signal ONLY for a real chat-sections
    // value change (compare by VALUE — the matrix is an object).
    if (
      JSON.stringify(prevChatSections) !== JSON.stringify(current.chatSections)
    ) {
      window.dispatchEvent(
        new CustomEvent("hapi:chat-sections-storage-changed", {
          detail: { origin: "storage", value: current.chatSections },
        })
      );
    }
  });
}

ensureChatSectionsStorageBridge();

export function useAdminPreferences(): {
  prefs: AdminPreferences;
  setDensity: (density: DensityMode) => void;
  setAutoExpandRepoGroups: (value: boolean) => void;
  setSessionListControlBarPosition: (value: ControlBarPosition) => void;
  setAutoRecoverFromApiErrors: (value: boolean) => void;
  setAutoSwitchOnRateLimit: (value: boolean) => void;
  setSystemHealthDisplayTarget: (target: string) => void;
  setComposerSubmitBehavior: (value: ComposerSubmitBehavior) => void;
  setDefaultSpawnPermissionMode: (value: PermissionMode) => void;
  setAutoSelectOptimalAccount: (value: boolean) => void;
  setChatSections: (value: ChatSectionsPreference) => void;
  setDefaultOutputStyle: (value: string) => void;
  setTerminalComposeEnterAfterSend: (value: boolean) => void;
} {
  const prefs = useSyncExternalStore(subscribe, getSnapshot);

  const setDensity = useCallback(
    (density: DensityMode) => update({ density }),
    []
  );
  const setAutoExpandRepoGroups = useCallback(
    (autoExpandRepoGroups: boolean) => update({ autoExpandRepoGroups }),
    []
  );
  const setSessionListControlBarPosition = useCallback(
    (sessionListControlBarPosition: ControlBarPosition) =>
      update({ sessionListControlBarPosition }),
    []
  );
  const setAutoRecoverFromApiErrors = useCallback(
    (autoRecoverFromApiErrors: boolean) => update({ autoRecoverFromApiErrors }),
    []
  );
  const setAutoSwitchOnRateLimit = useCallback(
    (autoSwitchOnRateLimit: boolean) => update({ autoSwitchOnRateLimit }),
    []
  );
  const setSystemHealthDisplayTarget = useCallback(
    (systemHealthDisplayTarget: string) =>
      update({ systemHealthDisplayTarget }),
    []
  );
  const setComposerSubmitBehavior = useCallback(
    (composerSubmitBehavior: ComposerSubmitBehavior) =>
      update({ composerSubmitBehavior }),
    []
  );
  const setDefaultSpawnPermissionMode = useCallback(
    (defaultSpawnPermissionMode: PermissionMode) =>
      update({ defaultSpawnPermissionMode }),
    []
  );
  const setAutoSelectOptimalAccount = useCallback(
    (autoSelectOptimalAccount: boolean) => update({ autoSelectOptimalAccount }),
    []
  );
  const setChatSections = useCallback(
    (chatSections: ChatSectionsPreference) => update({ chatSections }),
    []
  );
  const setDefaultOutputStyle = useCallback(
    (defaultOutputStyle: string) => update({ defaultOutputStyle }),
    []
  );
  const setTerminalComposeEnterAfterSend = useCallback(
    (terminalComposeEnterAfterSend: boolean) =>
      update({ terminalComposeEnterAfterSend }),
    []
  );

  return {
    prefs,
    setDensity,
    setAutoExpandRepoGroups,
    setSessionListControlBarPosition,
    setAutoRecoverFromApiErrors,
    setAutoSwitchOnRateLimit,
    setSystemHealthDisplayTarget,
    setComposerSubmitBehavior,
    setDefaultSpawnPermissionMode,
    setAutoSelectOptimalAccount,
    setChatSections,
    setDefaultOutputStyle,
    setTerminalComposeEnterAfterSend,
  };
}
