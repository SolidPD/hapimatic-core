// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Optimistic-spawn handover store (issue #3515).
 *
 * When the web Create page spawns a session on the early-ack (`earlyReturn`)
 * path, the server answers `{type:"accepted", sessionId}` where `sessionId` is
 * the future session's TAG (the pre-generated `hapiSessionId`, NOT the row uuid
 * — finding 3515-1). The UI navigates immediately to `/sessions/<tag>` and
 * renders a placeholder composer (`SpawningSessionView`) while the daemon spawn
 * completes in the background.
 *
 * This module is the client-side bridge across that placeholder → real-session
 * swap, keyed by the placeholder id (= the tag):
 *   - `draft`        — the prompt the user typed on the placeholder composer,
 *                      written ONCE to the real uuid's promptDraft at the swap
 *                      (never under the tag — `PUT /sessions/:id/prompt-draft`
 *                      resolves by uuid and 404s a tag; never an empty string —
 *                      open #3636 forbids a second empty-string writer).
 *   - `emoji` /
 *     `linkedIssue`  — deferred session properties known at create time. The
 *                      local spawn body carries `name` (server dedups it) but
 *                      NOT emoji/linkedIssue, so these are applied to the real
 *                      uuid at the swap rather than lost (Task 1 "verify nothing
 *                      is lost").
 *   - `form`         — a snapshot of the user-entered Create form, stashed to the
 *                      retry slot on a spawn FAILURE so Create repopulates for a
 *                      single-click retry (R4).
 *
 * Pattern mirrors `session-action-pending.ts` / `pending-spawns.ts`:
 * module-level Map + `useSyncExternalStore` subscribe/getSnapshot. Reactivity is
 * only needed for "does a handover exist for this route param" (the router switch
 * that chooses SpawningSessionView vs SessionPage) — the draft is read at the
 * swap, so draft writes do not notify.
 */

import { useSyncExternalStore } from "react";
import type { LinkedIssue } from "@hapi/protocol/types";
import type { ExistingBranch } from "@hapi/protocol/gitBranches";
import type { AgentType, SessionType } from "@/components/NewSession/types";

/**
 * The primary user-entered Create-form values captured at optimistic-spawn time
 * so a spawn FAILURE can return to Create with the form still populated (R4).
 * Scoped to the fields a user actively sets; secondary/defaulted fields (account,
 * launcher, model, permission mode, safe mode, GitHub) re-seed from preferences
 * on the fresh Create mount — except a picked API key (`apiKeyId`).
 */
export type SpawnFormSnapshot = {
  directory?: string;
  /** `selectedValue` — the machine/node target token (MachineSelector). */
  target?: string | null;
  name?: string;
  emoji?: string | null;
  linkedIssue?: LinkedIssue | null;
  agent?: AgentType;
  sessionType?: SessionType;
  sessionTypeUserSelected?: boolean;
  worktreeName?: string;
  /** hapimatic-private#4481: the Branch control's existing-branch pick. */
  existingBranch?: ExistingBranch | null;
  /**
   * hapimatic-private#4825 (RV2-8): the picked API key. A key is a billing
   * choice, so a retry restores it rather than re-seeding the account default,
   * which would move a failed key spawn onto a subscription. `null` = an account
   * spawn. Kept even when the key has since left the vault: the daemon then
   * refuses with api_key_not_found (#4568 SF-2). #5127: the key's binding ref
   * (`<uuid>@<home>` for a key another node shares).
   */
  apiKeyId?: string | null;
};

/** One optimistic-spawn handover, keyed by the placeholder id (= the tag). */
export type SpawnHandover = {
  emoji?: string | null;
  linkedIssue?: LinkedIssue | null;
  /** The prompt typed on the placeholder composer. "" until the user types. */
  draft: string;
  /** Create-form snapshot for a single-click retry on failure (R4). */
  form: SpawnFormSnapshot;
};

// ── Module-level store ──────────────────────────────────────────────

const handovers = new Map<string, SpawnHandover>();
const listeners = new Set<() => void>();

/** The last-failed Create form, consumed once by a fresh NewSession mount (R4). */
let pendingRetryForm: SpawnFormSnapshot | null = null;

function notify(): void {
  for (const fn of listeners) fn();
}

// ── Public API — handover lifecycle ─────────────────────────────────

/**
 * Seed a handover at optimistic-create time. Idempotent on `placeholderId`
 * (re-seeding replaces the prior entry). Notifies subscribers so the router
 * switch renders SpawningSessionView for this route param.
 */
export function beginSpawnHandover(
  placeholderId: string,
  init: {
    emoji?: string | null;
    linkedIssue?: LinkedIssue | null;
    form: SpawnFormSnapshot;
  }
): void {
  handovers.set(placeholderId, {
    emoji: init.emoji,
    linkedIssue: init.linkedIssue,
    draft: "",
    form: init.form,
  });
  notify();
}

/**
 * Update the draft prompt as the user types on the placeholder composer. No-op
 * if the handover is gone (already swapped / failed). Does NOT notify — the
 * draft is read at the swap, not rendered from this store.
 */
export function setSpawnDraft(placeholderId: string, draft: string): void {
  const entry = handovers.get(placeholderId);
  if (!entry) return;
  entry.draft = draft;
}

/** Read a handover (the swap site + the composer's initial-text seed). */
export function getSpawnHandover(
  placeholderId: string
): SpawnHandover | undefined {
  return handovers.get(placeholderId);
}

/** Drop a handover (on swap success or on failure). Notifies subscribers. */
export function endSpawnHandover(placeholderId: string): void {
  if (handovers.delete(placeholderId)) notify();
}

// ── Public API — R4 retry snapshot ──────────────────────────────────

/** Stash the failed spawn's form snapshot for the return-to-Create retry (R4). */
export function stashRetryForm(form: SpawnFormSnapshot): void {
  pendingRetryForm = form;
}

/** Read + clear the pending retry snapshot (consumed once by NewSession mount). */
export function takeRetryForm(): SpawnFormSnapshot | null {
  const form = pendingRetryForm;
  pendingRetryForm = null;
  return form;
}

// ── useSyncExternalStore interface ──────────────────────────────────

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Reactively report whether an optimistic-spawn handover exists for this route
 * param. Drives the router switch between SpawningSessionView and SessionPage.
 * `getSnapshot` returns a primitive boolean, so it is stable across renders.
 */
export function useSpawnHandoverActive(placeholderId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => handovers.has(placeholderId),
    () => false
  );
}

/** Test-only: reset all state. */
export function __resetSpawnHandoversForTests(): void {
  handovers.clear();
  listeners.clear();
  pendingRetryForm = null;
}
