// SPDX-License-Identifier: AGPL-3.0-only
import { receiveForwardedOrigin } from "../../sync/callerOrigin";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  answerOnRecord,
  countedClosure,
  isReservedPinKey,
  PIN_CLOSURE_REASON_MAX_CHARS,
  PIN_DEADLINE_MAX_AHEAD_MS,
  PIN_DEADLINE_MIN_LEAD_MS,
  PIN_REQUEST_MAX_BYTES,
  pinSaveSources,
  pinSessionDir,
  type Pin,
  type PinClosure,
  type PinDeadlineRequest,
  type PinRetireRequest,
  type PinRuleRequest,
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
import { capPinText, cleanPinText } from "../../sync/pinText";
import type { PinSubmissionOutcome } from "../../sync/pinSubmission";
import { isOperatorUserMessage, type MessageOrigin } from "../../sync/sentFrom";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import { limitRequestBody } from "../../utils/limitRequestBody";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  CALLER_SESSION_HEADER,
  resolveCallerSession,
  resolveRemoteCaller,
  type CallerSessionLookup,
  type FederationLookup,
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

/** One peer-bad-response line at most this often (#6458 Task 11h). */
export const PEER_BAD_RESPONSE_LOG_EVERY_MS = 60_000;

/** When each kind last logged: reads and writes apart (#6458 review). */
const peerBadResponseLoggedAt = {
  read: Number.NEGATIVE_INFINITY,
  write: Number.NEGATIVE_INFINITY,
};

/**
 * #6458 Task 11h (#6487 SF-1): a peer's pin response that fails this hub's
 * schema is answered 502, but on a write the peer may already have applied it,
 * so the operator's retry can double it. Say so in the log, at most once a
 * minute for reads and once a minute for writes, because a version-skewed peer
 * fails every read poll and would otherwise hide the write line. Only the issue
 * paths and codes are logged, never the issue messages or the body, which can
 * quote pin text.
 */
function logPeerBadResponse(
  method: string,
  path: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>,
  now: number = Date.now()
): void {
  const write = method !== "GET" && method !== "HEAD";
  const kind = write ? "write" : "read";
  if (now - peerBadResponseLoggedAt[kind] < PEER_BAD_RESPONSE_LOG_EVERY_MS) {
    return;
  }
  peerBadResponseLoggedAt[kind] = now;
  const shape = issues
    .slice(0, 3)
    .map(
      issue => `${issue.path.map(String).join(".") || "(root)"}:${issue.code}`
    )
    .join(", ");
  console.warn(
    `[pins] ${method} ${path}: the session's node answered a pin response this hub cannot read (${shape}); answered 502 peer_bad_response${write ? ", but the write may already be applied on that node" : ""}. Is that node on an older or newer version?`
  );
}

/** Tests: forget when the last peer-bad-response lines were written. */
export function __resetPeerBadResponseLog(): void {
  peerBadResponseLoggedAt.read = Number.NEGATIVE_INFINITY;
  peerBadResponseLoggedAt.write = Number.NEGATIVE_INFINITY;
}

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
    logPeerBadResponse(c.req.method, c.req.path, parsed.error.issues);
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

/** #6803: how much of a settling answer a closed pin's refusal quotes. */
const CLOSED_PIN_QUOTE_MAX_CHARS = 200;

function describeClosedPin(pin: Pin): string {
  // The settling answer, not the newest: a later moot entry must never read as
  // what the operator decided, and this text is all an agent gets through a proxy.
  // Only an answered pin quotes one, and only an answer to its current revision:
  // a pin answered, re-opened and then dismissed has no answer on record. The
  // agent tools quote through the same `answerOnRecord` (#6448).
  // #6803: a write-in can be 2,048 characters with line breaks, and `pin_get`
  // holds the whole, so the quote is cut (pinFenceIngest.ts cuts its own).
  // #6456 (R2): a superseded pin names the pin that settled it; only changed
  // content raises it again, so the text never offers `reopen: true` for it.
  const by = supersededBy(pin);
  if (by) {
    return `Pin "${pin.key}" was closed as superseded by ${by}, which settled its ask elsewhere, so it was not changed. Read ${by} for the decision; post changed content only to ask something new.`;
  }
  const settled = answerOnRecord(pin);
  // #6456 (R7): a Project Manager's ruling is quoted as the PM's, never the operator's.
  const label =
    settled?.via === "pm"
      ? "The Project Manager's ruling on record"
      : "Answer on record";
  const answer = settled
    ? ` ${label}: ${capPinText([settled.option, settled.label ?? settled.text].filter(Boolean).join(". "), CLOSED_PIN_QUOTE_MAX_CHARS)}.`
    : "";
  return `Pin "${pin.key}" is already ${pin.status}, so it was not changed.${answer} Pass reopen: true to ask again.`;
}

function pinNotFound(c: Context): Response {
  return c.json({ error: "Pin not found" }, 404);
}

/**
 * #6456: up to 3 open Detected pins of a session, newest first, by ID and title,
 * so an agent's post can name one in `repeats`: the newest is the one its last
 * message made (PR-2, 05b08046). Reads no JSON for the keys, three rows at most.
 */
export function openDetectedSummary(
  pins: Pick<PinService, "listKeysByPrefix" | "get">,
  sessionId: string,
  exceptKey?: string
): Array<{ pinId: string; title: string }> {
  const out: Array<{ pinId: string; title: string }> = [];
  // The store lists oldest first.
  const keys = pins.listKeysByPrefix(sessionId, "detected:", "open").reverse();
  for (const key of keys) {
    if (out.length >= 3) break;
    if (key === exceptKey) continue;
    const pin = pins.get(sessionId, key)?.pin;
    if (pin?.pinId) {
      out.push({ pinId: pin.pinId, title: capPinText(pin.title, 200) });
    }
  }
  return out;
}

/** The one mapping of a post or update's outcome, shared by both surfaces that write. */
export function pinUpsertResponse(
  c: Context,
  result: PinUpsertResult,
  /** #6456: extra fields for a successful write's answer (`detectedOpen`). */
  extra?: (written: { pin: Pin }) => Record<string, unknown>
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
  return c.json(extra ? { ...result, ...extra(result) } : result);
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
    // #6540 S-2: an all-skipped refusal carries its list. It is local only: the
    // app reads the `error` text, which names the first entry and its reason, and
    // a hub's proxy keeps only `error` and `code` for a session on another node.
    return c.json(
      {
        error: saved.error,
        code: saved.code,
        ...(saved.skipped ? { skipped: saved.skipped } : {}),
        ...(saved.skippedMore ? { skippedMore: saved.skippedMore } : {}),
      },
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
    {
      savedTo: saved.savedTo,
      revision: pin.revision,
      // #6458 (#6540 S-4): so the Save button can say a save was partial.
      files: saved.copied.length + saved.kept.length,
      skipped: saved.skipped.length + (saved.skippedMore ?? 0),
      // #6540 S-4: which files, relative to the session's folder (the form
      // `pin_folder` gave the agent); the store keeps up to ten.
      skippedFiles: saved.skipped.map(s => ({
        path: `${pinSessionDir(session.id)}/${s.path}`,
        reason: s.reason,
      })),
    }
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
 * #6456 (R8): refuse a star or an unstar from any session's agent, because only
 * the operator stars a pin, and an agent that could unstar a pin could then
 * retire it. Checked before any proxy. A floor, like `refuseAgentPinAnswers`.
 */
export function refuseAgentPinStar(c: Context): Response | null {
  if (!c.req.header(CALLER_SESSION_HEADER)) return null;
  return c.json(
    {
      error: "A session cannot star or unstar a pin; only the operator can",
      code: "agent_pin_star_refused",
    },
    403
  );
}

/** #6456 (R8): refuse a reopen from any session's agent; only the operator reopens. */
export function refuseAgentPinReopen(c: Context): Response | null {
  if (!c.req.header(CALLER_SESSION_HEADER)) return null;
  return c.json(
    {
      error: "A session cannot reopen a pin; only the operator can",
      code: "agent_pin_reopen_refused",
    },
    403
  );
}

/** #6456: the 501 for a peer that predates retire, rulings and reopen. */
export const PIN_SUPERSEDE_MISSING_ROUTE = {
  error:
    "That node runs an older Hapimatic that cannot retire, rule on, or reopen a pin",
  code: "peer_without_pin_supersede",
} as const;

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
 * federated send. Absent when the hub sent none. #6715 (R3): the hub's verdict is
 * kept as `via`, `browser` only at the `pins-submit` door.
 */
export function forwardedOrigin(value: unknown): MessageOrigin | undefined {
  return receiveForwardedOrigin(value, "pins-submit");
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
        // #6969 (D2): the owning node's, absent when an older peer sent none.
        ...(outcome.noteMaxChars !== undefined
          ? { noteMaxChars: outcome.noteMaxChars }
          : {}),
        session: outcome.session,
      });
    case "not_found":
      // A spoke's miss (#6458 Task 11i): still `pin_not_found`, so an older
      // client reads a miss, with `localOnly` for the ones that can say more. No
      // `Retry-After`: a retry on a spoke cannot search more.
      if (outcome.localOnly) {
        return c.json(
          {
            error:
              "No pin has that ID on this node, which cannot search the other nodes",
            code: "pin_not_found",
            notAsked: [],
            localOnly: true,
          },
          404
        );
      }
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

// #6456: a pin decided elsewhere goes away. The retire route (R6, Matt's FL1)
// and a Project Manager's ruling (R7, Matt's FR1), shared by the CLI routes and
// their federation receivers. Who a caller is rests on `X-Hapi-Session-Id`, a
// floor and not a boundary (FLOOR1): a session that omits or forges the header
// is FLOOR1's recorded limit, and #6633 is the root fix. "Its PM" is the
// target's own stamp (`parentRelationship: "spawn"` naming the caller), never
// `managesSession`, whose dashboards any session can post; the stamp is a
// recorded floor too, because any session holding the CLI token can set a
// session's parent link (`PUT /cli/sessions/:id/parent`, ER2).

/** The caller's session as the hub resolved it, forwarded to the owning node. */
export const PIN_CALLER_SESSION_HEADER = "X-Hapi-Caller-Session";
/** That session's name, URI-encoded, for the closure's and the ruling's record. */
export const PIN_CALLER_NAME_HEADER = "X-Hapi-Caller-Name";

/** The caller of a retire or a ruling: always a session id, never a tag. */
export type PinCaller = { id: string; name: string | null };

/** A refused retire, ruling or reopen, with its status and code. */
export type PinActionRefusal = {
  refused: true;
  /** 503 only for a lookup the server could not finish; it carries `Retry-After`. */
  status: 403 | 404 | 409 | 503;
  code: string;
  error: string;
};

function refuseAction(
  status: PinActionRefusal["status"],
  code: string,
  error: string
): PinActionRefusal {
  return { refused: true, status, code, error };
}

/**
 * A pin the operator's Submit (or an automatic pick) is delivering an answer to
 * right now: a retire or ruling then would make that answer moot (409, retry).
 */
function answerInFlight(
  pins: Pick<PinService, "claimedBy">,
  sessionId: string,
  key: string
): PinActionRefusal | null {
  return pins.claimedBy(sessionId, key)
    ? refuseAction(
        409,
        "pin_answer_in_flight",
        "An answer to this pin is being delivered now; read the pin again in a moment"
      )
    : null;
}

export function pinActionRefusalResponse(
  c: Context,
  refusal: PinActionRefusal
): Response {
  if (refusal.status === 503) {
    c.header("Retry-After", String(PIN_BY_ID_RETRY_AFTER_SECONDS));
  }
  return c.json({ error: refusal.error, code: refusal.code }, refusal.status);
}

/**
 * The caller from `X-Hapi-Session-Id`: the local session in the request's
 * namespace, by id then tag, else the federation cache's (`resolveRemoteCaller`).
 * Null when the header is absent or names no session. A local id in another
 * namespace stays unresolved and is never re-read remotely.
 */
export function resolvePinCaller(
  c: Context,
  engine: CallerSessionLookup | null,
  registry: FederationLookup | null
): PinCaller | null {
  const header = c.req.header(CALLER_SESSION_HEADER);
  if (!header) return null;
  const local = resolveCallerSession(c, engine);
  if (local) return { id: local.id, name: local.metadata?.name ?? null };
  if (engine?.getSession(header)) return null;
  const remote = resolveRemoteCaller(header, registry);
  if (!remote) return null;
  const summary = registry?.locateSession(remote.id)?.session;
  return { id: remote.id, name: summary?.metadata?.name ?? null };
}

/**
 * The headers a hub sends the owning node: only what it resolved itself, so an
 * inbound `X-Hapi-Caller-Session` from a client never reaches the owner.
 */
export function pinCallerHeaders(caller: PinCaller): Record<string, string> {
  return {
    [PIN_CALLER_SESSION_HEADER]: caller.id,
    ...(caller.name
      ? {
          [PIN_CALLER_NAME_HEADER]: encodeURIComponent(
            caller.name.slice(0, 200)
          ),
        }
      : {}),
  };
}

/** The owning node's read of the caller its hub forwarded, or null. */
export function forwardedPinCaller(c: Context): PinCaller | null {
  const id = c.req.header(PIN_CALLER_SESSION_HEADER);
  if (!id || id.length > 200) return null;
  const raw = c.req.header(PIN_CALLER_NAME_HEADER);
  let name: string | null = null;
  if (raw) {
    try {
      name = decodeURIComponent(raw).slice(0, 200);
    } catch {
      name = null;
    }
  }
  return { id, name };
}

/** Whether `caller` is the session that started `session` (its stamp). */
function isStartingPm(session: Session, caller: PinCaller): boolean {
  return (
    session.parentRelationship === "spawn" &&
    typeof session.parentSessionId === "string" &&
    session.parentSessionId === caller.id
  );
}

/** A pin the operator starred, wrote on, or reopened: his alone. */
function operatorHeld(pin: Pin): boolean {
  return (
    pin.starred ||
    Boolean(pin.reopenedAt) ||
    pin.answers.some(answer => answer.by === "operator")
  );
}

/**
 * A stored message the operator typed in the web app (R4, the Pins PM's
 * stricter reading): an operator message whose door and evidence both read
 * `browser`, on its own origin or, forwarded, on the origin's `via`. A Pins
 * Submit (`pins-submit`), a shell send (`unattributed`), a capability-invoker
 * send, a Telegram or terminal message, and a row with no origin are none.
 */
export function isTypedInWebApp(content: unknown): boolean {
  if (!isOperatorUserMessage(content)) return false;
  const meta = (content as { meta?: { origin?: unknown } }).meta;
  const origin = meta?.origin as
    | {
        door?: unknown;
        evidence?: unknown;
        via?: { door?: unknown; evidence?: unknown };
      }
    | undefined;
  if (!origin || typeof origin !== "object") return false;
  if (origin.door === "browser" && origin.evidence === "browser") return true;
  const via = origin.via;
  return (
    !!via &&
    typeof via === "object" &&
    via.door === "browser" &&
    via.evidence === "browser"
  );
}

/** What a retire reads of this node. */
export type PinRetireEngine = Pick<
  SyncEngine,
  "pins" | "pinFollow" | "getRecentMessagesBounded"
>;

/** The stored messages a typed-message proof reads, newest first. */
const RETIRE_PROOF_MESSAGE_WINDOW = 200;

/** Why `retireProof` found no proof: the status, code and sentence of the refusal. */
type RetireProofMiss = {
  status: 403 | 409 | 503;
  code: string;
  why: string;
};

/**
 * The own-session proof (FL1, "the build ties the proof to this pin"), or why
 * there is none. (1) `ref`: a closed pin, read by ID in this namespace, settled
 * after this pin was made by the operator's answer or dismissal or a Project
 * Manager's ruling, that belongs to this session or lists this pin in `repeats`.
 * An automatic pick, a dismissal with no entry, and a `prompt:` pin are no proof.
 * The server cannot check that two texts ask the same thing; the named pin and
 * the agent's reason are stored and shown beside Reopen. (2) No `ref`: a message
 * the operator typed in the web app in this session after this pin was made.
 *
 * A miss says what was read (PR-2): a `ref` the federation could not read for
 * certain (a node offline, an incomplete lookup) is retryable, not "not found";
 * one more than one node holds is ambiguous; and the typed-message read, which
 * holds the newest `RETIRE_PROOF_MESSAGE_WINDOW` rows, says so when they were
 * all newer than this pin.
 */
async function retireProof(
  engine: PinRetireEngine,
  session: Session,
  detected: Pin,
  ref: string | undefined
): Promise<RetireProofMiss | null> {
  const made = Date.parse(detected.createdAt);
  const noProof = (why: string): RetireProofMiss => ({
    status: 403,
    code: "pin_retire_no_proof",
    why,
  });
  if (ref) {
    const read = await engine.pinFollow.lookupById(ref, session.namespace);
    if (read.kind === "missing") return noProof(`${ref} was not found`);
    if (read.kind === "local_only") {
      return noProof(
        `${ref} is not on this node, which cannot search the other nodes`
      );
    }
    if (read.kind === "unread") {
      if (read.reason === "ambiguous") {
        return {
          status: 409,
          code: "pin_id_ambiguous",
          why: `more than one node holds a pin with the ID ${ref}, so it cannot stand as proof`,
        };
      }
      return {
        status: 503,
        code: "pin_lookup_incomplete",
        why:
          read.reason === "offline" && read.nodes.length > 0
            ? `${ref} could not be read: ${offlineSentence(read.nodes.map(nodeLabel => ({ nodeLabel })))}, so it was not searched; try again`
            : `${ref} could not be read: some nodes could not be asked; try again`,
      };
    }
    const named = read.pin;
    if (named.key.startsWith("prompt:")) {
      return noProof(`${ref} mirrors a prompt, which is no proof`);
    }
    if (named.status === "open" || named.status === "live") {
      return noProof(`${ref} is still open`);
    }
    const belongs =
      named.sessionId === detected.sessionId ||
      (!!detected.pinId && (named.repeats ?? []).includes(detected.pinId));
    if (!belongs) {
      return noProof(
        `${ref} is neither this session's nor lists this pin in repeats`
      );
    }
    const settled = named.answers.some(
      answer =>
        !answer.moot &&
        Date.parse(answer.at) > made &&
        ((answer.by === "operator" &&
          (answer.resolves || answer.dismissed === true)) ||
          (answer.via === "pm" && answer.resolves))
    );
    return settled
      ? null
      : noProof(
          `${ref} was not settled by the operator or a Project Manager's ruling after this pin was made`
        );
  }
  const rows = engine.getRecentMessagesBounded(session.id, {
    limit: RETIRE_PROOF_MESSAGE_WINDOW,
    sinceMs: made,
    maxChars: 64 * 1024,
  });
  const typed = rows.some(
    row =>
      row.createdAt > made &&
      row.content !== null &&
      isTypedInWebApp(row.content)
  );
  if (typed) return null;
  // The read holds the session's newest rows; when all of them are newer than
  // this pin, older ones since it was made were not read (d7d282fb).
  return noProof(
    rows.length >= RETIRE_PROOF_MESSAGE_WINDOW
      ? `no message the operator typed in the web app among this session's newest ${RETIRE_PROOF_MESSAGE_WINDOW} messages; older ones since this pin was made are not read, so name a settled pin as ref instead`
      : "no message the operator typed in the web app since this pin was made"
  );
}

/**
 * #6456 (R6, Matt's FL1): retire an open Detected pin as superseded, never as
 * his answer. The PM that started the session may, with a reason; the session
 * itself only with proof (`retireProof`). Refused: any key but `detected:`
 * (403 `pin_reserved_key`), a pin not open (409), and a pin the operator
 * starred, wrote on or reopened (409 `pin_operator_held`). The reason passes
 * `cleanPinText`, so no approval token is kept. Runs on the node that owns the
 * session, which checks its own stamp.
 */
export async function retireDetectedPin(input: {
  engine: PinRetireEngine;
  session: Session;
  key: string;
  request: PinRetireRequest;
  caller: PinCaller;
  now?: number;
}): Promise<PinWriteResult | PinActionRefusal> {
  const { engine, session, key, request, caller } = input;
  if (!key.startsWith("detected:")) {
    return refuseAction(
      403,
      "pin_reserved_key",
      "Only a Detected pin can be retired"
    );
  }
  const pin = engine.pins.get(session.id, key)?.pin;
  if (!pin) return refuseAction(404, "pin_not_found", "Pin not found");
  if (pin.status !== "open") {
    return refuseAction(409, "pin_not_open", `Pin "${key}" is not open`);
  }
  if (operatorHeld(pin)) {
    return refuseAction(
      409,
      "pin_operator_held",
      "The operator starred, wrote on, or reopened this pin, so only the operator can close it"
    );
  }
  const inFlight = answerInFlight(engine.pins, session.id, key);
  if (inFlight) return inFlight;
  const pm = isStartingPm(session, caller);
  if (!pm) {
    if (caller.id !== session.id) {
      return refuseAction(
        403,
        "pin_retire_refused",
        "Only the Project Manager that started this session, or the session itself with proof, can retire this pin"
      );
    }
    const missing = await retireProof(engine, session, pin, request.ref);
    if (missing) {
      return refuseAction(
        missing.status,
        missing.code,
        `This session can retire its own Detected pin only with proof: ${missing.why}`
      );
    }
    // The proof read can wait on another node (a `ref` held there), and the
    // operator may star, write on or submit this pin meanwhile: check again.
    const now = engine.pins.get(session.id, key)?.pin;
    if (!now || now.status !== "open") {
      return refuseAction(409, "pin_not_open", `Pin "${key}" is not open`);
    }
    if (operatorHeld(now)) {
      return refuseAction(
        409,
        "pin_operator_held",
        "The operator starred, wrote on, or reopened this pin, so only the operator can close it"
      );
    }
    const busy = answerInFlight(engine.pins, session.id, key);
    if (busy) return busy;
  }
  const reason = capPinText(
    cleanPinText(request.reason).trim(),
    PIN_CLOSURE_REASON_MAX_CHARS
  );
  const closure: PinClosure = {
    how: "superseded",
    by: "agent",
    rule: "retired",
    at: new Date(input.now ?? Date.now()).toISOString(),
    bySession: caller.id,
    ...(caller.name ? { byName: caller.name } : {}),
    ...(request.ref ? { ref: request.ref } : {}),
    ...(reason ? { reason } : {}),
  };
  const written = engine.pins.supersede(
    { id: session.id, namespace: session.namespace },
    key,
    closure,
    input.now
  );
  if (!written) return refuseAction(404, "pin_not_found", "Pin not found");
  return written;
}

/**
 * #6456 (R7, Matt's FR1): the PM that started a lane records its ruling on the
 * lane's own open pin, at the revision it read. Recorded `by: "agent"`,
 * `via: "pm"`, with the PM's session and name, so it reads as the Project
 * Manager's and never as the operator's. Refused: a server-owned key, a caller
 * that is not the lane's starting PM, a pin the operator reopened, a pin not
 * open, and another revision (409). The route sends the lane no message; its
 * result says whether the lane is running, so the PM can tell it.
 */
export function rulePin(input: {
  engine: Pick<SyncEngine, "pins">;
  session: Session;
  key: string;
  request: PinRuleRequest;
  caller: PinCaller;
  now?: number;
}): (PinAnswerResult & { laneRunning: boolean }) | PinActionRefusal {
  const { engine, session, key, request, caller } = input;
  if (isReservedPinKey(key)) {
    return refuseAction(
      403,
      "pin_reserved_key",
      `Pin "${key}" belongs to the server, so a Project Manager cannot rule on it`
    );
  }
  if (!isStartingPm(session, caller)) {
    return refuseAction(
      403,
      "pin_rule_refused",
      "Only the Project Manager that started this session can rule on its pins"
    );
  }
  const pin = engine.pins.get(session.id, key)?.pin;
  if (!pin) return refuseAction(404, "pin_not_found", "Pin not found");
  if (pin.reopenedAt) {
    return refuseAction(
      409,
      "pin_operator_held",
      "The operator reopened this pin, so only the operator can answer it"
    );
  }
  if (pin.status !== "open") {
    return refuseAction(409, "pin_not_open", `Pin "${key}" is not open`);
  }
  if (pin.revision !== request.revision) {
    return refuseAction(
      409,
      "pin_revision_stale",
      `Pin "${key}" is at revision ${pin.revision}, not ${request.revision}: read it again before ruling`
    );
  }
  const inFlight = answerInFlight(engine.pins, session.id, key);
  if (inFlight) return inFlight;
  const result = engine.pins.answer(
    { id: session.id, namespace: session.namespace },
    key,
    {
      revision: request.revision,
      ...(request.option !== undefined ? { option: request.option } : {}),
      ...(request.text !== undefined
        ? { text: cleanPinText(request.text) }
        : {}),
      ...(request.note !== undefined
        ? { note: cleanPinText(request.note) }
        : {}),
      by: "agent",
      via: "pm",
      bySession: caller.id,
      ...(caller.name ? { byName: caller.name } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    }
  );
  if (!result) return refuseAction(404, "pin_not_found", "Pin not found");
  return { ...result, laneRunning: session.active };
}

/**
 * #6456 (R8): the operator reopens a superseded pin. Refused for a pin that is
 * not superseded (409 `pin_not_superseded`) and at the open cap (409).
 */
export function reopenPin(
  pins: Pick<PinService, "reopen">,
  session: { id: string; namespace: string },
  key: string
): PinWriteResult | PinActionRefusal {
  const result = pins.reopen(session, key);
  if (!result) return refuseAction(404, "pin_not_found", "Pin not found");
  if ("refused" in result) {
    return refuseAction(
      409,
      "pin_not_superseded",
      "Only a pin closed as superseded can be reopened"
    );
  }
  if ("capped" in result) {
    return refuseAction(
      409,
      "pin_cap_reached",
      "This session has too many open pins to reopen this one"
    );
  }
  return result;
}

/** The answer to a retire, ruling or reopen: the result, or its refusal. */
export function pinActionResponse(
  c: Context,
  result:
    | PinWriteResult
    | (PinAnswerResult & { laneRunning: boolean })
    | PinActionRefusal
): Response {
  if ("refused" in result && result.refused === true) {
    return pinActionRefusalResponse(c, result);
  }
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

/** #6456: a superseded pin's closure, for the closed-pin texts. */
export function supersededBy(pin: Pin): string | null {
  const closure = countedClosure(pin);
  if (!closure) return null;
  return closure.ref ?? "a pin settled elsewhere";
}
