// SPDX-License-Identifier: AGPL-3.0-only
import type { StoredErrorLog } from "../types";
import type { TurnStore } from "./turnStore";
import type { TurnWriteService } from "./turnWriteService";
import type { TurnEventKind } from "./types";

/**
 * Consumer-facing contract that `ErrorLogStore` depends on (issue #1673, Sub K).
 *
 * Kept as a one-method interface so `ErrorLogStore` (in `store/`) does not import
 * the turns module's concrete classes — its late-bound setter takes this type.
 */
export interface TurnErrorMirror {
  /** Mirror one persisted `error_logs` row into `turn_events`. NEVER throws. */
  mirrorError(entry: StoredErrorLog): void;
}

/**
 * Categories that name the turn-telemetry infrastructure itself. Mirroring these
 * would let a persistent turn-write failure — which `TurnWriteService.logDrop`
 * surfaces via `errorLogger.error({ category: "turns-write" })` — re-enqueue
 * another turn write, amplifying under DB contention (R4 loop guard).
 *
 * `api-error` is also skipped (ruling D2 / issue #1232): the transcript parser
 * (Sub C #1665) already emits a transcript-sourced `api_error` turn event for
 * every `isApiErrorMessage` entry, so mirroring #1232's `api-error` error_logs
 * here would double-count terminal exhaustions AND add spurious `api_error`
 * turn events for rate-limited `retrying` warns. Transcript-sourced events stay
 * the single `turn_events` producer for API errors; the rich #1232 context
 * (phase / errorType / requestId) lives in `error_logs`.
 */
const MIRROR_SKIP_CATEGORIES = new Set([
  "turns-write",
  "turns-lifecycle",
  "api-error",
]);

/**
 * Fail-open error-log → `turn_events` dual-writer (issue #1673, Sub K — epic #1662).
 *
 * Every `error_logs` insert — from any of the three producers (`ErrorLogger`,
 * `POST /api/error-reports`, `POST /cli/error-reports`) — routes through
 * `ErrorLogStore.createEntry`, which calls `mirrorError` here. When the error
 * carries a `session_id` that resolves to an OPEN turn, we append one
 * `turn_events` row (kind `error`, or `api_error` for the `api-error` category)
 * attributed to that turn, via Sub A's fail-open `TurnWriteService`.
 *
 * Design notes:
 *   - `turn_events.turn_id` is NOT NULL, so a NULL-turn fallback is impossible:
 *     errors fired OUTSIDE an open turn stay `error_logs`-only (still surfaced by
 *     the `v_error_log` view's `error_logs` arm).
 *   - Events carry `payload.errorLogId`, which both links the mirror back to its
 *     `error_logs` row AND distinguishes K's mirrors from Sub C #1665's
 *     transcript-sourced `error`/`api_error` events (which have no `errorLogId`).
 *   - FAIL-OPEN: every path is wrapped; `mirrorError` never throws and never
 *     re-enters the error logger (recursion guard). The DB is a rebuildable index
 *     (Sub F backfill), so a dropped mirror is safe.
 */
export class TurnErrorMirrorService implements TurnErrorMirror {
  constructor(
    private readonly turnStore: TurnStore,
    private readonly writeService: TurnWriteService
  ) {}

  mirrorError(entry: StoredErrorLog): void {
    try {
      const sessionId = entry.sessionId;
      if (!sessionId) return; // no session → no turn to attribute against (R2)
      if (MIRROR_SKIP_CATEGORIES.has(entry.category)) return; // R4 loop guard

      const turn = this.turnStore.getOpenTurnForSession(sessionId);
      if (!turn) return; // no open turn → error_logs-only (R2)

      // `api-error` maps to the `api_error` kind, but such error_logs are
      // skipped above (MIRROR_SKIP_CATEGORIES, ruling D2 #1232), so in practice
      // the mirror only ever emits `error` today; the mapping is retained for
      // the #1673 contract shape (and correct should the skip ever be lifted).
      const kind: TurnEventKind =
        entry.category === "api-error" ? "api_error" : "error";

      this.writeService.enqueueAppendEvents({
        turnId: turn.id,
        nodeId: turn.nodeId,
        events: [
          {
            // error_logs INSERT time → aligns the mirror to its row on the
            // parity window (replays carry their own original_timestamp).
            tsMs: entry.timestamp,
            kind,
            name: entry.category,
            payload: {
              errorLogId: entry.id,
              severity: entry.severity,
              source: entry.source,
              message: entry.message,
            },
          },
        ],
      });
    } catch {
      // FAIL-OPEN (R3): never throw out of the error-log write path, and never
      // re-enter the error logger (would risk recursion via createEntry).
    }
  }
}
