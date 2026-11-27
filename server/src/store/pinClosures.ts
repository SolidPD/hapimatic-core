// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  countedClosure,
  isReservedPinKey,
  PIN_MAX_OPEN_PER_SESSION,
  type Pin,
  type PinAnswer,
  type PinClosure,
  type PinContent,
  type PinStatus,
} from "@hapi/protocol";

import type { PinRow } from "./pinStore";

// A pin settled elsewhere (issue #6456, epic #6446): the `session_pins` state
// beside a pin that says it was closed as superseded, what it repeats, whether
// the operator reopened it, and a Detected pin's codes and links. `PinStore`
// owns the upsert and calls the helpers here; `PinClosureStore` is the rest,
// kept out of pinStore.ts, which is near the 1,500-line lint limit.
//
// A superseded pin keeps status `withdrawn`, because a client drops a status it
// does not know (`web/src/lib/pins/ledger.ts`); `closure_json` tells it apart,
// and it is never an answer. `reopened_at` is set once, when the operator
// reopens such a pin, and nothing clears it (R8).

/** The key prefix of a Detected pin (`DETECTED_PIN_PREFIX`, pinTurnCheck.ts). */
export const DETECTED_KEY_PREFIX = "detected:";

/** A pin linked to an open Detected pin, by the agent or by the server (R4). */
export type PinDetectedLink = {
  pinId: string;
  by: "agent" | "server";
  /** ISO-8601 UTC. */
  at: string;
};

/**
 * What a Detected pin keeps beside its content (`detected_json`): the
 * answer-key codes of its message (null when any ask of it was not an answer key
 * with codes), and the pins linked to it. Server-owned, never on the wire.
 */
export type PinDetectedState = {
  codes: string[] | null;
  links: PinDetectedLink[];
};

/** The most pins one Detected pin may be linked to. */
export const PIN_DETECTED_LINKS_MAX = 16;

/** An open Detected pin, with what the follow service decides on. */
export type OpenDetectedPin = {
  key: string;
  pinId: string | null;
  createdAt: number;
  starred: boolean;
  reopened: boolean;
  /** An answers entry the operator made: he wrote on the pin. */
  operatorAnswered: boolean;
  state: PinDetectedState;
};

/**
 * A stored closure, or null when there is none or it does not parse. Only this
 * module and `PinStore` write one, so a wrong shape means a newer binary wrote
 * one this build cannot read; it reads as none.
 */
export function parseClosure(
  json: string | null | undefined
): PinClosure | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown> | null;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.how === "string" &&
      typeof value.rule === "string" &&
      typeof value.by === "string" &&
      typeof value.at === "string"
    ) {
      return value as unknown as PinClosure;
    }
  } catch {
    // A row this build cannot read keeps no closure.
  }
  return null;
}

/** The row's closure while it counts (`countedClosure`), else null. */
export function rowClosure(
  row: Pick<PinRow, "status" | "closure_json" | "reopened_at">
): PinClosure | null {
  return countedClosure({
    status: row.status,
    closure: parseClosure(row.closure_json),
    reopenedAt: row.reopened_at
      ? new Date(row.reopened_at).toISOString()
      : null,
  });
}

/** A Detected pin's stored state; an unreadable one reads as empty. */
export function parseDetected(
  json: string | null | undefined
): PinDetectedState {
  const empty: PinDetectedState = { codes: null, links: [] };
  if (!json) return empty;
  try {
    const value = JSON.parse(json) as Partial<PinDetectedState> | null;
    if (!value || typeof value !== "object") return empty;
    const codes = Array.isArray(value.codes)
      ? value.codes.filter((c): c is string => typeof c === "string")
      : null;
    const links = Array.isArray(value.links)
      ? value.links.filter(
          (l): l is PinDetectedLink =>
            !!l &&
            typeof l === "object" &&
            typeof l.pinId === "string" &&
            (l.by === "agent" || l.by === "server") &&
            typeof l.at === "string"
        )
      : [];
    return { codes: codes && codes.length > 0 ? codes : null, links };
  } catch {
    return empty;
  }
}

/** The content's `repeats` as its column, or null for none. */
export function repeatsJson(content: PinContent): string | null {
  return content.repeats && content.repeats.length > 0
    ? JSON.stringify(content.repeats)
    : null;
}

/**
 * The `detected_json` to write for `key` (a Detected key only, else null):
 * `codes` replaces the stored codes when given (undefined keeps them), and the
 * stored links are always kept, so an update keeps its links.
 */
export function detectedJsonFor(
  key: string,
  codes: string[] | null | undefined,
  prev: string | null | undefined
): string | null {
  if (!key.startsWith(DETECTED_KEY_PREFIX)) return null;
  const kept = parseDetected(prev);
  const next: PinDetectedState = {
    codes:
      codes === undefined
        ? kept.codes
        : codes && codes.length > 0
          ? [...codes]
          : null,
    links: kept.links,
  };
  if (next.codes === null && next.links.length === 0) return null;
  return JSON.stringify(next);
}

/** What `PinClosureStore` reads through `PinStore`. */
export type PinClosureHost = {
  getRow(sessionId: string, key: string): PinRow | null;
  toPin(row: PinRow): Pin;
  countOpen(sessionId: string): number;
};

/**
 * The closure writes and the follow service's reads (#6456). Every write is one
 * statement or one `.immediate()` transaction, so a deferred read-then-write
 * never meets SQLITE_BUSY without waiting (#3631).
 */
export class PinClosureStore {
  constructor(
    private readonly db: Database,
    private readonly host: PinClosureHost
  ) {}

  /**
   * R1: close an open pin because its ask was settled elsewhere. ONE statement
   * sets the status, the closure, `updated_at` and the deadline clear, so a crash
   * can never leave a `withdrawn` pin with no reason. No answer is recorded.
   * Refused (no change) once the operator has reopened the pin (R8), and on
   * anything but an `open` pin. Null for an absent key.
   */
  supersede(
    sessionId: string,
    key: string,
    closure: PinClosure,
    now: number = Date.now()
  ): { pin: Pin; changed: boolean } | null {
    if (!this.host.getRow(sessionId, key)) return null;
    const changed = this.supersedeRow(sessionId, key, closure, now);
    return {
      pin: this.host.toPin(this.host.getRow(sessionId, key) as PinRow),
      changed,
    };
  }

  /** `supersede`'s statement; true when a row changed. */
  private supersedeRow(
    sessionId: string,
    key: string,
    closure: PinClosure,
    now: number
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE session_pins
         SET status = 'withdrawn', closure_json = ?, updated_at = ?, deadline_at = NULL
         WHERE session_id = ? AND key = ? AND status = 'open' AND reopened_at IS NULL`
      )
      .run(JSON.stringify(closure), now, sessionId, key);
    return result.changes > 0;
  }

  /**
   * R9: supersede each open, non-reserved pin of `sessionId` whose pin ID
   * `content.repeats` names, as replaced by `newPinId`. Only an exact pin ID: no
   * title or option match ever closes a pin. A Detected pin it names is linked by
   * the service instead, and another session's pin is followed, never closed here.
   * `PinStore.upsert` calls this inside the create's own transaction.
   */
  replace(
    sessionId: string,
    content: PinContent,
    newPinId: string,
    now: number
  ): Pin[] {
    const replaced: Pin[] = [];
    for (const pinId of content.repeats ?? []) {
      const row = this.db
        .prepare(
          `SELECT * FROM session_pins
           WHERE pin_id = ? AND session_id = ? AND status = 'open'
             AND reopened_at IS NULL`
        )
        .get(pinId, sessionId) as PinRow | null;
      if (!row || row.key === content.key || isReservedPinKey(row.key)) {
        continue;
      }
      const closure: PinClosure = {
        how: "superseded",
        by: "agent",
        rule: "replaced",
        at: new Date(now).toISOString(),
        bySession: sessionId,
        ref: newPinId,
      };
      if (this.supersedeRow(sessionId, row.key, closure, now)) {
        replaced.push(
          this.host.toPin(this.host.getRow(sessionId, row.key) as PinRow)
        );
      }
    }
    return replaced;
  }

  /**
   * R8: the operator reopens a superseded pin. Only a pin whose closure still
   * counts; it is open again, `reopened_at` is set and never cleared (so no later
   * supersede, retire, ruling or Detected cap closes it), and the closure stays
   * for its history. The open cap holds. An automatic pick is not re-armed: the
   * supersede cleared it, and only the operator or a re-raise by the agent sets
   * one again.
   */
  reopen(
    sessionId: string,
    key: string,
    now: number = Date.now()
  ):
    | { pin: Pin; changed: true }
    | { capped: "open" }
    | { refused: "not_superseded" }
    | null {
    const run = this.db.transaction(() => {
      const row = this.host.getRow(sessionId, key);
      if (!row) return null;
      if (!rowClosure(row)) return { refused: "not_superseded" as const };
      if (this.host.countOpen(sessionId) >= PIN_MAX_OPEN_PER_SESSION) {
        return { capped: "open" as const };
      }
      this.db
        .prepare(
          `UPDATE session_pins SET status = 'open', reopened_at = ?, updated_at = ?
           WHERE session_id = ? AND key = ? AND status = 'withdrawn'
             AND reopened_at IS NULL`
        )
        .run(now, now, sessionId, key);
      return {
        pin: this.host.toPin(this.host.getRow(sessionId, key) as PinRow),
        changed: true as const,
      };
    });
    return run.immediate();
  }

  /** A Detected pin's stored codes and links; null for an absent key. */
  getDetectedState(sessionId: string, key: string): PinDetectedState | null {
    const row = this.db
      .prepare(
        "SELECT detected_json FROM session_pins WHERE session_id = ? AND key = ?"
      )
      .get(sessionId, key) as { detected_json: string | null } | null;
    return row ? parseDetected(row.detected_json) : null;
  }

  /**
   * R4: record links on an open Detected pin. A pin ID already linked keeps its
   * first link; at most {@link PIN_DETECTED_LINKS_MAX}. Leaves the pin open and
   * its revision, content and `updated_at` alone: a link changes nothing the
   * operator sees. True when it recorded a new link.
   */
  addDetectedLinks(
    sessionId: string,
    key: string,
    links: readonly PinDetectedLink[]
  ): boolean {
    if (!key.startsWith(DETECTED_KEY_PREFIX) || links.length === 0) {
      return false;
    }
    const run = this.db.transaction((): boolean => {
      const row = this.db
        .prepare(
          `SELECT status, detected_json FROM session_pins
           WHERE session_id = ? AND key = ?`
        )
        .get(sessionId, key) as {
        status: PinStatus;
        detected_json: string | null;
      } | null;
      if (!row || row.status !== "open") return false;
      const state = parseDetected(row.detected_json);
      const known = new Set(state.links.map(link => link.pinId));
      let added = false;
      for (const link of links) {
        if (known.has(link.pinId)) continue;
        if (state.links.length >= PIN_DETECTED_LINKS_MAX) break;
        state.links.push({ pinId: link.pinId, by: link.by, at: link.at });
        known.add(link.pinId);
        added = true;
      }
      if (!added) return false;
      this.db
        .prepare(
          `UPDATE session_pins SET detected_json = ?
           WHERE session_id = ? AND key = ? AND status = 'open'`
        )
        .run(JSON.stringify(state), sessionId, key);
      return true;
    });
    return run.immediate();
  }

  /**
   * A session's open Detected pins that hold codes or links, with what the
   * follow service decides on. Served by `idx_session_pins_detected`.
   */
  listOpenDetected(sessionId: string): OpenDetectedPin[] {
    const rows = this.db
      .prepare(
        `SELECT key, pin_id, created_at, starred, reopened_at, answers_json,
                detected_json
         FROM session_pins
         WHERE session_id = ? AND status = 'open' AND detected_json IS NOT NULL`
      )
      .all(sessionId) as Array<
      Pick<
        PinRow,
        | "key"
        | "pin_id"
        | "created_at"
        | "starred"
        | "reopened_at"
        | "answers_json"
        | "detected_json"
      >
    >;
    return rows
      .filter(row => row.key.startsWith(DETECTED_KEY_PREFIX))
      .map(row => ({
        key: row.key,
        pinId: row.pin_id ?? null,
        createdAt: row.created_at,
        starred: row.starred === 1,
        reopened: row.reopened_at !== null && row.reopened_at !== undefined,
        operatorAnswered: (JSON.parse(row.answers_json) as PinAnswer[]).some(
          answer => answer.by === "operator"
        ),
        state: parseDetected(row.detected_json),
      }));
  }

  /**
   * R5: open pins of sessions other than `excludeSessionId` whose `repeats` names
   * one of `pinIds`, the copies a closed original closes. Served by
   * `idx_session_pins_repeats`; the caller checks each copy's namespace.
   */
  listOpenCopiesNaming(
    pinIds: readonly string[],
    excludeSessionId: string
  ): Array<{ sessionId: string; key: string }> {
    if (pinIds.length === 0) return [];
    const marks = pinIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT session_id, key FROM session_pins
         WHERE status = 'open' AND repeats_json IS NOT NULL AND session_id != ?
           AND EXISTS (
             SELECT 1 FROM json_each(session_pins.repeats_json)
             WHERE json_each.value IN (${marks})
           )
         ORDER BY session_id, key`
      )
      .all(excludeSessionId, ...pinIds) as Array<{
      session_id: string;
      key: string;
    }>;
    return rows.map(row => ({ sessionId: row.session_id, key: row.key }));
  }

  /**
   * R9: the pin IDs of a session's pins that `pinId` replaced: closed as
   * superseded, rule `replaced`, naming it. Never one the operator reopened.
   */
  listReplacedBy(sessionId: string, pinId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT pin_id FROM session_pins
         WHERE session_id = ? AND status = 'withdrawn' AND reopened_at IS NULL
           AND closure_json IS NOT NULL
           AND json_extract(closure_json, '$.rule') = 'replaced'
           AND json_extract(closure_json, '$.ref') = ?`
      )
      .all(sessionId, pinId) as Array<{ pin_id: string | null }>;
    return rows
      .map(row => row.pin_id)
      .filter((id): id is string => typeof id === "string");
  }

  /**
   * A page of open pins that carry `repeats`, after `after` in (session, key)
   * order, for the follow loop. Served by `idx_session_pins_repeats`.
   */
  listOpenWithRepeats(
    after: { sessionId: string; key: string } | null,
    limit: number
  ): Array<{ sessionId: string; key: string }> {
    const rows = (
      after
        ? this.db
            .prepare(
              `SELECT session_id, key FROM session_pins
               WHERE status = 'open' AND repeats_json IS NOT NULL
                 AND (session_id > ? OR (session_id = ? AND key > ?))
               ORDER BY session_id, key LIMIT ?`
            )
            .all(after.sessionId, after.sessionId, after.key, limit)
        : this.db
            .prepare(
              `SELECT session_id, key FROM session_pins
               WHERE status = 'open' AND repeats_json IS NOT NULL
               ORDER BY session_id, key LIMIT ?`
            )
            .all(limit)
    ) as Array<{ session_id: string; key: string }>;
    return rows.map(row => ({ sessionId: row.session_id, key: row.key }));
  }

  /** The sessions with an open Detected pin that holds codes or links. */
  listSessionsWithOpenDetected(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM session_pins
         WHERE status = 'open' AND detected_json IS NOT NULL`
      )
      .all() as Array<{ session_id: string }>;
    return rows.map(row => row.session_id);
  }
}
