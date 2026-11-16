// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runner identity: the shared names (issue #6647).
 *
 * A runner is the process that runs a session. It mints a runner id per attach
 * (a random UUID, held in memory, never in the environment) and sends it in the
 * attach request and its socket handshake. The hub stores, compares and logs
 * only a key derived from it. That derivation lives in the hub alone, because
 * the web client imports this package and a hash import does not belong in its
 * bundle. This module holds names and types only.
 */

/** The identity layer's three modes; `observe` is the default (R9). */
export const RUNNER_IDENTITY_MODES = ["off", "observe", "enforce"] as const;
export type RunnerIdentityMode = (typeof RUNNER_IDENTITY_MODES)[number];

/** The 409 error code of an attach the hub refuses (R3). */
export const RUNNER_REFUSED = "runner-refused";

/** The code of a refused handshake and of the stop sent to a replaced runner (R6, R8). */
export const RUNNER_SUPERSEDED = "runner-superseded";

/** The socket event that tells a replaced runner to stop (R8). */
export const RUNNER_SUPERSEDED_EVENT = "runner-superseded";

/** Why an attach was refused: the session has a live runner, or none now. */
export const RUNNER_REFUSAL_REASONS = [
  "runner-present",
  "session-exists",
] as const;
export type RunnerRefusalReason = (typeof RUNNER_REFUSAL_REASONS)[number];

/** What a runner sends about itself when it attaches (R1). */
export type RunnerAttachInfo = { id: string; pid?: number };

/** The runner part of the attach body, `POST /cli/sessions` (R1). */
export type RunnerAttachBody = { runner?: RunnerAttachInfo };

/**
 * How often a runner reports `session-alive`: the keep-alive timer of
 * `cli/src/agent/sessionBase.ts`. The hub derives its replaced-and-still-
 * reporting window from it (#6647 D2); a server test pins the two together.
 */
export const RUNNER_REPORT_INTERVAL_MS = 2_000;

/** Each of a session's two key lists (replaced, refused) keeps at most this many keys (R2). */
export const MAX_RUNNER_KEYS_PER_LIST = 16;
