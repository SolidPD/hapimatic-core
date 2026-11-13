// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6617 (Matt 43a / D1-1 / D7-1; the PM's D4 g3-1 and g2-1, 2026-11-11):
 * runClaude's permission-mode appliers, extracted so they are a pure function of
 * their dependencies (the `applyModelInPlace.ts` precedent, #3769). runClaude
 * wires its own closure state; the unit test drives the pair with fakes.
 *
 * - `record(mode)` records a mode where every later decision reads it
 *   (runClaude's copy, the saved `metadata.permissionMode`, the session) and
 *   sends nothing to the live child. A permission card and a plan approval call
 *   it directly; the UI's change runs the same recording through `apply`. With
 *   the narrowing switch on it is the ONE place the `permission-mode-changed`
 *   chat event and the mode-change log line are written (R15). Round 4 (the
 *   board-26 PM's option 2, 2026-11-12): because it switches nothing, it then
 *   ends a running query whose child is WIDER than the mode it recorded.
 * - `apply(mode)` is the UI's in-place change (#2346): with the switch on it
 *   first refuses a change a running tmux / pty child can never receive (R14),
 *   then records, then sends the live switch to a running SDK query and waits a
 *   bounded time for it (R13); a switch that fails, or that lands while the
 *   screen shows another mode (Matt 93a), ends that query. With the switch off
 *   it is the pre-#6617 applier line for line.
 */
import type { Query } from "./sdk/query";
import { SdkRequestError } from "./sdk/types";
import type { PermissionMode } from "./loop";
import type { PermissionModeApplyResult } from "./session";
import { permissionNarrowingHolds } from "./spawnPermissionSeed";

/**
 * How long `apply` waits for the live switch before it reports it as pending.
 * Well below the server's 30 s RPC timeout (`server/src/sync/rpcGateway.ts`), so
 * the wrapper always answers first, and well above the time an idle SDK reader
 * takes to answer a control request.
 */
export const LIVE_PERMISSION_SWITCH_WAIT_MS = 5_000;

/** Issue #6617 (D7-1): what a refused change on a running tmux / pty session says. */
export const PERMISSION_MODE_CHANGE_REFUSED_MESSAGE =
  "This session runs Claude in a terminal (tmux/pty), so a mode change cannot reach the running Claude. Stop the session, change the mode on the stopped session, then reconnect it.";

/**
 * Issue #6617 (D7-1): a mode change refused before anything is recorded. The
 * `set-session-config` handler rethrows it, so the RPC answers with the CLI's
 * error envelope and the server shows its message.
 */
export class PermissionModeChangeRefused extends Error {
  constructor(message: string = PERMISSION_MODE_CHANGE_REFUSED_MESSAGE) {
    super(message);
    this.name = "PermissionModeChangeRefused";
  }
}

/** The parts of the Claude `Session` the appliers read. */
export interface PermissionModeApplierSession {
  getLiveQuery(): Query | null;
  endLiveQuery(query: Query): void;
  markPermissionModeSetHere(): void;
  /** The mode a live query's child is in (round 4), if it was noted. */
  getLiveChildMode(query: Query): PermissionMode | undefined;
  /** Notes the mode a live query's child is in (its start, a landed switch). */
  noteLiveChildMode(query: Query, mode: PermissionMode): void;
  readonly mode: "local" | "remote";
}

/**
 * Round 4 (the board-26 PM's option 2): how wide each mode lets a child act, so
 * "the child runs wider than the session shows" can be read. `plan` changes
 * nothing; `bypassPermissions` allows everything.
 */
const PERMISSION_MODE_WIDTH: Readonly<Record<PermissionMode, number>> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
};

/** Whether a child in `child` may do more than `shown` lets it (round 4). */
export function isWiderPermissionMode(
  child: PermissionMode,
  shown: PermissionMode
): boolean {
  return PERMISSION_MODE_WIDTH[child] > PERMISSION_MODE_WIDTH[shown];
}

export interface PermissionModeApplierDeps {
  /**
   * runClaude's `currentPermissionMode`, the mode the session shows: the
   * comparison and the chat line read it, and the log line names it as the
   * old mode.
   */
  getCurrentMode: () => PermissionMode;
  /** Sets runClaude's `currentPermissionMode`. */
  setCurrentMode: (mode: PermissionMode) => void;
  /** The durable pin: the `metadata.permissionMode` write (Round 11, #3285). */
  saveMode: (mode: PermissionMode) => void;
  /** runClaude's `syncSessionModes`: copies runClaude's state onto the session. */
  sync: () => void;
  /** The live Claude session, or null before it is ready. */
  getSession: () => PermissionModeApplierSession | null;
  /** Posts one chat line to the session. */
  postMessage: (text: string) => void;
  /** Sends a session event (R15: `permission-mode-changed`). */
  sendEvent: (event: {
    type: "permission-mode-changed";
    mode: PermissionMode;
  }) => void;
  log: { info: (message: string) => void; warn: (message: string) => void };
  /** runClaude's resolved launcher kind (`sdk`, `pty`, `tmux`). */
  launcherKind: string;
  /** The live-switch wait; defaults to {@link LIVE_PERMISSION_SWITCH_WAIT_MS}. */
  waitMs?: number;
  /** The narrowing switch; defaults to {@link permissionNarrowingHolds}. */
  narrowingHolds?: () => boolean;
}

export interface PermissionModeAppliers {
  record: (mode: PermissionMode) => void;
  apply: (mode: PermissionMode) => Promise<PermissionModeApplyResult>;
}

function isClaudeExited(err: unknown): boolean {
  return err instanceof SdkRequestError && err.code === "claude_exited";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createPermissionModeAppliers(
  deps: PermissionModeApplierDeps
): PermissionModeAppliers {
  const holds = deps.narrowingHolds ?? (() => permissionNarrowingHolds());
  const waitMs = deps.waitMs ?? LIVE_PERMISSION_SWITCH_WAIT_MS;

  /** The recording itself; `apply` sends the live switch after it. */
  const recordMode = (mode: PermissionMode): void => {
    const previous = deps.getCurrentMode();
    deps.setCurrentMode(mode);
    deps.saveMode(mode);
    deps.sync();
    deps.getSession()?.markPermissionModeSetHere();
    if (holds()) {
      deps.sendEvent({ type: "permission-mode-changed", mode });
      deps.log.info(`[permission-mode] changed: ${previous} → ${mode} (#6617)`);
    }
  };

  /** The pre-#6617 applier (#2346), line for line: the switch-off path. */
  const applyToday = async (
    mode: PermissionMode
  ): Promise<PermissionModeApplyResult> => {
    deps.setCurrentMode(mode);
    deps.saveMode(mode);
    deps.sync();
    const liveQuery = deps.getSession()?.getLiveQuery() ?? null;
    if (liveQuery) {
      await liveQuery.setPermissionMode(mode);
      return { method: "sdk" };
    }
    return { method: "config" };
  };

  /** Queries already ended here, so a run is stopped once, with one line. */
  const endedQueries = new WeakSet<Query>();

  /**
   * R13: end a running query, the one a live switch was sent to or (round 4)
   * the one whose child a recorded mode found wider (only that one: the
   * launcher's terminator compares it with its current query), so the next
   * message starts a new query in the live mode, and say so in one chat line.
   * The line names the mode in force when it is posted (Matt 93a, 2026-11-12):
   * a change made while the switch waited may have moved the screen since. A
   * query already ended here is left alone (round 4): a recorded mode can end
   * a run that a waiting switch then reaches, and R13 promises one line.
   */
  const endQueryForLiveMode = (
    query: Query,
    switchingTo: PermissionMode
  ): void => {
    if (endedQueries.has(query)) {
      return;
    }
    endedQueries.add(query);
    deps.getSession()?.endLiveQuery(query);
    deps.postMessage(
      `Switching to ${switchingTo} needs the turn to restart, so the turn was stopped. Your next message runs in ${deps.getCurrentMode()}.`
    );
  };

  /** R13: a live switch that failed ends the query it was sent to. */
  const endQueryAfterFailedSwitch = (
    query: Query,
    mode: PermissionMode,
    err: unknown
  ): void => {
    deps.log.warn(
      `[permission-mode] live switch to ${mode} failed: ${errorText(err)}; ending the running query (#6617)`
    );
    endQueryForLiveMode(query, mode);
  };

  /**
   * The one comparison of the mode a running child is in with the mode the
   * session shows and saves, run after every write of the shown mode while a
   * query is live (Matt 93a, 2026-11-12; round 4, the board-26 PM's option 2).
   * On a mismatch the query is ended the same way a failed switch ends it, so
   * the next message starts in the mode the screen shows. Returns whether it
   * was ended.
   *
   * - `"landed"`: a live switch has just put the child in `child`, for
   *   example while a permission card answered behind it recorded the card's
   *   mode. Any difference ends the run.
   * - `"recorded"`: a write that switches nothing (a card answer's mode) has
   *   just moved the screen, and the child is still in `child`. Only a child
   *   WIDER than the screen ends the run.
   *
   * The two differ on purpose: a user who asked for a switch and did not get
   * it is told, while a recorded mode over a narrower child changes nothing
   * the user can observe, because the wrapper answers every question that
   * child asks from the shown mode (D6-1).
   */
  const endQueryIfScreenMoved = (
    query: Query,
    child: PermissionMode,
    after: "landed" | "recorded"
  ): boolean => {
    const shown = deps.getCurrentMode();
    const ends =
      after === "landed"
        ? shown !== child
        : isWiderPermissionMode(child, shown);
    if (!ends) {
      return false;
    }
    deps.log.warn(
      after === "landed"
        ? `[permission-mode] live switch to ${child} landed while the session shows ${shown}; ending the running query (#6617)`
        : `[permission-mode] the child runs ${child}, wider than the ${shown} the session now shows; ending the running query (#6617)`
    );
    endQueryForLiveMode(query, shown);
    return true;
  };

  /**
   * Round 4: a live switch landed, so the child is now in `mode`; note it for
   * a later recorded mode, then compare.
   */
  const switchLanded = (query: Query, mode: PermissionMode): boolean => {
    deps.getSession()?.noteLiveChildMode(query, mode);
    return endQueryIfScreenMoved(query, mode, "landed");
  };

  const record = (mode: PermissionMode): void => {
    recordMode(mode);
    if (!holds()) {
      return;
    }
    const session = deps.getSession();
    const liveQuery = session?.getLiveQuery() ?? null;
    if (!session || !liveQuery) {
      return;
    }
    // A child whose mode was never noted counts as the widest, so a gap in the
    // tracking stops the run rather than leaving it wider than the screen.
    endQueryIfScreenMoved(
      liveQuery,
      session.getLiveChildMode(liveQuery) ?? "bypassPermissions",
      "recorded"
    );
  };

  const apply = async (
    mode: PermissionMode
  ): Promise<PermissionModeApplyResult> => {
    if (!holds()) {
      return applyToday(mode);
    }
    const session = deps.getSession();
    const liveQuery = session?.getLiveQuery() ?? null;
    // R14 (D7-1): a running tmux / pty child has no in-place channel for a mode
    // change, so refuse it BEFORE recording: a recorded-but-unapplied mode is
    // the false screen this change removes. In local mode the local child reads
    // the live mode at its next launch, so the change is applied as usual.
    if (
      (deps.launcherKind === "tmux" || deps.launcherKind === "pty") &&
      session?.mode === "remote" &&
      !liveQuery
    ) {
      throw new PermissionModeChangeRefused();
    }
    recordMode(mode);
    if (!liveQuery) {
      return { method: "config" };
    }

    const switching = liveQuery.setPermissionMode(mode);
    const settled = switching.then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, err }) as const
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"pending">(resolve => {
      timer = setTimeout(() => resolve("pending"), waitMs);
    });
    const first = await Promise.race([settled, timedOut]);
    clearTimeout(timer);

    if (first === "pending") {
      // Still waiting, for example behind an open permission card (the SDK
      // reader is awaiting the card, so the reply is read only after it is
      // answered). Pending, never failed. A later failure ends that query, and
      // so does a later success once the screen shows another mode (93a).
      void settled.then(outcome => {
        if (outcome.ok) {
          switchLanded(liveQuery, mode);
        } else if (!isClaudeExited(outcome.err)) {
          endQueryAfterFailedSwitch(liveQuery, mode, outcome.err);
        }
      });
      deps.log.info(
        `[permission-mode] live switch to ${mode} still pending after ${waitMs} ms (#6617)`
      );
      return { method: "sdk", permissionSwitch: "pending" };
    }
    if (first.ok) {
      // A card answered inside the wait moves the screen just as one answered
      // after it (93a).
      return {
        method: "sdk",
        permissionSwitch: switchLanded(liveQuery, mode) ? "ended" : "applied",
      };
    }
    // The child exited (the exit drain): the launcher's crash path handles it.
    if (!isClaudeExited(first.err)) {
      endQueryAfterFailedSwitch(liveQuery, mode, first.err);
    }
    throw first.err;
  };

  return { record, apply };
}
