// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import {
  RUNNER_REFUSED,
  RUNNER_SUPERSEDED,
  type RunnerRefusalReason,
} from "@hapi/protocol";

import type { RunnerRecord } from "../store/sessions";

/**
 * Runner identity's pure rules (issue #6647): the runner key, the attach,
 * handshake and report decisions, and why a live process is unidentified. No
 * state, socket, timer or store handle lives here. Moved unchanged from
 * `runnerIdentity.ts`, which re-exports them (the Project Manager's ruling of
 * 01:00Z on 2026-11-15 on its 1,500-line cap). PR2 (Task 12) adds the shapes
 * of its actions: the 409 refusal with its two texts, the stop's payload and
 * the socket a cut acts on.
 */

/** The first 16 hex characters of the SHA-256 of a runner id (R2). */
export function runnerKeyOf(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export type AttachDecision =
  | "create"
  | "same-runner"
  | "first-runner"
  | "takeover"
  | "refuse";

export type HandshakeDecision = "accept" | "accept-unknown" | "refuse";

export type ReportDecision = "pass" | "drop";

export type GatedReportKind =
  | "session-alive"
  | "update-state"
  | "update-metadata"
  | "session-end";

export type AttachNewcomer = {
  key: string | null;
  startedBy: string | null | undefined;
  tagExists: boolean;
};

const hasRecord = (record: RunnerRecord | null): record is RunnerRecord =>
  record !== null && record.attachedAt !== null;

/** The attach table of the plan's Task 4 (rows 1-8). Pure. */
export function decideAttach(
  record: RunnerRecord | null,
  newcomer: AttachNewcomer
): AttachDecision {
  if (!newcomer.tagExists) return "create";
  // Two missing ids are never equal: same-runner needs the same non-empty key.
  const sameKey =
    newcomer.key !== null &&
    hasRecord(record) &&
    record.runnerKey === newcomer.key;
  if (sameKey) return "same-runner";
  if (newcomer.startedBy !== "daemon") return "refuse";
  return hasRecord(record) ? "takeover" : "first-runner";
}

/** The handshake test of R6 (ruling STRICT-ID). Pure. */
export function decideHandshake(
  record: RunnerRecord | null,
  socketKey: string | null
): HandshakeDecision {
  const listed =
    socketKey !== null &&
    record !== null &&
    (record.supersededKeys.includes(socketKey) ||
      record.refusedKeys.includes(socketKey));
  if (listed) return "refuse";
  if (!hasRecord(record) || record.runnerKey === null) return "accept";
  if (socketKey === null) return "refuse";
  return socketKey === record.runnerKey ? "accept" : "accept-unknown";
}

/** The per-event backstop of R7. Pure. */
export function decideReport(
  record: RunnerRecord | null,
  socket: { sessionId: string | null; runnerKey: string | null },
  sid: string
): ReportDecision {
  if (socket.sessionId !== sid) return "drop";
  return decideHandshake(record, socket.runnerKey) === "refuse"
    ? "drop"
    : "pass";
}

/** What the registry needs of a socket: its id and `data` (no socket map). */
export type RunnerSocketLike = {
  id: string;
  data: {
    namespace?: string;
    sessionId?: string;
    runnerKey?: string;
    evicted?: boolean;
    /** F1: the runner's auth declared it reads `runner-superseded` (a PR2 binary). */
    readsStop?: boolean;
  };
};

/**
 * Task 9: the first reason a session's live process cannot be named as its
 * current identified runner, or null when every live process is named. A
 * session with no connected socket that is not active has no live process.
 * `socket-other-id` needs an identified record to differ from, so a keyed
 * socket on a session with no record (or an unidentified one) reads
 * `no-record` (or `unidentified-record`).
 */
export function unidentifiedReason(
  sockets: RunnerSocketLike[],
  record: RunnerRecord | null,
  active: boolean,
  writePending: boolean
): UnidentifiedReason | null {
  if (sockets.some(s => !s.data.runnerKey)) return "socket-no-id";
  const recorded = record?.runnerKey ?? null;
  if (recorded !== null && sockets.some(s => s.data.runnerKey !== recorded)) {
    return "socket-other-id";
  }
  const live = active || sockets.length > 0;
  // §7: no record is a row whose `runner_attached_at` is NULL.
  if (live && (record?.attachedAt ?? null) === null) return "no-record";
  if (live && recorded === null) return "unidentified-record";
  if (writePending) return "record-write-pending";
  return null;
}

/** Why a live process cannot be named as the session's identified runner. */
export type UnidentifiedReason =
  | "socket-no-id"
  | "socket-other-id"
  | "no-record"
  | "unidentified-record"
  | "record-write-pending";

/** The three moments of R5 at which a socket is cut off. */
export type CutReason =
  | "takeover"
  | "recorded-runner-connected"
  | "report-dropped";

/** What the `runner-superseded` event tells a replaced runner (R8; TY8). */
export type RunnerSupersededPayload = {
  code: typeof RUNNER_SUPERSEDED;
  sessionId: string;
  why: CutReason;
};

/** Why a session is listed in `replacedStillReporting` (Q9). */
export type ReplacedReportReason = "replaced-key" | "refused-key" | "no-key";

/** The 409 body of a refused attach (R3, plan §4.3; TY9). */
export type RunnerRefusedBody = {
  error: typeof RUNNER_REFUSED;
  reason: RunnerRefusalReason;
  sessionId: string;
  message: string;
};

/** The two refusal texts of plan §4.3; the session's name, or its id. */
export function runnerRefusalMessage(
  reason: RunnerRefusalReason,
  name: string
): string {
  return reason === "runner-present"
    ? `This shell belongs to session ${name}, which already has a runner. \`hapi\` does not attach to a running session from a shell.`
    : `This shell's HAPI_SESSION_ID names session ${name}, which has no runner now. \`hapi\` does not attach to an existing session from a shell. Reconnect it from the app.`;
}

/**
 * R3 (Task 12): the engine throws this for an attach `enforce` refused, before
 * the session cache attaches; the attach route answers it with 409.
 */
export class RunnerAttachRefusedError extends Error {
  readonly body: RunnerRefusedBody;

  constructor(
    reason: RunnerRefusalReason,
    sessionId: string,
    name: string | null
  ) {
    const message = runnerRefusalMessage(reason, name || sessionId);
    super(message);
    this.name = "RunnerAttachRefusedError";
    this.body = { error: RUNNER_REFUSED, reason, sessionId, message };
  }
}

/** R6: the handshake refusal; socket.io sends `data` in the client's `connect_error`. */
export function runnerSupersededError(): Error & {
  data: { code: typeof RUNNER_SUPERSEDED };
} {
  const data: { code: typeof RUNNER_SUPERSEDED } = { code: RUNNER_SUPERSEDED };
  return Object.assign(new Error(RUNNER_SUPERSEDED), { data });
}

/** A socket a cut acts on: socket.io's own, looked up by id (K12). */
export type CuttableSocket = {
  data: RunnerSocketLike["data"];
  emit(event: string, payload: RunnerSupersededPayload): unknown;
  disconnect(close: boolean): unknown;
};

/**
 * Sockets reconnect during the first two minutes after a start (§8.4): the
 * route's `cond1Readable` and `wasCutOff`'s window (Task 12a, OR12).
 */
export const COND1_READABLE_AFTER_SECONDS = 120;

export { hasRecord };
