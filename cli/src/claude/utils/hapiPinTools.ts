// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The pin tools on the hapi MCP server (issue #6448, epic #6446): `pin_post`,
 * `pin_update`, `pin_withdraw`, `pin_get`, `pin_resolve` and `pin_folder` (#6453),
 * the way every agent posts and reads pins. `startHappyServer` registers them only while the server
 * reports the Pins gate open.
 *
 * Each tool calls Sub-Issue A's CLI routes (`/cli/sessions/:id/pins…`) with the
 * session's own CLI token as the bearer. Those routes refuse a JWT, so this does
 * not reuse the capability tools' `authedFetch`; and `hapi_call` cannot carry
 * them, because its invoker refuses unpromoted mutating routes. Every request
 * carries a timeout, because a mutating proxy to a peer node has none (#3627).
 *
 * ## Never a silent success (brief F4)
 * A result is a success only for a 2xx whose body matches the expected response
 * and whose outcome is what the tool asked for. Three 2xx answers are not: an
 * identical re-post of a closed pin answers 200 with the closed status, a
 * withdraw that arrives after the operator answered answers 200 with the answer,
 * and a resolve against another revision answers 200 with `moot: true`. Each
 * comes back as an error carrying what the agent needs to act on. Every error
 * says what happened, and whether the write was saved, so the agent reports it
 * instead of waiting for an answer.
 *
 * ## Validation
 * The input schemas are A's own (`PinContentObjectSchema`, `PinKeySchema`, the
 * resolve fields), so the MCP SDK advertises the real constraints and refuses a
 * structural error naming the field. The cross-field rules are not re-run here:
 * the server enforces them, and a session can run an older binary than its
 * server, so a local copy would refuse what a newer server accepts.
 */
import { z } from "zod";
import {
  answerOnRecord,
  PIN_MAX_OPEN_PER_SESSION,
  PIN_STATUSES,
  PinContentObjectSchema,
  PinGetResponseSchema,
  PinKeySchema,
  PinListResponseSchema,
  PinMutationResponseSchema,
  PinFolderResponseSchema,
  PinResolveRequestSchema,
  PinSchema,
  trimTrailingChars,
  type Pin,
  type PinAnswer,
  type PinMutationResponse,
} from "@hapi/protocol";
import type { CapabilityToolDeps, FetchLike } from "./startHappyServer";

/** Per-request budget. A mutating proxy to a peer node has no timeout of its own. */
export const PIN_TOOL_TIMEOUT_MS = 15_000;

/**
 * `pin_get`'s list budget, cut at a pin boundary: about 8,000 tokens, well under
 * Claude Code's MCP output cap. A typical full pin is 2.5 KB, and a worst case
 * is bounded by the 64 KiB request limit plus 8 KiB of answers, so the list
 * leaves the long fields out and `pin_get` with a key returns one pin in full.
 */
export const PIN_LIST_BUDGET_BYTES = 32 * 1024;

/** Kept back from the budget for the list's envelope and its note. */
const LIST_ENVELOPE_RESERVE_BYTES = 512;

/** A post or update that failed: the question has to reach the operator another way. */
const NOT_SAVED =
  "The pin was NOT saved. Tell the user, and ask in the chat instead.";
const NOT_WITHDRAWN = "The pin was NOT withdrawn. Tell the user.";
const NOT_RESOLVED = "The decision was NOT recorded on the pin. Tell the user.";
const NOT_READ = "The pins could NOT be read. Tell the user.";
/** #6453: a folder is made the same way twice, so a failure is a plain one. */
const NOT_MADE =
  "The pin's folder was NOT made. Tell the user, and put the pin's files under GeneratedFiles/ instead.";
const FOLDER_NOTE =
  "Write the pin's files in folder and list each as evidence by its path (folder + the file name). A file you will keep building on goes in savedFolder instead; commit it.";
/**
 * A write that timed out may still land: the server can accept the request and
 * answer after the deadline (seen with a stalled server on a worktree
 * instance). A 2xx body the tool cannot read is the same: the server most
 * likely committed. Neither may send the agent to ask the same question in the
 * chat.
 */
const WRITE_UNKNOWN =
  "The server's answer did not arrive in time or could not be read, so this may or may not have been saved. Do not ask in the chat yet: check with pin_get once the server answers, then repeat the call if it is missing. Tell the user if it stays unreachable.";
const ANSWERED_GUIDANCE =
  "The operator already answered this pin. Act on that answer; do not ask again. Pass reopen: true only to ask a new question.";
const LIST_NOTE =
  "Each pin is listed without its long fields (context, rationale, plainText, evidence, steps). Call pin_get with its key for the full pin.";

const CLOSED_STATUSES = new Set(["answered", "auto-answered", "dismissed"]);

export const pinPostInputSchema = PinContentObjectSchema.extend({
  reopen: z
    .boolean()
    .optional()
    .describe(
      "Ask again on a pin the operator already answered or dismissed. Only for a new question."
    ),
});
export type PinPostInput = z.infer<typeof pinPostInputSchema>;

export const pinWithdrawInputSchema = z.strictObject({ key: PinKeySchema });
export type PinWithdrawInput = z.infer<typeof pinWithdrawInputSchema>;

/** #6453: the key of the pin whose files the agent is about to write. */
export const pinFolderInputSchema = z.strictObject({ key: PinKeySchema });
export type PinFolderInput = z.infer<typeof pinFolderInputSchema>;

export const pinResolveInputSchema = z.strictObject({
  key: PinKeySchema,
  ...PinResolveRequestSchema.shape,
});
export type PinResolveInput = z.infer<typeof pinResolveInputSchema>;

/** `active` (the default) is every open and live pin; `all` is every status. */
export const PIN_GET_STATUSES = ["active", "all", ...PIN_STATUSES] as const;

export const pinGetInputSchema = z.strictObject({
  key: PinKeySchema.optional(),
  status: z.enum(PIN_GET_STATUSES).optional(),
});
export type PinGetInput = z.infer<typeof pinGetInputSchema>;

export type PinToolResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
};

type PinToolSpec = {
  title: string;
  description: string;
  inputSchema: z.ZodType;
};

/** What `startHappyServer` registers for each tool. */
export const PIN_TOOL_SPECS = {
  pin_post: {
    title: "Post Pin",
    description:
      "Pin a decision or steps for the operator to answer in the Pins tab, under a stable key you choose. " +
      "Re-posting the same key updates that pin instead of adding one. The key is flat (letters, digits, . _ : -, no /); " +
      "plainText (the whole pin as plain text), stakes and risk are required; ifUnanswered only on a reversible, low-risk decision or variants pin. " +
      "The server stores the instant it fires as deadlineAt (pin_get with the pin's key shows it; the list without a key does not); the operator may move it or turn it off, and a revision can only move it later. " +
      'An automatic answer arrives as its own message whose summary line starts "Pins automatic pick". ' +
      "A pin already answered or dismissed is not changed unless you pass reopen: true for a new question. " +
      "An error result ends with what to do: it says whether the pin was saved, or that it may have been and to check with pin_get. " +
      "The operator's answers arrive later as one user message: a summary line and a fenced hapi_pin_answers block (schema hapi_pin_answers/1) " +
      "with one entry per pin, giving its key (pin) and the revision answered (rev); an entry whose rev is below the pin's current revision answered an older version. " +
      "Call pin_folder first for any files the pin shows.",
    inputSchema: pinPostInputSchema,
  },
  pin_update: {
    title: "Update Pin",
    description:
      "Replace one of your existing pins in full, by key. Fails if the key does not exist (use pin_post to create one). " +
      "The same rules as pin_post apply.",
    inputSchema: pinPostInputSchema,
  },
  pin_withdraw: {
    title: "Withdraw Pin",
    description:
      "Withdraw one of your pins, by key, when its question no longer applies.",
    inputSchema: pinWithdrawInputSchema,
  },
  pin_get: {
    title: "Read Pins",
    description:
      "Read your pins with their answer history. With a key, the full pin; without one, every open and live pin " +
      "(or status: all, or one status). Use it after a compaction or restart instead of asking the operator again.",
    inputSchema: pinGetInputSchema,
  },
  pin_resolve: {
    title: "Resolve Pin",
    description:
      "Record a decision the operator gave in the chat instead of the Pins tab, so the pin does not go stale: " +
      "an option id, a text, or both. Pass the pin's revision to record it against that revision. " +
      "Not for a hapi_pin_answers message: those answers are already recorded.",
    inputSchema: pinResolveInputSchema,
  },
  pin_folder: {
    title: "Pin Folder",
    description:
      "Get the folder for one pin's files (pages, images, mockups the pin shows), created for you. " +
      "Write them there and list them as evidence; Hapimatic keeps that folder out of git and deletes it with this session, " +
      "so it is the exception to the GeneratedFiles rule for pin files. " +
      "A file you will keep building on (a mockup you are iterating), write in the saved folder this tool also names, " +
      "under GeneratedFiles/pins/, and commit it.",
    inputSchema: pinFolderInputSchema,
  },
} satisfies Record<string, PinToolSpec>;

type HttpOutcome =
  | {
      kind: "response";
      status: number;
      ok: boolean;
      body: unknown;
      retryAfter?: string;
    }
  | { kind: "transport"; error: string; timedOut: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function result(
  payload: Record<string, unknown>,
  isError: boolean,
  line?: string
): PinToolResult {
  const text = JSON.stringify(payload) + (line ? `\n${line}` : "");
  return { content: [{ type: "text", text }], isError };
}

/** The settling answer's fields an agent acts on. */
function answerView(answer: PinAnswer): Record<string, unknown> {
  return {
    revision: answer.revision,
    by: answer.by,
    at: answer.at,
    ...(answer.option !== undefined ? { option: answer.option } : {}),
    ...(answer.label !== undefined ? { label: answer.label } : {}),
    ...(answer.text !== undefined ? { text: answer.text } : {}),
    ...(answer.note !== undefined ? { note: answer.note } : {}),
  };
}

/**
 * A post or update that left the pin closed: a 409 `pin_closed`, or an identical
 * re-post the server answered 200 with the closed status. It quotes an answer
 * only through `answerOnRecord`, the rule the server's 409 text uses, so a pin
 * dismissed after an old answer never reads as decided.
 */
function closedResult(
  key: string,
  httpStatus: number,
  pin: Pin | null,
  serverError?: string
): PinToolResult {
  const answer = pin ? answerOnRecord(pin) : undefined;
  const pinStatus = pin?.status ?? "closed";
  return result(
    {
      ok: false,
      status: httpStatus,
      code: "pin_closed",
      key,
      pinStatus,
      ...(pin ? { revision: pin.revision } : {}),
      error:
        serverError ??
        `Pin "${key}" is already ${pinStatus}, so it was not changed.`,
      ...(answer ? { answer: answerView(answer) } : {}),
    },
    true,
    answer
      ? ANSWERED_GUIDANCE
      : `The pin was not changed: it is already ${pinStatus}. Pass reopen: true to ask again.`
  );
}

/** Map a non-2xx answer to one error result. */
function httpFailure(
  outcome: Extract<HttpOutcome, { kind: "response" }>,
  key: string | undefined,
  line: string,
  missingHint?: string
): PinToolResult {
  const body = asRecord(outcome.body);
  const serverError =
    typeof body?.error === "string" ? body.error : `HTTP ${outcome.status}`;
  if (outcome.status === 409 && body?.code === "pin_closed" && key) {
    const pin = PinSchema.safeParse(body.pin);
    return closedResult(key, 409, pin.success ? pin.data : null, serverError);
  }
  let code: string;
  if (typeof body?.code === "string") code = body.code;
  else if (outcome.status === 400) code = "invalid_pin";
  else if (outcome.status === 401) code = "unauthorized";
  else if (outcome.status === 404) {
    // A closed gate is Hono's plain-text 404, so no JSON body means no Pins here.
    if (body === null) code = "pins_unavailable";
    else
      code = /session/i.test(serverError)
        ? "session_not_found"
        : "pin_not_found";
  } else code = `http_${outcome.status}`;

  let error = serverError;
  if (code === "pins_unavailable") {
    error =
      "Pins is off on this server, or the server predates Pins. A gate change reaches a session only when it restarts.";
  } else if (code === "pin_not_found" && missingHint) {
    error = `${serverError}. ${missingHint}`;
  }
  return result(
    {
      ok: false,
      status: outcome.status,
      code,
      ...(key !== undefined ? { key } : {}),
      error,
      ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}),
    },
    true,
    line
  );
}

/**
 * A request that never got an answer: `failedLine`, or, for a write that timed
 * out, `unknownLine`, because a timed-out write may still land.
 */
function transportFailure(
  outcome: Extract<HttpOutcome, { kind: "transport" }>,
  failedLine: string,
  unknownLine?: string
): PinToolResult {
  const line =
    outcome.timedOut && unknownLine !== undefined ? unknownLine : failedLine;
  return result(
    {
      ok: false,
      error: outcome.error,
      code: "tool_transport_error",
      ...(outcome.timedOut ? { timedOut: true } : {}),
    },
    true,
    line
  );
}

/**
 * A 2xx whose body this tool cannot read. For a write the server has most likely
 * committed, so callers pass the outcome-unknown line, never "NOT saved".
 */
function badResponse(
  outcome: Extract<HttpOutcome, { kind: "response" }>,
  line: string
): PinToolResult {
  return result(
    {
      ok: false,
      status: outcome.status,
      code: "bad_response",
      error: "The server answered with a body this tool does not recognise.",
    },
    true,
    line
  );
}

function inputRefusal(error: z.ZodError, line: string): PinToolResult {
  const issue = error.issues[0];
  return result(
    {
      ok: false,
      code: "invalid_input",
      field: issue?.path.map(String).join(".") || "(input)",
      error: issue?.message ?? "Invalid input",
    },
    true,
    line
  );
}

/** A write's success payload: the pin's state after the write, not the whole pin. */
function writeView(
  pin: Pin,
  openPinCount: number,
  changed: boolean
): Record<string, unknown> {
  return {
    ok: true,
    key: pin.key,
    revision: pin.revision,
    status: pin.status,
    changed,
    openPinCount,
  };
}

/** A list row: what an agent needs to avoid asking again, without the long fields. */
function compactPin(pin: Pin): Record<string, unknown> {
  return {
    key: pin.key,
    kind: pin.kind,
    title: pin.title,
    status: pin.status,
    revision: pin.revision,
    blocking: pin.blocking,
    stakes: pin.stakes,
    risk: pin.risk,
    ...(pin.recommended !== undefined ? { recommended: pin.recommended } : {}),
    ...(pin.options
      ? { options: pin.options.map(({ id, label }) => ({ id, label })) }
      : {}),
    answers: pin.answers,
    updatedAt: pin.updatedAt,
  };
}

/** Factory for the six pin tools. Tests inject `fetchFn`; nothing is mocked. */
export function createPinTools(deps: CapabilityToolDeps) {
  const doFetch: FetchLike = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const base = `${trimTrailingChars(deps.serverUrl, "/")}/cli/sessions/${encodeURIComponent(deps.selfSessionId)}/pins`;
  const pinUrl = (key: string, suffix = ""): string =>
    `${base}/${encodeURIComponent(key)}${suffix}`;

  async function send(
    method: string,
    url: string,
    body?: unknown
  ): Promise<HttpOutcome> {
    try {
      const token = deps.getCliApiToken();
      if (!token) {
        throw new Error(
          "CLI_API_TOKEN is not set, so the Hapimatic server cannot be reached"
        );
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "X-Hapi-Session-Id": deps.selfSessionId,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const resp = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(PIN_TOOL_TIMEOUT_MS),
      });
      let parsed: unknown = null;
      try {
        parsed = await resp.json();
      } catch {
        // A plain-text body (a closed gate's 404) reads as no body, never a throw.
        parsed = null;
      }
      const retryAfter = resp.headers?.get("retry-after") ?? undefined;
      return {
        kind: "response",
        status: resp.status,
        ok: resp.ok,
        body: parsed,
        ...(retryAfter ? { retryAfter } : {}),
      };
    } catch (err) {
      return {
        kind: "transport",
        error: err instanceof Error ? err.message : String(err),
        // `AbortSignal.timeout` rejects with a `TimeoutError` DOMException.
        timedOut:
          (err as { name?: unknown } | null)?.name === "TimeoutError" ||
          (err as { name?: unknown } | null)?.name === "AbortError",
      };
    }
  }

  /**
   * Send one write and map every way it can fail to the tool result. The one
   * place the write-failure rules live (a timeout or an unreadable 2xx body is an
   * unknown outcome, never "NOT saved"), so the write tools cannot drift apart.
   */
  async function sendWrite(
    method: string,
    url: string,
    key: string,
    notSaved: string,
    body?: unknown,
    missingHint?: string
  ): Promise<
    | { ok: true; status: number; data: PinMutationResponse }
    | { ok: false; failure: PinToolResult }
  > {
    const outcome = await send(method, url, body);
    if (outcome.kind === "transport") {
      return {
        ok: false,
        failure: transportFailure(outcome, notSaved, WRITE_UNKNOWN),
      };
    }
    if (!outcome.ok) {
      return {
        ok: false,
        failure: httpFailure(outcome, key, notSaved, missingHint),
      };
    }
    const parsed = PinMutationResponseSchema.safeParse(outcome.body);
    if (!parsed.success) {
      return { ok: false, failure: badResponse(outcome, WRITE_UNKNOWN) };
    }
    return { ok: true, status: outcome.status, data: parsed.data };
  }

  /** `pin_post` and `pin_update`: one PUT, a full replace by key. */
  async function upsert(
    args: unknown,
    mustExist: boolean
  ): Promise<PinToolResult> {
    const parsed = pinPostInputSchema.safeParse(args ?? {});
    if (!parsed.success) return inputRefusal(parsed.error, NOT_SAVED);
    const { key, reopen, ...content } = parsed.data;
    const sent = await sendWrite(
      "PUT",
      pinUrl(key, mustExist ? "?mustExist=1" : ""),
      key,
      NOT_SAVED,
      { ...content, ...(reopen ? { reopen: true } : {}) },
      mustExist
        ? `pin_update only changes an existing pin; "${key}" does not exist. Use pin_post to create it.`
        : undefined
    );
    if (!sent.ok) return sent.failure;
    const { pin, openPinCount, changed } = sent.data;
    if (CLOSED_STATUSES.has(pin.status)) {
      return closedResult(key, sent.status, pin);
    }
    return result(
      {
        ...writeView(pin, openPinCount, changed),
        ...(changed ? {} : { note: "unchanged (same content)" }),
      },
      false
    );
  }

  async function post(args: unknown): Promise<PinToolResult> {
    return upsert(args, false);
  }

  async function update(args: unknown): Promise<PinToolResult> {
    return upsert(args, true);
  }

  async function withdraw(args: unknown): Promise<PinToolResult> {
    const parsed = pinWithdrawInputSchema.safeParse(args ?? {});
    if (!parsed.success) return inputRefusal(parsed.error, NOT_WITHDRAWN);
    const { key } = parsed.data;
    const sent = await sendWrite(
      "POST",
      pinUrl(key, "/withdraw"),
      key,
      NOT_WITHDRAWN
    );
    if (!sent.ok) return sent.failure;
    const { pin, openPinCount, changed } = sent.data;
    // The operator answered before the withdraw arrived: not a success, because
    // the agent must act on that answer rather than treat the question as gone.
    if (
      !changed &&
      (pin.status === "answered" || pin.status === "auto-answered")
    ) {
      return closedResult(key, sent.status, pin);
    }
    const answer = answerOnRecord(pin);
    return result(
      {
        ...writeView(pin, openPinCount, changed),
        ...(changed
          ? {}
          : { note: `the pin was already ${pin.status}; nothing changed` }),
        ...(answer ? { answer: answerView(answer) } : {}),
      },
      false
    );
  }

  async function resolve(args: unknown): Promise<PinToolResult> {
    const parsed = pinResolveInputSchema.safeParse(args ?? {});
    if (!parsed.success) return inputRefusal(parsed.error, NOT_RESOLVED);
    const { key, ...decision } = parsed.data;
    const sent = await sendWrite(
      "POST",
      pinUrl(key, "/resolve"),
      key,
      NOT_RESOLVED,
      decision
    );
    if (!sent.ok) return sent.failure;
    const { pin, openPinCount, changed } = sent.data;
    if (sent.data.moot === true) {
      // Recorded in the history, but it changed nothing (#6447's `moot` rule).
      return result(
        {
          ok: false,
          status: sent.status,
          code: "resolve_moot",
          key,
          pinStatus: pin.status,
          revision: pin.revision,
          error: `The decision was recorded in the pin's history, but the pin did not change: it is ${pin.status} at revision ${pin.revision}.`,
        },
        true,
        "Read the pin again with pin_get before acting on it."
      );
    }
    const answer = answerOnRecord(pin);
    return result(
      {
        ...writeView(pin, openPinCount, changed),
        ...(answer ? { answer: answerView(answer) } : {}),
      },
      false
    );
  }

  /** One list request, parsed. A failure is returned as the tool result. */
  async function listOnce(
    status: string | null
  ): Promise<
    | { ok: true; pins: Pin[]; openPinCount: number; hasMore: boolean }
    | { ok: false; failure: PinToolResult }
  > {
    const query = new URLSearchParams({
      limit: String(PIN_MAX_OPEN_PER_SESSION),
    });
    if (status) query.set("status", status);
    const outcome = await send("GET", `${base}?${query.toString()}`);
    if (outcome.kind === "transport") {
      return { ok: false, failure: transportFailure(outcome, NOT_READ) };
    }
    if (!outcome.ok) {
      return { ok: false, failure: httpFailure(outcome, undefined, NOT_READ) };
    }
    const body = PinListResponseSchema.safeParse(outcome.body);
    if (!body.success) {
      return { ok: false, failure: badResponse(outcome, NOT_READ) };
    }
    return {
      ok: true,
      pins: body.data.pins,
      openPinCount: body.data.openPinCount,
      hasMore: body.data.hasMore,
    };
  }

  async function get(args: unknown): Promise<PinToolResult> {
    const parsed = pinGetInputSchema.safeParse(args ?? {});
    if (!parsed.success) return inputRefusal(parsed.error, NOT_READ);
    const { key, status = "active" } = parsed.data;

    if (key !== undefined) {
      const outcome = await send("GET", pinUrl(key));
      if (outcome.kind === "transport") {
        return transportFailure(outcome, NOT_READ);
      }
      if (!outcome.ok) return httpFailure(outcome, key, NOT_READ);
      const body = PinGetResponseSchema.safeParse(outcome.body);
      if (!body.success) return badResponse(outcome, NOT_READ);
      return result(
        { ok: true, pin: body.data.pin, openPinCount: body.data.openPinCount },
        false
      );
    }

    const statuses =
      status === "active"
        ? ["open", "live"]
        : [status === "all" ? null : status];
    const pins: Pin[] = [];
    let openPinCount = 0;
    let hasMore = false;
    for (const one of statuses) {
      const page = await listOnce(one);
      if (!page.ok) return page.failure;
      pins.push(...page.pins);
      openPinCount = Math.max(openPinCount, page.openPinCount);
      hasMore ||= page.hasMore;
    }

    // The whole result stays under the budget: each row plus the comma before
    // it, and a reserve for the envelope.
    const rowBudget = PIN_LIST_BUDGET_BYTES - LIST_ENVELOPE_RESERVE_BYTES;
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    for (const pin of pins) {
      const row = compactPin(pin);
      const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
      if (bytes + size > rowBudget) break;
      rows.push(row);
      bytes += size;
    }
    const omitted = pins.length - rows.length;
    return result(
      {
        ok: true,
        status,
        pins: rows,
        openPinCount,
        hasMore,
        ...(omitted > 0 ? { truncated: true, omitted } : {}),
        note: LIST_NOTE,
      },
      false
    );
  }

  /** #6453 `pin_folder`: make the pin's folder and name it and its saved twin. */
  async function folder(args: unknown): Promise<PinToolResult> {
    const parsed = pinFolderInputSchema.safeParse(args ?? {});
    if (!parsed.success) return inputRefusal(parsed.error, NOT_MADE);
    const { key } = parsed.data;
    const outcome = await send("POST", pinUrl(key, "/folder"));
    if (outcome.kind === "transport")
      return transportFailure(outcome, NOT_MADE);
    if (!outcome.ok) return httpFailure(outcome, key, NOT_MADE);
    const made = PinFolderResponseSchema.safeParse(outcome.body);
    if (!made.success) return badResponse(outcome, NOT_MADE);
    return result(
      {
        ok: true,
        key,
        folder: made.data.folder,
        savedFolder: made.data.savedFolder,
        note: FOLDER_NOTE,
      },
      false
    );
  }

  return {
    specs: PIN_TOOL_SPECS,
    post,
    update,
    withdraw,
    get,
    resolve,
    folder,
  };
}
