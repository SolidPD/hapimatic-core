// SPDX-License-Identifier: AGPL-3.0-only
/**
 * windowOwnership — tmux window OWNERSHIP, and the only module that may
 * produce an {@link OwnedWindowTarget} (issue #4218: K1 + G1).
 *
 * A tmux window has three keys, and only one of them proves ownership:
 *
 *  - `window_name` — a DISPLAY label. Same-titled sessions share it (every run
 *    of a schedule is renamed to the task name), so a name never identifies a
 *    session.
 *  - `@N` (`#{window_id}`) — an ADDRESS that is unique only within ONE
 *    tmux-server lifetime. tmux numbers windows from a per-server counter, so a
 *    new server reuses `@0`, `@1`, … and a persisted `@N` can address another
 *    session's live window after a server restart (#4238).
 *  - `@hapi_identity` — the user option set to the session TAG at spawn
 *    (`tmuxSpawnAdapter` stamps it on the window it just created). This is the
 *    OWNERSHIP proof. A legacy window with no identity is owned only when its
 *    pane process tree carries `HAPI_SESSION_ID === tag` (provable only while
 *    Claude or bwrap still runs under the pane).
 *
 * Every public window-MUTATING `TmuxManager` method takes an `OwnedWindowTarget`,
 * a branded type that only this module can construct. The one internal
 * exception is `createOrReplaceWindow`, which replaces a same-named stale
 * window through the private `killWindowUnchecked`. Its `onNameConflict`
 * option decides whether it may: the daemon's named spawns pass `"fail"`, so
 * a name they got from a dedup never kills another live window (#4443).
 * Each producer below names one trust basis, so a reader can audit WHY a call
 * site may mutate a window:
 *
 *  - {@link resolveOwnedWindow} — owned: `@hapi_identity` (or the legacy env
 *    tag) equals the caller's tag. DAEMON socket only.
 *  - {@link spawnedWindowTarget} — a window THIS spawn just created.
 *  - {@link remoteLauncherWindowTarget} — a `hapimatic-remote` window (there
 *    `@hapi_identity` is a display name, so K1 must never run — #4238 R6).
 *  - {@link reaperWindowTarget} — a row from a fresh listing in a reaper that
 *    applies its own ownerlessness test. That test is a heuristic, not a
 *    proof: `cleanupGhostWindows` reads the pane env non-strictly, so a tmux
 *    fault there reads as "no session".
 *
 * The brand proves ownership at RESOLVE time, not at use time: mint
 * immediately before the mutation and never store an `OwnedWindowTarget` in a
 * field, map or persisted record. `ownedTargetGuard.test.ts` enforces the
 * allowlists and rejects casts outside this module.
 */

import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import type { TmuxManager } from "./TmuxManager";
import type { CreateWindowResult } from "./types";

declare const OWNED: unique symbol;

/**
 * A window target that a named producer in this module vouched for. The
 * runtime value is exactly what the caller would have passed before (an `@N`,
 * a numeric index, or a name) — the brand is type-only and erased at runtime.
 * Not every mutator resolves every form the same way: most go through
 * `resolveDualTarget` (an `@N` verbatim, an index, or a name);
 * `killWindowByExactName` is meant for a NAME (tmux still resolves an `@N` or
 * an index after its `=` prefix — that kills the window it names); `sendKeys`
 * resolves a name or an index, so an `@N` finds nothing there.
 */
export type OwnedWindowTarget = (string | number) & { readonly [OWNED]: true };

/** The reads K1's ownership predicate needs (a structural subset for tests). */
export type OwnershipReader = Pick<
  TmuxManager,
  "getWindowIdentity" | "getWindowHapiSessionId"
>;

/** Everything {@link resolveOwnedWindow} reads. */
export type OwnershipResolver = Pick<
  TmuxManager,
  | "probeWindowIdentity"
  | "probeWindowHapiSessionId"
  | "listWindowsWithIdentity"
  | "socket"
>;

/** Why a window is not owned by the caller. */
export type NotOwnedReason =
  | "window-gone"
  | "foreign-identity"
  | "unverifiable";

/** Outcome of {@link decideOwnership} — pure, no tmux. */
export type OwnershipVerdict =
  | { kind: "owned" }
  | { kind: "not-owned"; reason: NotOwnedReason; identity: string | null };

/**
 * Outcome of {@link resolveOwnedWindow}. Three-way, like
 * `getWindowNameByIndex` (#1329): a tmux fault is never read as "not owned"
 * and never as "owned" — the caller decides (destructive callers refuse).
 */
export type OwnershipResult =
  | { kind: "owned"; target: OwnedWindowTarget }
  | { kind: "not-owned"; reason: NotOwnedReason; identity: string | null }
  | { kind: "fault"; error: unknown };

/**
 * Pure K1 ownership rule. `identity` is the window's `@hapi_identity` (null
 * when unset); `procTag` is the `HAPI_SESSION_ID` found in the pane's process
 * tree (consulted only when the identity is unset — the legacy arm).
 */
export function decideOwnership(input: {
  exists: boolean;
  identity: string | null;
  procTag: string | null;
  tag: string;
}): OwnershipVerdict {
  if (!input.exists) {
    return { kind: "not-owned", reason: "window-gone", identity: null };
  }
  if (input.identity) {
    return input.identity === input.tag
      ? { kind: "owned" }
      : {
          kind: "not-owned",
          reason: "foreign-identity",
          identity: input.identity,
        };
  }
  if (input.procTag === input.tag) return { kind: "owned" };
  return {
    kind: "not-owned",
    reason: input.procTag ? "foreign-identity" : "unverifiable",
    identity: input.procTag,
  };
}

/**
 * K1 (pinned with #4038, #4080 and the #4221 coordination directive): is
 * `target` owned by `tag`? Identity `=== tag`, or — when the identity is empty —
 * the pane tree's `HAPI_SESSION_ID === tag`. Read-only; any fault → false.
 *
 * DAEMON socket only — on the `hapimatic-remote` socket `@hapi_identity` holds
 * a display name, not a tag (#4238 R6). Re-exported from `tmuxSpawnAdapter.ts`
 * so K1's import path holds; this is the single definition.
 */
export async function windowOwnedBy(
  tmux: OwnershipReader,
  target: string,
  tag: string
): Promise<boolean> {
  try {
    const identity = await tmux.getWindowIdentity(target);
    if (identity) return identity === tag;
    return (await tmux.getWindowHapiSessionId(target)) === tag;
  } catch {
    return false;
  }
}

function isRemoteSocket(tmux: Pick<TmuxManager, "socket">): boolean {
  return tmux.socket === configuration.tmuxRemoteSessionName;
}

function isDaemonSocket(tmux: Pick<TmuxManager, "socket">): boolean {
  return tmux.socket === configuration.tmuxSessionName;
}

/**
 * Resolve `target` (an `@N` or a window name) to a window `tag` OWNS, as an
 * {@link OwnedWindowTarget}. The returned target is always the window's `@N`:
 *
 *  - an `@N` is checked as given (exists AND owned);
 *  - a NAME is first resolved to the `@N` of the single window holding it. If
 *    several windows share the name, only the one whose identity is `tag`
 *    qualifies; anything else is `unverifiable` (ambiguous) — never a guess.
 *
 * Refuses (fault) on the `hapimatic-remote` socket (#4238 R6).
 */
export async function resolveOwnedWindow(
  tmux: OwnershipResolver,
  target: string,
  tag: string
): Promise<OwnershipResult> {
  if (isRemoteSocket(tmux)) {
    const error = new Error(
      "resolveOwnedWindow: K1 ownership is not valid on the hapimatic-remote socket (#4238 R6)"
    );
    logger.warn(`[windowOwnership] ${error.message}`);
    return { kind: "fault", error };
  }
  try {
    let id: string;
    if (/^@\d+$/.test(target)) {
      id = target;
    } else {
      const rows = await tmux.listWindowsWithIdentity();
      const named = rows.filter(r => r.name === target && r.id);
      const ownedRows = named.filter(r => r.identity === tag);
      const pick =
        named.length === 1
          ? named[0]
          : ownedRows.length === 1
            ? ownedRows[0]
            : undefined;
      if (named.length === 0) {
        return { kind: "not-owned", reason: "window-gone", identity: null };
      }
      if (!pick?.id) {
        return { kind: "not-owned", reason: "unverifiable", identity: null };
      }
      id = pick.id;
    }
    // Both reads THROW on a tmux fault (→ `fault` below), so a fault is never
    // read as "no identity" or "no env" (`unverifiable`).
    const { exists, identity } = await tmux.probeWindowIdentity(id);
    const procTag =
      exists && !identity ? await tmux.probeWindowHapiSessionId(id) : null;
    const verdict = decideOwnership({ exists, identity, procTag, tag });
    if (verdict.kind === "owned") {
      return { kind: "owned", target: id as OwnedWindowTarget };
    }
    return verdict;
  } catch (error) {
    return { kind: "fault", error };
  }
}

/**
 * One log-ready wording for a result that is NOT `owned`, shared by every
 * caller's refusal line: a fault carries its error text, a foreign window names
 * its holder, anything else is the bare reason.
 */
export function describeOwnershipFailure(
  result: Exclude<OwnershipResult, { kind: "owned" }>
): string {
  if (result.kind === "fault") {
    const error = result.error;
    return `tmux fault: ${error instanceof Error ? error.message : String(error)}`;
  }
  return result.reason === "foreign-identity"
    ? `held by ${result.identity ?? "another session"}`
    : result.reason;
}

/**
 * A window THIS spawn just created (identity not stamped yet — stamping it is
 * itself a mutation). Prefers the captured `@N` (`new-window -P`), then the
 * captured index (addressed as `<session>:<index>` with no `listWindows()`,
 * the #945/#1315 fix), then the spawn's uniquified name
 * (`reserveUniqueWindowName`). All three name the window this spawn created in
 * the CURRENT tmux-server lifetime, moments ago.
 */
export function spawnedWindowTarget(
  created: Pick<CreateWindowResult, "index" | "id">,
  spawnName: string
): OwnedWindowTarget {
  return (created.id ?? created.index ?? spawnName) as OwnedWindowTarget;
}

/**
 * A `hapimatic-remote` launcher window. Trust basis: candidate names are
 * `hapi-remote-<serverUuid>` (#1628), reapers filter by the instance's
 * owned-tag set (#1655), and a launcher only touches the window it created.
 * Throws on the daemon socket — K1 targets must come from
 * {@link resolveOwnedWindow} there.
 */
export function remoteLauncherWindowTarget(
  tmux: Pick<TmuxManager, "socket">,
  target: string | number
): OwnedWindowTarget {
  if (isDaemonSocket(tmux)) {
    throw new Error(
      "remoteLauncherWindowTarget: called on the daemon socket — use resolveOwnedWindow (#4218)"
    );
  }
  return target as OwnedWindowTarget;
}

/**
 * A row from a FRESH listing in a reaper that decides by its own window-level
 * heuristic — NOT an `@hapi_identity` proof. `reconcileOrphanWindows`:
 * `hapi-spawn-` signature, childless, untagged by `@hapi_archive`, not an
 * active tracked index, debounced. `cleanupGhostWindows` (daemon start): not
 * claimed by any persisted session (by index, or legacy name) and no live
 * process carrying a KNOWN session id — it does not read `@hapi_identity`, and
 * its env read treats a fault as "no session". Addresses exactly that row's
 * index.
 */
export function reaperWindowTarget(row: { index: number }): OwnedWindowTarget {
  return row.index as OwnedWindowTarget;
}
