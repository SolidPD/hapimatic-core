// SPDX-License-Identifier: AGPL-3.0-only
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  answerOnRecord,
  isReservedPinKey,
  PIN_DEADLINE_MAX_AHEAD_MS,
  PIN_DEADLINE_MIN_LEAD_MS,
  PIN_REQUEST_MAX_BYTES,
  pinSaveSources,
  type Pin,
  type PinDeadlineRequest,
} from "@hapi/protocol";
import type { z } from "zod";

import type { ErrorLogger } from "../../logging/errorLogger";
import type { PinDeadlineRefusal } from "../../store/pinStore";
import { ensurePinFolder, savePinFiles } from "../../sync/pinFiles";
import type {
  PinAnswerResult,
  PinService,
  PinUpsertResult,
  PinDismissRefusal,
  PinWriteResult,
} from "../../sync/pinService";
import { neutralizePinText, type PinByIdOutcome } from "../../sync/pinById";
import type { PinSubmissionOutcome } from "../../sync/pinSubmission";
import type { MessageOrigin } from "../../sync/sentFrom";
import { limitRequestBody } from "../../utils/limitRequestBody";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  CALLER_SESSION_HEADER,
  resolveCallerSession,
  type CallerSessionLookup,
} from "./agentEscalation";
import { logAndJson } from "./routeErrorHelper";
import type { ProxyResult } from "./sessionMutationHandlers";

/**
 * What the three pin route surfaces share (issue #6447): the JWT routes, the
 * CLI-token routes, and the federation receivers. Each keeps its literal
 * `app.METHOD(path, cataloged(...), gate, handler)`, because the catalog generator
 * and the lint rule read route sites, so only what happens inside a handler is here.
 */

/**
 * The archive response (#6454): `{ ok: true }`, plus `openPinCount` when the
 * Pins gate is open and the session has open pins it asked, which stay
 * answerable after the archive. The server's mirrored `prompt:` and `detected:`
 * pins are not counted: a prompt pin is withdrawn when its session stops.
 */
export function archiveResponseBody(
  pins: { countOpenAgentPins(sessionId: string): number },
  sessionId: string,
  pinsEnabled: boolean
): { ok: true; openPinCount?: number } {
  if (!pinsEnabled) return { ok: true };
  try {
    const openPinCount = pins.countOpenAgentPins(sessionId);
    return openPinCount > 0 ? { ok: true, openPinCount } : { ok: true };
  } catch {
    // The archive already happened; a count the store cannot read is left out.
    return { ok: true };
  }
}

const PEER_ARCHIVE_BODY_TIMEOUT_MS = 2_000;

/**
 * A peer's archive answer body, read for its count only: bounded and
 * fail-open, because the archive itself already succeeded (#6454).
 */
export async function readPeerArchiveBody(resp: Response): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resp.json().catch(() => null),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), PEER_ARCHIVE_BODY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The `openPinCount` a peer's archive answer carries, when it is a positive count. */
export function peerArchiveOpenPinCount(body: unknown): number | undefined {
  const count = (body as { openPinCount?: unknown } | null)?.openPinCount;
  return typeof count === "number" && Number.isInteger(count) && count > 0
    ? count
    : undefined;
}

/** A pin's path below `/sessions/:id` on a peer. The key charset needs no encoding; this is a defense. */
export function pinPath(key: string, suffix = ""): string {
  return `/pins/${encodeURIComponent(key)}${suffix}`;
}

/**
 * True when the peer has no pin routes to serve. An older binary never answers 404
 * for a route it lacks: the request falls through to its JWT middleware, which
 * answers 401 `Invalid token` (nodeRegistry.ts, #4461 K13). A closed gate answers a
 * non-JSON 404, which the proxy words as `Remote node returned 404`. A JSON
 * `Session not found` from the peer is neither, and stays as it is.
 */
export function isPeerWithoutPins(
  result: Extract<ProxyResult, { type: "error" }>
): boolean {
  return isPeerMissingRoute(result) || isPeerGateClosed(result);
}

/** The peer has no such route: an older binary (#6453 splits the two cases). */
function isPeerMissingRoute(
  result: Extract<ProxyResult, { type: "error" }>
): boolean {
  return result.status === 401 && result.message === "Invalid token";
}

/** The peer's Pins gate is closed. */
function isPeerGateClosed(
  result: Extract<ProxyResult, { type: "error" }>
): boolean {
  return result.status === 404 && result.message === "Remote node returned 404";
}

/**
 * #6453: the answer for a peer that has pin routes but predates pin files, so the
 * operator is told to upgrade that node rather than that it lacks Pins entirely.
 * Only for the 401 case (the route is absent): a closed gate keeps its own answer.
 */
export const PIN_FILES_MISSING_ROUTE = {
  error: "That node runs an older Hapimatic without pin files",
  code: "peer_without_pin_files",
} as const;

/**
 * Map a proxy result to the caller's response, never relaying a 401, because the
 * web client treats any 401 as an expired login and shows "Session expired". A
 * string `code` keeps the availability guard from relabeling these (#5375).
 */
export function proxiedPinResponse<T>(
  c: Context,
  result: ProxyResult,
  schema: z.ZodType<T>,
  onData?: (data: T) => void,
  /** The 501 for a peer without this route (#6453); default: "no pins". */
  missingRoute?: { error: string; code: string }
): Response {
  if (result.type === "not-found") {
    return c.json({ error: "Session not found" }, 404);
  }
  if (result.type === "error") {
    if (missingRoute && isPeerMissingRoute(result)) {
      return c.json({ ...missingRoute }, 501);
    }
    if (isPeerWithoutPins(result)) {
      return c.json(
        {
          error: "The session's node does not support pins yet",
          code: "peer_unsupported",
        },
        501
      );
    }
    if (result.status === 401) {
      return c.json(
        {
          error: "The session's node refused this node's federation token",
          code: "peer_unauthorized",
        },
        502
      );
    }
    // The proxy keeps only the body, so restore the retry hint a peer's busy
    // store sent, as a local write would carry it.
    if (result.code === "pin_store_busy") c.header("Retry-After", "1");
    return c.json(
      {
        error: result.message,
        ...(result.code ? { code: result.code } : {}),
      },
      result.status as ContentfulStatusCode
    );
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    return c.json(
      {
        error: "The session's node returned an unexpected pin response",
        code: "peer_bad_response",
      },
      502
    );
  }
  onData?.(parsed.data);
  return c.json(parsed.data as Record<string, unknown>);
}

/**
 * Read a write request's JSON, refusing it past the limit before it is parsed,
 * because nothing else bounds a request before Zod sees it (Bun allows 220 MB). An
 * empty body reads as `null`, since a proxy sends a JSON content type even with none.
 * A Submit (#6450) carries many pins' answers, so it passes its own, larger cap.
 */
export async function readPinBody(
  c: Context,
  maxBytes: number = PIN_REQUEST_MAX_BYTES
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const limited = limitRequestBody(c.req.raw, maxBytes);
  let text: string;
  try {
    text = await limited.request.text();
  } catch {
    if (limited.overLimit()) {
      return {
        ok: false,
        response: c.json(
          {
            error: `The request is over the ${maxBytes}-byte limit`,
            code: "pin_request_too_large",
          },
          413
        ),
      };
    }
    return {
      ok: false,
      response: c.json({ error: "Could not read the request body" }, 400),
    };
  }
  if (text.trim() === "") return { ok: true, body: null };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: c.json({ error: "The body is not valid JSON" }, 400),
    };
  }
}

function describeClosedPin(pin: Pin): string {
  // The settling answer, not the newest: a later moot entry must never read as
  // what the operator decided, and this text is all an agent gets through a proxy.
  // Only an answered pin quotes one, and only an answer to its current revision:
  // a pin answered, re-opened and then dismissed has no answer on record. The
  // agent tools quote through the same `answerOnRecord` (#6448).
  const settled = answerOnRecord(pin);
  const answer = settled
    ? ` Answer on record: ${[settled.option, settled.label ?? settled.text].filter(Boolean).join(". ")}.`
    : "";
  return `Pin "${pin.key}" is already ${pin.status}, so it was not changed.${answer} Pass reopen: true to ask again.`;
}

function pinNotFound(c: Context): Response {
  return c.json({ error: "Pin not found" }, 404);
}

/** The one mapping of a post or update's outcome, shared by both surfaces that write. */
export function pinUpsertResponse(
  c: Context,
  result: PinUpsertResult
): Response {
  if ("missing" in result) return pinNotFound(c);
  if ("capped" in result) {
    return c.json(
      {
        error:
          result.capped === "open"
            ? "This session has too many open pins. Withdraw or resolve some first."
            : "This session has too many pins, and none can be evicted.",
        code: "pin_cap_reached",
      },
      409
    );
  }
  if ("closed" in result) {
    // The statement goes in `error`, because a proxy keeps only `error` and `code`.
    return c.json(
      {
        error: describeClosedPin(result.closed),
        code: "pin_closed",
        pin: result.closed,
        openPinCount: result.openPinCount,
      },
      409
    );
  }
  return c.json(result);
}

export function pinWriteResponse(
  c: Context,
  result: PinWriteResult | PinDismissRefusal | null
): Response {
  if (!result) return pinNotFound(c);
  // #6455: the operator cannot dismiss a prompt the agent is still blocked on.
  if ("refused" in result) {
    return c.json(
      {
        error:
          "This pin mirrors a prompt that is still waiting; answer the prompt itself",
        code: result.refused,
      },
      409
    );
  }
  return c.json(result);
}

/** What the pin-file operations need of a local session (#6453). */
export type PinFileSession = {
  id: string;
  namespace: string;
  metadata?: { path?: string | null } | null;
};

/**
 * #6453 `pin_folder`: create the pin's folder in the session's folder and name it.
 * The one implementation behind the CLI route and its federation receiver. The
 * caller has validated the key; the pin need not exist yet.
 */
export async function pinFolderResponse(
  c: Context,
  session: PinFileSession,
  key: string
): Promise<Response> {
  const made = await ensurePinFolder(session.metadata?.path, session.id, key);
  if (!made.ok) {
    return c.json(
      {
        error: `The pin's folder could not be made: ${made.error}`,
        code:
          made.code === "folder_missing"
            ? "folder_missing"
            : "pin_folder_refused",
      },
      409
    );
  }
  return c.json({ folder: made.folder, savedFolder: made.savedFolder });
}

/**
 * #6453 "Save to session folder": copy the pin's own files into
 * `GeneratedFiles/pins/<folder>/` and record the save. The one implementation
 * behind the JWT route and its federation receiver. Paths come from the stored
 * pin's key, never from the URL.
 */
export async function pinSaveResponse(
  c: Context,
  pins: PinService,
  session: PinFileSession,
  key: string
): Promise<Response> {
  const found = pins.get(session.id, key);
  if (!found) return pinNotFound(c);
  const { pin } = found;
  const sources = pinSaveSources(session.id, pin.evidence ?? []);
  if (sources.folders.length === 0 && sources.files.length === 0) {
    return c.json(
      {
        error: "This pin has no files in the session's folder to save",
        code: "nothing_to_save",
      },
      409
    );
  }
  const saved = await savePinFiles(
    session.metadata?.path,
    session.id,
    pin.key,
    sources
  );
  if (!saved.ok) {
    return c.json(
      { error: saved.error, code: saved.code },
      saved.code === "over_limit"
        ? 413
        : saved.code === "write_failed"
          ? 500
          : 409
    );
  }
  const written = pins.markSaved(
    { id: session.id, namespace: session.namespace },
    pin.key,
    { savedTo: saved.savedTo, revision: pin.revision }
  );
  if (!written) return pinNotFound(c);
  return c.json({
    ...written,
    savedTo: saved.savedTo,
    copied: saved.copied,
    kept: saved.kept,
    skipped: saved.skipped,
    ...(saved.skippedMore ? { skippedMore: saved.skippedMore } : {}),
  });
}

export function pinAnswerResponse(
  c: Context,
  result: PinAnswerResult | null
): Response {
  if (!result) return pinNotFound(c);
  if ("unknownOption" in result) {
    return c.json(
      {
        error: `This pin has no option "${result.unknownOption}"`,
        code: "pin_unknown_option",
      },
      400
    );
  }
  return c.json(result);
}

/**
 * Run a handler, turning a lost write lock into a retryable 503 rather than a 500:
 * a write can still time out on `busy_timeout` after waiting (#3631).
 */
export async function withPinErrors(
  c: Context,
  errorLogger: ErrorLogger | null | undefined,
  category: string,
  run: () => Response | Promise<Response>
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) {
      c.header("Retry-After", "1");
      return c.json(
        { error: "The database is busy", code: "pin_store_busy" },
        503
      );
    }
    return logAndJson(c, error, 500, {
      errorLogger: errorLogger ?? null,
      category,
      fallbackMessage: "The pin request failed",
      severity: "error",
    });
  }
}

/**
 * Refuse an agent's `withdraw` or `resolve` of a server-owned pin, because a pin
 * the server raised about a session is not that session's to close. Null otherwise.
 */
export function refuseReservedPinKey(c: Context, key: string): Response | null {
  if (!isReservedPinKey(key)) return null;
  return c.json(
    {
      error: `Pin "${key}" belongs to the server, so an agent cannot withdraw or resolve it`,
      code: "pin_reserved_key",
    },
    403
  );
}

/**
 * Refuse an operator-only pin action when the caller is the session the pin
 * belongs to, because an agent must not dismiss a Detected pin about itself. A
 * floor rather than a boundary: an agent with a shell can omit the header. It stops
 * the typed tools, which stamp it, and it is the same floor `refuseSelfPermission`
 * sets for a permission answer.
 */
export function refuseSelfPinAction(
  c: Context,
  engine: CallerSessionLookup | null
): Response | null {
  const callerId = c.req.header(CALLER_SESSION_HEADER);
  if (!callerId) return null;
  const targetId = c.req.param("id");
  const isSelf =
    callerId === targetId || resolveCallerSession(c, engine)?.id === targetId;
  if (!isSelf) return null;
  return c.json(
    {
      error: "A session cannot take this action on its own pins",
      code: "self_pin_action_refused",
    },
    403
  );
}

/**
 * The owner-only write floor on the CLI pin write routes (#6574, ruling D4, part
 * of Matt's SEC1): when `X-Hapi-Session-Id` names a session other than the target,
 * by its server id or its tag, refuse with 403 `pin_not_owned`, so a pin ID read
 * from another session can never be turned into a write on that session's pins.
 * The typed tools and the Stop hook stamp their own session's server id on their
 * own session, so they pass. A caller sending its Claude session id in the header
 * would be refused (no current caller does). Like the F5 floors it binds only a
 * caller that sends the header; the missing server-side enforcement is L #6458's.
 */
export function refuseForeignPinWrite(
  c: Context,
  target: { id: string; tag: string | null } | null
): Response | null {
  const header = c.req.header(CALLER_SESSION_HEADER);
  if (!header || !target) return null;
  if (header === target.id || (target.tag !== null && header === target.tag)) {
    return null;
  }
  return c.json(
    { error: "A session can change only its own pins", code: "pin_not_owned" },
    403
  );
}

/**
 * Refuse a pin-answers Submit from any session's agent (#6450), whichever session it
 * names, because only the operator records operator answers: a PM can mint a JWT
 * from its CLI token, and `refuseSelfPinAction` covers only a session's own pins. A
 * floor rather than a boundary, like the other caller-header refusals.
 */
export function refuseAgentPinAnswers(c: Context): Response | null {
  if (!c.req.header(CALLER_SESSION_HEADER)) return null;
  return c.json(
    {
      error: "A session cannot submit pin answers; only the operator can",
      code: "agent_pin_answers_refused",
    },
    403
  );
}

/**
 * Refuse an automatic-pick change from any session's agent (#6452), because only
 * the operator moves or stops a pick: a session can mint a JWT from its CLI token,
 * and without this an agent could move its own pick to a minute from now. A floor
 * rather than a boundary, like `refuseAgentPinAnswers`.
 */
export function refuseAgentPinDeadline(c: Context): Response | null {
  if (!c.req.header(CALLER_SESSION_HEADER)) return null;
  return c.json(
    {
      error: "A session cannot change an automatic pick; only the operator can",
      code: "agent_pin_deadline_refused",
    },
    403
  );
}

/**
 * Why a requested automatic-pick time cannot be set, or null (#6452). Checked on
 * the node that receives the request and again on the node that owns the pin.
 */
export function pinDeadlineRangeError(
  request: PinDeadlineRequest,
  now: number
): string | null {
  if ("off" in request) return null;
  const at = Date.parse(request.at);
  // The schema already requires an ISO instant; NaN would pass both checks.
  if (!Number.isFinite(at)) return "That is not a date and time";
  if (at < now + PIN_DEADLINE_MIN_LEAD_MS) {
    return "An automatic pick must be at least a minute from now";
  }
  if (at > now + PIN_DEADLINE_MAX_AHEAD_MS) {
    return "An automatic pick must be within a year from now";
  }
  return null;
}

/** The request as the store takes it: an instant in milliseconds, or off. */
export function pinDeadlineInput(
  request: PinDeadlineRequest
): { at: number } | { off: true } {
  return "off" in request ? { off: true } : { at: Date.parse(request.at) };
}

/** A deadline write as a response: a closed pin or one with no pick is a 409. */
export function pinDeadlineResponse(
  c: Context,
  result: PinWriteResult | { refused: PinDeadlineRefusal } | null
): Response {
  if (result && "refused" in result) {
    return c.json(
      result.refused === "not_open"
        ? { error: "This pin is no longer open", code: "pin_not_open" }
        : {
            error: "This pin has no automatic pick",
            code: "pin_no_automatic_pick",
          },
      409
    );
  }
  return pinWriteResponse(c, result);
}

/** A Submit's outcome as a response; a refusal keeps each entry's reason. */
export function pinSubmissionResponse(
  c: Context,
  outcome: PinSubmissionOutcome
): Response {
  if (outcome.ok) return c.json(outcome.response);
  return c.json(
    { error: outcome.error, code: outcome.code, entries: outcome.entries },
    outcome.status
  );
}

/**
 * The origin a hub forwarded with a proxied Submit, classed `federation` on the
 * owning node with the original uid or session id, as `sessionData.ts` does for a
 * federated send. Absent when the hub sent none.
 */
export function forwardedOrigin(value: unknown): MessageOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fwd = value as { uid?: unknown; sessionId?: unknown };
  return {
    class: "federation",
    uid: typeof fwd.uid === "number" ? fwd.uid : undefined,
    sessionId: typeof fwd.sessionId === "string" ? fwd.sessionId : undefined,
  };
}

// ── Reads by pin ID (#6574) ───────────────────────────────────────────────

/** Every by-ID read in a namespace counts here, whatever header it sends. */
export const PIN_BY_ID_NAMESPACE_LIMIT = 120;
/** A session that names itself in `X-Hapi-Session-Id` also counts here. */
export const PIN_BY_ID_SESSION_LIMIT = 30;
/** Seconds a 503 asks the caller to wait before trying again. */
const PIN_BY_ID_RETRY_AFTER_SECONDS = 5;

/**
 * The two stacked rate limits of a by-ID read, because a miss costs one request
 * per peer node. Every request counts against the namespace bucket; a request whose
 * `X-Hapi-Session-Id` resolves to a known session in the namespace also counts
 * against that session's bucket, so one looping agent cannot spend the namespace's
 * budget alone. An absent or unknown header lands in the namespace bucket only, so
 * rotating the header buys nothing. Each call builds fresh buckets (server/CLAUDE.md
 * "Rate Limiting").
 */
export function pinByIdLimiters(
  name: string,
  getEngine: () => CallerSessionLookup | null
): [MiddlewareHandler<WebAppEnv>, MiddlewareHandler<WebAppEnv>] {
  const namespaceLimiter = createRateLimiter({
    name: `${name}-namespace`,
    limit: PIN_BY_ID_NAMESPACE_LIMIT,
    keyFn: c => (c.get("namespace") ?? "anonymous") as string,
  });
  const sessionLimiter = createRateLimiter({
    name: `${name}-session`,
    limit: PIN_BY_ID_SESSION_LIMIT,
    keyFn: c =>
      `${c.get("namespace")}:${resolveCallerSession(c, getEngine())?.id ?? ""}`,
  });
  const perSession: MiddlewareHandler<WebAppEnv> = async (c, next) => {
    if (!resolveCallerSession(c, getEngine())) return next();
    return sessionLimiter(c, next);
  };
  return [namespaceLimiter, perSession];
}

/** The 400 for a path segment that is not a pin ID in any form a paste carries. */
export function invalidPinIdResponse(c: Context): Response {
  return c.json({ error: "That is not a pin ID", code: "invalid_pin_id" }, 400);
}

function offlineSentence(notAsked: readonly { nodeLabel: string }[]): string {
  const labels = notAsked.map(node => node.nodeLabel);
  return labels.length === 1
    ? `${labels[0]} is offline`
    : `${labels.join(", ")} are offline`;
}

/**
 * The answer of a by-ID read, shared by the JWT and CLI routes. Every hit's pin has
 * its approval tokens blanked (SEC1). A miss answers one body for an absent ID,
 * another namespace's pin and a deleted pin (ruling D3); it names the nodes the
 * registry knows are offline, which were not asked (ruling DA). Only transient
 * trouble answers 503.
 */
export function pinByIdResponse(c: Context, outcome: PinByIdOutcome): Response {
  switch (outcome.kind) {
    case "found":
      return c.json({
        pin: neutralizePinText(outcome.pin),
        openPinCount: outcome.openPinCount,
        timeZone: outcome.timeZone,
        session: outcome.session,
      });
    case "not_found":
      return c.json(
        {
          error:
            outcome.notAsked.length === 0
              ? "No pin has that ID"
              : `No pin has that ID on the nodes that answered; ${offlineSentence(outcome.notAsked)}`,
          code: "pin_not_found",
          notAsked: outcome.notAsked,
        },
        404
      );
    case "incomplete":
      c.header("Retry-After", String(PIN_BY_ID_RETRY_AFTER_SECONDS));
      return c.json(
        {
          error: "Some nodes could not be asked; try again",
          code: "pin_lookup_incomplete",
          nodes: outcome.nodes,
        },
        503
      );
    case "ambiguous":
      return c.json(
        {
          error: "More than one pin has that ID; open it from its session",
          code: "pin_id_ambiguous",
          matches: outcome.matches,
        },
        409
      );
  }
}
