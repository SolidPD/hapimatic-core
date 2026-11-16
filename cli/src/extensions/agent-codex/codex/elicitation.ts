// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP elicitations from Codex (#6606): an MCP server's request for input is
 * answered by the user's own choice on a card, or declined with a visible
 * reason. Hapimatic never derives a value from the schema.
 *
 * Routing reads `mode` first (a link request carries no `requestedSchema`),
 * then the structure, and never `_meta`, because a server can copy Codex's
 * tool-call marker (measured on 0.167.0):
 * - `url`: a link card, when the address passes `checkElicitationUrl`;
 * - `form`, `openai/form`, `openaiForm`: a field-less request (an object
 *   schema with empty `properties` and `required` absent or empty) keeps
 *   today's `mcp__<server>` approve/deny card, which covers Codex's own
 *   tool-call approvals; a form with fields gets the `mcp_elicitation` card
 *   when the parser supports it;
 * - anything else is declined with a notice, and no card is shown.
 *
 * In YOLO every request is declined with a notice and nobody is asked. Codex
 * answers first in YOLO (it declines forms and link requests, and accepts a
 * field-less form with `{}`), so this is the defence behind Codex.
 *
 * Transport-neutral: no app-server types, so the MCP transport (#6566) can
 * reuse it. The caller registers each request under its own fresh key.
 */

import {
  ELICITATION_LIMITS,
  MCP_ELICITATION_TOOL,
  answersToContent,
  checkElicitationUrl,
  cleanElicitationText,
  formatElicitationAnswers,
  parseElicitationSchema,
  type ElicitationField,
  type ElicitationRequestInput,
} from "@hapi/protocol";
import type {
  PermissionAnswerCheck,
  PermissionAnswerValidator,
} from "./utils/permissionHandler";

export type ElicitationDecision =
  | "approved"
  | "approved_for_session"
  | "denied"
  | "abort";

export interface ElicitationAskResult {
  decision: ElicitationDecision;
  /** Only an answer set the validator accepted. */
  answers?: Record<string, string[]>;
  answeredBy?: "session";
  reason?: string;
}

/** Show a card and wait for the answer; the validator runs in the handler. */
export type ElicitationAsk = (
  toolName: string,
  input: unknown,
  validate?: PermissionAnswerValidator
) => Promise<ElicitationAskResult>;

export interface ElicitationReply {
  action: "accept" | "decline" | "cancel";
  content: Record<string, unknown> | null;
  _meta: null;
}

/** Today's card input for a field-less request (`mcp__<server>`). */
export interface ElicitationConfirmInput {
  message?: string;
  server?: string;
  requestedSchema: unknown;
}

export type ElicitationRefusal = "form" | "secret" | "unshowable" | "link";

export type ElicitationRequest =
  | { kind: "confirm"; server: string | null; input: ElicitationConfirmInput }
  | { kind: "form"; server: string | null; input: ElicitationRequestInput }
  | { kind: "url"; server: string | null; input: ElicitationRequestInput }
  | {
      kind: "unsupported";
      server: string | null;
      /**
       * Which notice: an unsupported form, a secret field, a field whose name
       * or title holds a character Hapimatic cannot show, a refused link.
       */
      refusal: ElicitationRefusal;
      reason: string;
      field?: string;
    };

export interface ResolveElicitationOptions {
  request: ElicitationRequest;
  /** YOLO: approval policy `never` with `danger-full-access`. */
  yolo: boolean;
  ask: ElicitationAsk;
  /** Post a chat notice (the app-server transport's `hapi_notice`). */
  notice: (message: string) => void;
}

const FORM_MODES: ReadonlySet<string> = new Set([
  "form",
  "openai/form",
  "openaiForm",
]);

const DECLINE: Readonly<ElicitationReply> = {
  action: "decline",
  content: null,
  _meta: null,
};

function decline(): ElicitationReply {
  return { ...DECLINE };
}

function cancel(): ElicitationReply {
  return { action: "cancel", content: null, _meta: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A non-empty string: the rule the adapter's `asString` applies, so the
 * field-less card reads the server and the message as it did before #6606.
 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shown(name: string): string {
  return cleanElicitationText(name, ELICITATION_LIMITS.noticeName);
}

/** The server as a notice shows it: cleaned, cut to 64 characters (R15). */
function serverLabel(server: string | null): string {
  const label = server === null ? "" : shown(server);
  return label === "" ? "(unnamed)" : label;
}

function count(limit: number): string {
  return limit.toLocaleString("en-US");
}

/**
 * Field-less, exactly: an object type, empty `properties`, `required` absent
 * or empty.
 */
function isFieldLess(schema: unknown): boolean {
  if (!isRecord(schema) || schema.type !== "object") return false;
  if (!isRecord(schema.properties)) return false;
  if (Object.keys(schema.properties).length > 0) return false;
  const required = schema.required;
  return (
    required === undefined || (Array.isArray(required) && required.length === 0)
  );
}

function messageTooLong(message: string): boolean {
  return Array.from(message).length > ELICITATION_LIMITS.message;
}

function inputTooLarge(input: unknown): boolean {
  return JSON.stringify(input).length > ELICITATION_LIMITS.cardInput;
}

/**
 * Classify one `mcpServer/elicitation/request` (the flat 0.167.0 params, or
 * the older `params.request` shape). Every limit is checked before it
 * returns, so nothing over a limit is ever written to the session state.
 */
export function toElicitationRequest(params: unknown): ElicitationRequest {
  const record = isRecord(params) ? params : {};
  const nested = isRecord(record.request) ? record.request : null;
  const request = nested && Object.keys(nested).length > 0 ? nested : record;
  const server =
    nonEmpty(record.serverName) ?? nonEmpty(request.serverName) ?? null;
  const unsupported = (
    refusal: ElicitationRefusal,
    reason: string,
    field?: string
  ): ElicitationRequest =>
    field === undefined
      ? { kind: "unsupported", server, refusal, reason }
      : { kind: "unsupported", server, refusal, reason, field };

  const mode = request.mode;
  const message = text(request.message) ?? "";
  const elicitationId = text(request.elicitationId);
  if (typeof mode !== "string") {
    return unsupported("form", "the request has no mode");
  }

  if (mode === "url") {
    const url = request.url;
    const checked = checkElicitationUrl(url);
    if (!checked.ok) return unsupported("link", checked.reason);
    if (messageTooLong(message)) {
      return unsupported(
        "link",
        `a message longer than ${count(ELICITATION_LIMITS.message)} characters`
      );
    }
    const input: ElicitationRequestInput = {
      mode: "url",
      server: server ?? "",
      message,
      url: url as string,
      host: checked.host,
      punycode: checked.punycode,
    };
    if (elicitationId !== undefined) input.elicitationId = elicitationId;
    if (inputTooLarge(input)) {
      return unsupported(
        "link",
        `a request larger than ${count(ELICITATION_LIMITS.cardInput)} characters`
      );
    }
    return { kind: "url", server, input };
  }

  if (!FORM_MODES.has(mode)) {
    return unsupported(
      "form",
      `the request mode ${shown(mode)} is not supported`
    );
  }
  if (messageTooLong(message)) {
    return unsupported(
      "form",
      `a message longer than ${count(ELICITATION_LIMITS.message)} characters`
    );
  }

  const schema = request.requestedSchema;
  if (isFieldLess(schema)) {
    const input: ElicitationConfirmInput = { requestedSchema: schema };
    const plain = nonEmpty(request.message);
    if (plain !== undefined) input.message = plain;
    if (server !== null) input.server = server;
    if (inputTooLarge(input)) {
      return unsupported(
        "form",
        `a request larger than ${count(ELICITATION_LIMITS.cardInput)} characters`
      );
    }
    return { kind: "confirm", server, input };
  }

  const parsed = parseElicitationSchema(schema);
  if ("unsupported" in parsed) {
    if (parsed.secretField !== undefined) {
      return unsupported("secret", parsed.unsupported, parsed.secretField);
    }
    if (parsed.unshowableField !== undefined) {
      return unsupported(
        "unshowable",
        parsed.unsupported,
        parsed.unshowableField
      );
    }
    return unsupported("form", parsed.unsupported);
  }
  const input: ElicitationRequestInput = {
    mode: "form",
    server: server ?? "",
    message,
    fields: parsed.fields,
  };
  if (elicitationId !== undefined) input.elicitationId = elicitationId;
  if (inputTooLarge(input)) {
    return unsupported(
      "form",
      `a request larger than ${count(ELICITATION_LIMITS.cardInput)} characters`
    );
  }
  return { kind: "form", server, input };
}

function approved(decision: ElicitationDecision): boolean {
  return decision === "approved" || decision === "approved_for_session";
}

/** The reply for a request that was not approved: abort is cancel (R2). */
function notApproved(decision: ElicitationDecision): ElicitationReply {
  return decision === "abort" ? cancel() : decline();
}

/** Post a notice; a notice that throws never changes the reply. */
function say(notice: (message: string) => void, message: string): void {
  try {
    notice(message);
  } catch {
    // The reply stands: a lost notice is a lost line in the chat.
  }
}

function failureNotice(server: string): string {
  return `MCP server ${server} asked for input and Hapimatic could not process it. Declined.`;
}

function refusalNotice(
  server: string,
  request: Extract<ElicitationRequest, { kind: "unsupported" }>
): string {
  switch (request.refusal) {
    case "secret":
      return `MCP server ${server} asked for ${shown(request.field ?? "a field")} in a form. Hapimatic declines a form that asks for a password, key or token.`;
    case "unshowable":
      return `MCP server ${server} asked for ${shown(request.field ?? "a field")} in a form. Hapimatic declines a form whose field name or title holds a character it cannot show.`;
    case "link":
      return `MCP server ${server} asked you to open a link Hapimatic does not accept (${request.reason}). Declined.`;
    case "form":
      return `MCP server ${server} asked for input in a form Hapimatic cannot show (${request.reason}). Declined.`;
  }
}

/** Why a validator refused the last answer set it saw: a rule, or a throw. */
type Refusal = { kind: "rule"; reason: string } | { kind: "threw" };

/** A validator that remembers why it refused, for the notice. */
function recordingValidator(
  check: (answers: unknown) => PermissionAnswerCheck
): {
  validate: PermissionAnswerValidator;
  refusal: () => Refusal | null;
} {
  let refusal: Refusal | null = null;
  return {
    validate: answers => {
      try {
        const result = check(answers);
        refusal = result.ok ? null : { kind: "rule", reason: result.reason };
        return result;
      } catch {
        refusal = { kind: "threw" };
        return { ok: false, reason: "the answers could not be checked" };
      }
    },
    refusal: () => refusal,
  };
}

/** The notice for a request the validator refused; null when it did not. */
function refusedNotice(server: string, refusal: Refusal | null): string | null {
  if (refusal === null) return null;
  if (refusal.kind === "threw") return failureNotice(server);
  return `MCP server ${server}: the answers were not sent (${refusal.reason}). Declined.`;
}

async function answerConfirm(
  request: Extract<ElicitationRequest, { kind: "confirm" }>,
  ask: ElicitationAsk
): Promise<ElicitationReply> {
  const toolName =
    request.server !== null ? `mcp__${request.server}` : "CodexElicitation";
  const result = await ask(toolName, request.input);
  return approved(result.decision)
    ? { action: "accept", content: {}, _meta: null }
    : notApproved(result.decision);
}

async function answerForm(
  input: ElicitationRequestInput,
  server: string,
  ask: ElicitationAsk,
  notice: (message: string) => void
): Promise<ElicitationReply> {
  const fields: readonly ElicitationField[] = input.fields ?? [];
  const { validate, refusal } = recordingValidator(answers => {
    const result = answersToContent(fields, answers);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });
  const result = await ask(MCP_ELICITATION_TOOL, input, validate);
  if (approved(result.decision)) {
    // The handler checked these answers before it resolved; convert them, and
    // decline if they do not convert (an approval with no checked answers).
    const converted = answersToContent(fields, result.answers);
    if (!converted.ok || result.answers === undefined) {
      say(notice, failureNotice(server));
      return decline();
    }
    const by = result.answeredBy === "session" ? " by an agent session" : "";
    const line = formatElicitationAnswers(fields, result.answers);
    say(notice, `Sent to ${server}${by}: ${line === "" ? "no values" : line}`);
    return { action: "accept", content: { ...converted.content }, _meta: null };
  }
  const said = refusedNotice(server, refusal());
  if (said !== null) say(notice, said);
  return notApproved(result.decision);
}

async function answerLink(
  input: ElicitationRequestInput,
  server: string,
  ask: ElicitationAsk,
  notice: (message: string) => void
): Promise<ElicitationReply> {
  const url = input.url ?? "";
  const { validate, refusal } = recordingValidator(answers => {
    const echoed =
      isRecord(answers) &&
      Object.keys(answers).length === 1 &&
      Array.isArray(answers.url) &&
      answers.url.length === 1 &&
      answers.url[0] === url;
    return echoed
      ? { ok: true }
      : { ok: false, reason: "url: not the address of this request" };
  });
  const result = await ask(MCP_ELICITATION_TOOL, input, validate);
  if (approved(result.decision)) {
    say(
      notice,
      `Accepted ${server}'s link request (${shown(input.host ?? "")}).`
    );
    return { action: "accept", content: null, _meta: null };
  }
  const said = refusedNotice(server, refusal());
  if (said !== null) say(notice, said);
  return notApproved(result.decision);
}

/**
 * The reply for one classified request: always `{action, content, _meta:
 * null}`. Never throws: a failure is a decline with a notice, because Codex
 * must never receive a JSON-RPC error for an elicitation (R14).
 */
export async function resolveElicitation(
  options: ResolveElicitationOptions
): Promise<ElicitationReply> {
  const { request, yolo, ask, notice } = options;
  let server = "(unnamed)";
  try {
    server = serverLabel(request.server);
    if (yolo) {
      say(
        notice,
        `MCP server ${server} asked for input. Declined, because this session is in YOLO mode.`
      );
      return decline();
    }
    switch (request.kind) {
      case "unsupported":
        say(notice, refusalNotice(server, request));
        return decline();
      case "confirm":
        return await answerConfirm(request, ask);
      case "form":
        return await answerForm(request.input, server, ask, notice);
      case "url":
        return await answerLink(request.input, server, ask, notice);
    }
  } catch {
    say(notice, failureNotice(server));
    return decline();
  }
}

/** The server named by params that may not be readable at all. */
function serverOf(params: unknown): string | null {
  try {
    return isRecord(params) ? (nonEmpty(params.serverName) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Classify and answer one request in one guarded step, so a throw while
 * routing is a decline with a notice too. The one entry a transport calls.
 */
export async function answerElicitation(options: {
  params: unknown;
  yolo: boolean;
  ask: ElicitationAsk;
  notice: (message: string) => void;
}): Promise<ElicitationReply> {
  let request: ElicitationRequest;
  try {
    request = toElicitationRequest(options.params);
  } catch {
    say(options.notice, failureNotice(serverLabel(serverOf(options.params))));
    return decline();
  }
  return resolveElicitation({
    request,
    yolo: options.yolo,
    ask: options.ask,
    notice: options.notice,
  });
}
