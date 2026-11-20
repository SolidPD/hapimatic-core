// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The prompt mirror (issue #6455, epic #6446; design D2 / F7): every prompt a
 * session is blocked on becomes a pin with no agent involvement. A tool-permission
 * request and an `AskUserQuestion` sit in `agentState.requests` until they move to
 * `completedRequests`; a pty/tmux session's terminal prompt shows as
 * `blockedOnTuiPrompt`. Each becomes a `prompt:` pin, which links to the native
 * control and offers none of its own (approvals keep their native controls).
 *
 * ## What the text carries
 * Every field a mirrored pin quotes (a command's first line, a question, a
 * terminal prompt, an answer) passes through `cleanPinText` before
 * `capPinText`: the transcript scrub (`scrubTranscriptSecrets`, which covers
 * GitHub, AWS, provider and `CLI_API_TOKEN=` secrets), after approval tokens
 * are neutralized (#6530, #6458 Task 11c).
 *
 * A title is never cut (#6739, TITLE-D): `serverPinTitle` keeps a question that
 * fits 200 whole and makes a longer one its question sentence, and keeps every
 * other source (a command's first line, a path, an MCP or terminal message)
 * whole up to `PIN_SERVER_TITLE_MAX_CHARS`. Past that, or when the pin is
 * refused for size, the pin is built once more under the writer's fixed label
 * (`Allow Bash?`, `<server> asks for input`, …) with the whole text in its
 * body, which is cut, at a word and marked "…", only when it cannot fit the
 * pin's own limits.
 *
 * ## Level-triggered, not edge-triggered
 * A pin is durable state, so each reconcile compares the session's open `prompt:`
 * pins with what is pending NOW, rather than diffing events the way the push
 * notifier does. A missed event therefore cannot leave a stale pin holding one
 * of the session's open slots. A restart followed by a resume keeps each
 * request's first-seen pid (below). One known limit: a withdraw that loses the
 * write lock twice, on a session that then sends no more events, leaves its pin
 * open until the session's next update or the next boot sweep, because the
 * fingerprint is stored only after a reconcile succeeds. The first reconcile of
 * each session (on boot, `start()`) reads its open keys from the store.
 *
 * ## Where it runs, and the exception rule
 * `session-updated` fires inside the CLI socket listener (`update-state`), which
 * has spent its one allowed blocking write (server/CLAUDE.md "Database", #3631).
 * So `onEvent` does no database work: it marks the session dirty, and a deferred
 * drain reconciles one session per tick, reading the session's state at that
 * moment, so a burst of updates costs one reconcile. A lost write lock is logged
 * with `persist: false` and retried once after a second; nothing throws out of a
 * timer callback, because the server installs no `uncaughtException` handler.
 *
 * ## Cheap when nothing changed
 * `session-updated` also fires for keepalives and metadata, at least every 10 s
 * per active session. The fingerprint (`agentStateVersion`, `active`, `hostPid`,
 * the terminal prompt) skips those with no store read, and `completedRequests`, which only
 * grows, is read by id. The one exception is a hashed `prompt:h-` key (a request
 * id that does not fit a pin key), which is matched by scanning the completions.
 *
 * ## A dead process's requests
 * A resumed session can still carry the previous process's pending `requests`.
 * Each request remembers the `hostPid` it was first seen pending under; one still
 * listed under a different `hostPid` belonged to a process that is gone, so its
 * pin is withdrawn rather than reopened, and a withdrawn one stays withdrawn.
 * The pid is held in memory and written into the pin as `requestHostPid` when
 * the pin is created (#6527, CR2-CM2). On a session's first reconcile after a
 * server restart, the mirror reads it back from the session's open and withdrawn
 * prompt pins before the pid check. So after a restart, an open pin first seen
 * under a gone process is withdrawn; a pin withdrawn before the restart is not
 * reopened by a resumed process that still lists its request; and the first
 * process, still listing it, keeps (or gets back) its open, live pin. A network
 * blip keeps the pid; if it marks the session inactive, the pin is withdrawn and
 * reopens on return.
 *
 * Two named limits (ruled by the Pins PM, 2026-11-14):
 * - a request whose closed pin was trimmed (`PROMPT_PIN_CLOSED_KEEP`, the newest
 *   20) has no pid left, so it is posted again as new;
 * - a pin written before the field existed, or re-posted by an older server
 *   (which writes it without the field), records no pid, so its first sighting
 *   after a restart is taken as its first.
 */
import { createHash } from "node:crypto";
import {
  formatElicitationAnswers,
  isQuestionToolName,
  MCP_ELICITATION_TOOL,
  PIN_SERVER_TITLE_MAX_CHARS,
  PinKeySchema,
  ServerPinContentSchema,
  type AgentStateCompletedRequest,
  type ElicitationField,
  type AgentStateRequest,
  type Pin,
  type PinContent,
  type SyncEvent,
} from "@hapi/protocol";
import {
  capPinText,
  cleanPinText,
  fitPinBody,
  serverPinTitle,
} from "./pinText";
import type { ErrorLogger } from "../logging/errorLogger";
import { isSqliteBusy } from "../socket/handlers/cli/messageWriteRetryQueue";
import { PROMPT_PIN_PREFIX, type PinService } from "./pinService";
import type { Session } from "./syncEngine";

/** Closed prompt pins kept per session; older ones are deleted (R5). */
export const PROMPT_PIN_CLOSED_KEEP = 20;
/** The one delayed retry after a lost write lock. */
export const PROMPT_PIN_BUSY_RETRY_MS = 1000;
/** The terminal prompt's key prefix (pty/tmux launchers). */
export const TUI_PROMPT_PREFIX = `${PROMPT_PIN_PREFIX}tui-`;

const LOG_CATEGORY = "pin-prompt";
/**
 * A mirrored prompt's context when its title fits, at most. It equals
 * `PIN_SERVER_TITLE_MAX_CHARS` (#6739), and a test keeps the two equal.
 */
export const CONTEXT_MAX_CHARS = PIN_SERVER_TITLE_MAX_CHARS;
const ANSWER_MAX_CHARS = 4000;
/** Room a fence takes, so a capped body and its fence fit `CONTEXT_MAX_CHARS`. */
const FENCE_ROOM = 16;
/** A pin's text field, at most (`PIN_TEXT_MAX_CHARS` in shared/src/pins.ts). */
const PIN_BODY_MAX_CHARS = 16 * 1024;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PLAN_TOOLS = new Set(["ExitPlanMode", "exit_plan_mode"]);

type MirrorSession = Pick<
  Session,
  | "id"
  | "namespace"
  | "active"
  | "agentState"
  | "agentStateVersion"
  | "blockedOnTuiPrompt"
  | "metadata"
>;

export type PinPromptMirrorOptions = {
  pins: Pick<
    PinService,
    | "get"
    | "upsert"
    | "answer"
    | "withdraw"
    | "listKeysByPrefix"
    | "trimClosedByPrefix"
  >;
  getSession: (sessionId: string) => MirrorSession | undefined;
  /** Every session this node owns, for the boot sweep. */
  listSessions: () => MirrorSession[];
  /** The stored message holding a tool call, by the call's id. */
  findMessageId: (sessionId: string, needle: string) => string | null;
  /** The Pins gate, read once at construction. */
  pinsEnabled: boolean;
  errorLogger?: ErrorLogger | null;
  /** Runs one drain step later; `setImmediate` by default. */
  schedule?: (run: () => void) => void;
  /** Runs the busy retry later; `setTimeout` by default. */
  delay?: (run: () => void, ms: number) => void;
};

type SessionState = {
  fingerprint: string | null;
  /** Request id → the `hostPid` it was first seen pending under. */
  pidById: Map<string, number | undefined>;
  /**
   * Pin key → the `hostPid` its request was first seen under, read back from the
   * session's open and withdrawn prompt pins when this state was created (#6527):
   * after a server restart it seeds `pidById` before the pid check reads it.
   */
  seedPidByKey: Map<string, number>;
  /** The open terminal prompt's key, held for the whole blocked period. */
  tuiKey: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * A fence that its content cannot close: one backtick longer than the body's
 * longest backtick run, and at least three (#6739, R12).
 */
function fenced(body: string, lang = ""): string {
  // A loop, not a spread: a long command can hold more runs than a call takes.
  let longest = 0;
  for (const run of body.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

/**
 * What a mirrored prompt's pin is built from (#6739). `title` is the title's
 * source, before `serverPinTitle`; `context` is the context ready to store when
 * that title fits (scrubbed, capped, and fenced); `label` is the writer's fixed
 * title; `whole` is the scrubbed, uncut text the fixed-label build shows, in its
 * context (fenced when `fence` is set) or in its plain text.
 */
type PromptParts = {
  title: string;
  context: string;
  label: string;
  whole: {
    text: string;
    fence?: string;
    into: "context" | "plainText";
  } | null;
};

/** A context ready to store from scrubbed text: capped. */
function storedContext(clean: string): string {
  return clean ? capPinText(clean, CONTEXT_MAX_CHARS) : "";
}

/** A fenced context from scrubbed text, capped first so its closing fence survives. */
function fencedContext(clean: string, lang: string): string {
  return clean
    ? fenced(capPinText(clean, CONTEXT_MAX_CHARS - FENCE_ROOM), lang)
    : "";
}

/**
 * Whether the request behind a `prompt:` pin is still waiting, by the mirror's
 * own rules (#6458 Task 11k, #6527 CR2-CM2): an inactive session lists no live
 * request, a terminal prompt is live while the session is blocked on one, and a
 * chat prompt is live while the session's `agentState` lists a request whose key
 * is this one. An absent `agentState` (a caller that did not say) reads as live,
 * so an unknown state keeps the refusal; `null` is a state with no requests.
 * The operator may dismiss an open one this says is not live (its request is
 * gone, or its session is inactive); it closes withdrawn, the way the mirror
 * closes one, so a request that is still waiting re-posts it open.
 */
export function isPromptPinLive(
  session: Pick<Session, "active"> &
    Partial<Pick<Session, "agentState" | "blockedOnTuiPrompt">>,
  key: string
): boolean {
  if (!key.startsWith(PROMPT_PIN_PREFIX)) return false;
  if (!session.active) return false;
  if (key.startsWith(TUI_PROMPT_PREFIX)) {
    return session.blockedOnTuiPrompt != null;
  }
  if (session.agentState === undefined) return true;
  const requests = session.agentState?.requests ?? {};
  return Object.keys(requests).some(id => promptPinKey(id) === key);
}

/**
 * #6458 (D-b): a pin read as the operator sees it. An open `prompt:` pin
 * carries `requestLive`, so the web offers Dismiss only on one whose request is
 * gone; a Submit's check asks `isPromptPinLive` again, so a stale flag never
 * dismisses a waiting prompt.
 */
export function withRequestLive<R extends { pins: Pin[] } | { pin: Pin }>(
  session: Parameters<typeof isPromptPinLive>[0],
  result: R
): R {
  const stamp = (pin: Pin): Pin =>
    pin.status === "open" && pin.key.startsWith(PROMPT_PIN_PREFIX)
      ? { ...pin, requestLive: isPromptPinLive(session, pin.key) }
      : pin;
  return "pins" in result
    ? { ...result, pins: result.pins.map(stamp) }
    : { ...result, pin: stamp(result.pin) };
}

/** `prompt:<id>`, or a hash when the id does not fit a pin key. */
export function promptPinKey(requestId: string): string {
  const key = `${PROMPT_PIN_PREFIX}${requestId}`;
  if (PinKeySchema.safeParse(key).success) return key;
  const hash = createHash("sha256").update(requestId).digest("hex");
  return `${PROMPT_PIN_PREFIX}h-${hash.slice(0, 24)}`;
}

function questionPrompt(args: Record<string, unknown>): PromptParts {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const lines: string[] = [];
  let title = "";
  for (const raw of questions) {
    const q = asRecord(raw);
    const text = str(q.question) ?? str(q.header);
    if (!text) continue;
    if (!title) title = text;
    lines.push(`**${text}**`);
    for (const rawOption of Array.isArray(q.options) ? q.options : []) {
      const option = asRecord(rawOption);
      const label = str(option.label);
      if (!label) continue;
      const description = str(option.description);
      lines.push(`- ${label}${description ? ` — ${description}` : ""}`);
    }
  }
  const label = "Answer the agent's question";
  const body = cleanPinText(lines.join("\n"));
  return {
    title: title || label,
    context: storedContext(body),
    label,
    whole: body ? { text: body, into: "context" } : null,
  };
}

function permissionPrompt(
  tool: string,
  args: Record<string, unknown>
): PromptParts {
  if (PLAN_TOOLS.has(tool)) {
    const plan = cleanPinText(str(args.plan) ?? "");
    return {
      title: "Approve the plan?",
      context: storedContext(plan),
      label: "Approve the plan?",
      whole: plan ? { text: plan, into: "context" } : null,
    };
  }
  if (tool === "Bash") {
    const command = str(args.command) ?? "";
    const clean = cleanPinText(command);
    // The whole first non-blank line (#6739, ruling Q1), scrubbed before it is
    // measured: a key cut at a cap no longer matches its pattern.
    const firstLine =
      command
        .split("\n")
        .find(line => line.trim() !== "")
        ?.trim() ?? "";
    return {
      title: firstLine
        ? `Allow Bash: ${cleanPinText(firstLine)}?`
        : "Allow Bash?",
      context: fencedContext(clean, "bash"),
      label: "Allow Bash?",
      whole: clean ? { text: clean, fence: "bash", into: "context" } : null,
    };
  }
  if (EDIT_TOOLS.has(tool)) {
    const path = str(args.file_path) ?? str(args.notebook_path) ?? "";
    return {
      title: `Allow ${tool}: ${path}?`,
      context: "",
      label: `Allow ${tool}?`,
      whole: path
        ? { text: cleanPinText(path), fence: "", into: "context" }
        : null,
    };
  }
  let json = "";
  try {
    json = JSON.stringify(args, null, 2) ?? "";
  } catch {
    json = "";
  }
  const clean = json !== "" && json !== "{}" ? cleanPinText(json) : "";
  return {
    title: `Allow ${tool}?`,
    context: fencedContext(clean, "json"),
    label: `Allow ${tool}?`,
    whole: clean ? { text: clean, fence: "json", into: "context" } : null,
  };
}

/**
 * An MCP server's form or link request (#6606): the server's message goes
 * only into the plain-text title, and the context stays empty, because the
 * context is rendered as markdown and the message is the server's text. Past
 * the title limit (#6739) the whole message goes into the plain text, which the
 * Text view shows as plain text, under the fixed label.
 */
function elicitationPrompt(args: Record<string, unknown>): PromptParts {
  const server = str(args.server) ?? "An MCP server";
  const message = (str(args.message) ?? "").replace(/\s+/g, " ").trim();
  const label = `${server} asks for input`;
  return {
    title: message ? `${label}: ${message}` : label,
    context: "",
    label,
    whole: message ? { text: cleanPinText(message), into: "plainText" } : null,
  };
}

/** The field names of an elicitation card, in card order, when readable. */
function elicitationFields(args: Record<string, unknown>): ElicitationField[] {
  const raw = Array.isArray(args.fields) ? args.fields : [];
  const fields: ElicitationField[] = [];
  for (const item of raw) {
    const name = str(asRecord(item).name);
    if (name) fields.push({ name, kind: "text", required: false });
  }
  return fields;
}

/** The answer text for a completed elicitation, or null to use the default. */
function elicitationOutcomeText(
  args: Record<string, unknown>,
  answers: Record<string, string[]>
): string | null {
  if (args.mode === "url") {
    const host = str(args.host);
    return host ? `Link accepted (${host})` : "Link accepted";
  }
  const fields = elicitationFields(args);
  if (fields.length === 0) return null;
  const line = formatElicitationAnswers(fields, answers);
  return line || "Submitted with every field left empty";
}

/**
 * Build a mirrored prompt's pin from its parts (#6739). The first build carries
 * `title` (null when it is past the server's limit); when that is null or the
 * build is refused, it is built once more under the fixed label with the whole
 * text in its body, shortened at a word only when the pin's own limits refuse
 * it. `note` hears a body cut and each refused build; null when both are
 * refused.
 */
function buildMirroredPin(
  parts: PromptParts,
  title: string | null,
  build: (
    title: string,
    context: string,
    plainText: string
  ) => PinContent | null,
  plainText: (title: string) => string,
  note?: (message: string) => void
): PinContent | null {
  if (title) {
    const first = build(title, parts.context, plainText(title));
    if (first) return first;
    note?.("a prompt pin was refused; retrying under its fixed label");
  }
  const { label, whole } = parts;
  if (!whole) {
    return build(label, parts.context, plainText(label));
  }
  const fitted = fitPinBody(whole.text, PIN_BODY_MAX_CHARS, body =>
    whole.into === "context"
      ? build(
          label,
          whole.fence === undefined ? body : fenced(body, whole.fence),
          plainText(label)
        )
      : build(label, parts.context, plainText(`${label}: ${body}`))
  );
  if (fitted?.cut) note?.("a prompt pin's body was cut to fit");
  return fitted?.pin ?? null;
}

/** The pin a pending request becomes: a blocking decision with no options. */
export function buildPromptPin(
  key: string,
  request: Pick<AgentStateRequest, "tool" | "arguments">,
  firstPid?: number,
  note?: (message: string) => void
): PinContent | null {
  const args = asRecord(request.arguments);
  const tool = request.tool;
  const where = "in the chat";
  const parts =
    tool === MCP_ELICITATION_TOOL
      ? elicitationPrompt(args)
      : isQuestionToolName(tool)
        ? questionPrompt(args)
        : permissionPrompt(tool, args);
  const source = cleanPinText(parts.title.replace(/\s+/g, " ").trim());
  // An MCP message is the server's own text, kept whole (isQuestionToolName is
  // also true for the MCP tool); a question is prose, shortened to its sentence.
  const title = serverPinTitle(
    source,
    tool !== MCP_ELICITATION_TOOL && isQuestionToolName(tool)
      ? "prose"
      : "quote"
  );
  const build = (
    pinTitle: string,
    context: string,
    plainText: string
  ): PinContent | null => {
    const parsed = ServerPinContentSchema.safeParse({
      key,
      kind: "decision",
      title: pinTitle,
      ...(context ? { context } : {}),
      stakes: "costly",
      risk: "medium",
      blocking: true,
      plainText,
      // #6527: read back after a restart, so a resumed process that still lists
      // this request is not taken for the process that raised it.
      ...(Number.isInteger(firstPid) && (firstPid as number) > 0
        ? { requestHostPid: firstPid }
        : {}),
    });
    return parsed.success ? parsed.data : null;
  };
  const content = buildMirroredPin(
    parts,
    title === "" ? parts.label : title,
    build,
    pinTitle => `${pinTitle} — waiting for your answer ${where}`,
    note
  );
  if (!content) note?.("a prompt pin was refused under its fixed label too");
  return content;
}

function tuiPromptPin(
  key: string,
  message: string,
  note?: (message: string) => void
): PinContent | null {
  const label = "Claude is waiting in the terminal";
  const sentence = "Answer this prompt in the session's Terminal tab.";
  const clean = cleanPinText(message.trim());
  const parts: PromptParts = {
    title: clean || label,
    context: sentence,
    label,
    whole: null,
  };
  const title = serverPinTitle(parts.title, "quote");
  const build = (
    pinTitle: string,
    context: string,
    plainText: string
  ): PinContent | null => {
    const parsed = ServerPinContentSchema.safeParse({
      key,
      kind: "decision",
      title: pinTitle,
      context,
      stakes: "costly",
      risk: "medium",
      blocking: true,
      plainText,
    });
    return parsed.success ? parsed.data : null;
  };
  const plainText = (pinTitle: string): string =>
    `${pinTitle} — waiting for your answer in the terminal`;
  let content =
    title === null
      ? null
      : build(title || label, sentence, plainText(title || label));
  if (!content) {
    if (title !== null) {
      note?.(
        "a terminal prompt pin was refused; retrying under its fixed label"
      );
    }
    // The whole message, fenced as plain text below the sentence.
    const fitted = fitPinBody(clean, PIN_BODY_MAX_CHARS, body =>
      build(label, `${sentence}\n\n${fenced(body)}`, plainText(label))
    );
    if (fitted?.cut) note?.("a terminal prompt pin's body was cut to fit");
    content = fitted?.pin ?? null;
  }
  if (!content)
    note?.("a terminal prompt pin was refused under its fixed label too");
  return content;
}

/** What the operator answered, as the pin's answer text. */
export function promptOutcomeText(
  done: Pick<
    AgentStateCompletedRequest,
    "tool" | "status" | "reason" | "decision" | "answers"
  > &
    Partial<Pick<AgentStateCompletedRequest, "arguments">>
): string {
  if (done.status === "denied") {
    const reason = str(done.reason);
    return capPinText(
      cleanPinText(reason ? `Denied: ${reason}` : "Denied"),
      ANSWER_MAX_CHARS
    );
  }
  const answers = done.answers ?? {};
  if (done.tool === MCP_ELICITATION_TOOL) {
    // A submitted form shows its fields and values in card order; an accepted
    // link shows its host, never the full address (69-Q2-b, #6606).
    const text = elicitationOutcomeText(asRecord(done.arguments), answers);
    if (text !== null) return capPinText(cleanPinText(text), ANSWER_MAX_CHARS);
  }
  const pairs = Object.entries(answers).map(
    ([question, labels]) => `${question}: ${labels.join(", ")}`
  );
  if (pairs.length > 0)
    return capPinText(cleanPinText(pairs.join("; ")), ANSWER_MAX_CHARS);
  return done.decision === "approved_for_session"
    ? "Approved for this session"
    : "Approved";
}

export class PinPromptMirror {
  private readonly dirty = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly states = new Map<string, SessionState>();
  private draining = false;
  private readonly schedule: (run: () => void) => void;
  private readonly delay: (run: () => void, ms: number) => void;

  constructor(private readonly options: PinPromptMirrorOptions) {
    this.schedule = options.schedule ?? (run => setImmediate(run));
    this.delay = options.delay ?? ((run, ms) => setTimeout(run, ms));
  }

  /** Queue every session once, after a restart (no event re-announces them). */
  start(): void {
    if (!this.options.pinsEnabled) return;
    try {
      for (const session of this.options.listSessions()) {
        this.enqueue(session.id);
      }
    } catch (error) {
      this.log("boot sweep failed", undefined, error);
    }
  }

  /** The EventPublisher listener: no database work, ever. */
  onEvent(event: SyncEvent): void {
    if (!this.options.pinsEnabled) return;
    if (event.type === "session-removed" && event.sessionId) {
      this.states.delete(event.sessionId);
      this.dirty.delete(event.sessionId);
      return;
    }
    if (
      (event.type === "session-updated" || event.type === "session-added") &&
      event.sessionId
    ) {
      this.enqueue(event.sessionId);
    }
  }

  private enqueue(sessionId: string): void {
    this.dirty.add(sessionId);
    if (this.draining) return;
    this.draining = true;
    this.schedule(() => this.drainOne());
  }

  private drainOne(): void {
    const next = this.dirty.values().next();
    if (next.done) {
      this.draining = false;
      return;
    }
    const sessionId = next.value;
    this.dirty.delete(sessionId);
    this.reconcileSafely(sessionId);
    this.schedule(() => this.drainOne());
  }

  private reconcileSafely(sessionId: string): void {
    try {
      this.reconcile(sessionId);
      this.retried.delete(sessionId);
    } catch (error) {
      if (isSqliteBusy(error) && !this.retried.has(sessionId)) {
        this.retried.add(sessionId);
        this.log("write lock busy; retrying once", sessionId, error);
        this.delay(() => this.enqueue(sessionId), PROMPT_PIN_BUSY_RETRY_MS);
        return;
      }
      this.retried.delete(sessionId);
      // The fingerprint was not stored, so the next update reconciles again.
      this.log("reconcile failed", sessionId, error);
    }
  }

  private stateOf(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        fingerprint: null,
        pidById: new Map(),
        seedPidByKey: this.readFirstPids(sessionId),
        tuiKey: null,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * The first-seen `hostPid` each open or withdrawn chat-prompt pin of a session
   * recorded (#6527, CR2-CM2). A withdrawn one counts too, so a request withdrawn
   * before a restart is not taken for new and re-posted open. A pin written
   * before the field existed, or by an older server, has none.
   */
  private readFirstPids(sessionId: string): Map<string, number> {
    const { pins } = this.options;
    const seeds = new Map<string, number>();
    for (const status of ["open", "withdrawn"] as const) {
      for (const key of pins.listKeysByPrefix(
        sessionId,
        PROMPT_PIN_PREFIX,
        status
      )) {
        if (key.startsWith(TUI_PROMPT_PREFIX)) continue;
        const pid = pins.get(sessionId, key)?.pin.requestHostPid;
        if (typeof pid === "number") seeds.set(key, pid);
      }
    }
    return seeds;
  }

  /** Bring one session's prompt pins in line with what it is blocked on now. */
  reconcile(sessionId: string): void {
    if (!this.options.pinsEnabled) return;
    const session = this.options.getSession(sessionId);
    if (!session) {
      this.states.delete(sessionId);
      return;
    }
    const state = this.stateOf(sessionId);
    const hostPid =
      typeof session.metadata?.hostPid === "number"
        ? session.metadata.hostPid
        : undefined;
    const tui = session.active ? (session.blockedOnTuiPrompt ?? null) : null;
    const fingerprint = [
      session.agentStateVersion,
      session.active ? 1 : 0,
      hostPid ?? "",
      tui ? tui.since : "",
    ].join("|");
    if (state.fingerprint === fingerprint) return;

    const ref = { id: session.id, namespace: session.namespace };
    const { pins } = this.options;
    const requests = session.active ? (session.agentState?.requests ?? {}) : {};
    const completed = session.agentState?.completedRequests ?? {};

    // What is pending now, without a dead process's leftovers.
    const pending = new Map<
      string,
      { id: string; request: AgentStateRequest }
    >();
    for (const [id, request] of Object.entries(requests)) {
      if (!request || typeof request.tool !== "string") continue;
      if (!state.pidById.has(id)) {
        state.pidById.set(
          id,
          state.seedPidByKey.get(promptPinKey(id)) ?? hostPid
        );
      }
      const firstPid = state.pidById.get(id);
      if (
        firstPid !== undefined &&
        hostPid !== undefined &&
        firstPid !== hostPid
      ) {
        continue;
      }
      pending.set(promptPinKey(id), { id, request });
    }
    // Forget a request only while the session runs: an inactive session lists
    // none, and a resume under a new process must still see the old pid.
    if (session.active) {
      for (const id of state.pidById.keys()) {
        if (!(id in requests)) state.pidById.delete(id);
      }
    }

    const open = new Set(
      pins.listKeysByPrefix(sessionId, PROMPT_PIN_PREFIX, "open")
    );
    let closedAny = false;
    // A capped write leaves the fingerprint unset, so the next update (a
    // keepalive at least every 10 s) tries again once a slot frees.
    let retry = false;

    for (const [key, { id, request }] of pending) {
      if (open.has(key)) continue;
      const content = buildPromptPin(
        key,
        request,
        state.pidById.get(id),
        note => this.log(note, sessionId, `tool ${request.tool}`)
      );
      if (!content) {
        this.log(
          "request could not become a pin",
          sessionId,
          `tool ${request.tool}`
        );
        continue;
      }
      const messageId = this.options.findMessageId(sessionId, id);
      const outcome = pins.upsert(ref, content, {
        ...(messageId
          ? {
              anchor: {
                messageId,
                blockId: id,
                offsetPx: 0,
                anchorHeightPx: null,
              },
            }
          : {}),
      });
      if ("capped" in outcome) {
        retry = true;
        this.log(`pin cap (${outcome.capped}) reached`, sessionId);
      }
    }

    for (const key of open) {
      if (key.startsWith(TUI_PROMPT_PREFIX) || pending.has(key)) continue;
      const id = this.requestIdFor(key, completed);
      const done = id === null ? undefined : completed[id];
      if (done && (done.status === "approved" || done.status === "denied")) {
        pins.answer(ref, key, {
          // A session's answer through respond_to_permission (69-Q1-b, #6606).
          by: done.answeredBy === "session" ? "agent" : "operator",
          via: "prompt",
          text: promptOutcomeText(done),
          resolves: true,
        });
      } else {
        pins.withdraw(ref, key);
      }
      closedAny = true;
    }

    if (tui) {
      // After a restart, keep the pin already open for this blocked period
      // even when the prompt's notification fired again with a newer `since`.
      state.tuiKey ??=
        [...open].find(key => key.startsWith(TUI_PROMPT_PREFIX)) ??
        `${TUI_PROMPT_PREFIX}${tui.since}`;
      if (!open.has(state.tuiKey)) {
        const content = tuiPromptPin(state.tuiKey, tui.message, note =>
          this.log(note, sessionId)
        );
        if (!content) {
          this.log("terminal prompt could not become a pin", sessionId);
        } else if ("capped" in pins.upsert(ref, content)) {
          retry = true;
        }
      }
    } else {
      state.tuiKey = null;
    }
    for (const key of open) {
      if (!key.startsWith(TUI_PROMPT_PREFIX) || key === state.tuiKey) continue;
      if (session.active) {
        pins.answer(ref, key, {
          by: "operator",
          via: "terminal",
          text: "Answered in the terminal",
          resolves: true,
        });
      } else {
        // The session stopped with the prompt still up: nobody answered it.
        pins.withdraw(ref, key);
      }
      closedAny = true;
    }

    if (closedAny) {
      pins.trimClosedByPrefix(ref, PROMPT_PIN_PREFIX, PROMPT_PIN_CLOSED_KEEP);
    }
    state.fingerprint = retry ? null : fingerprint;
  }

  /** The request id behind a key; a hashed key is looked up among completions. */
  private requestIdFor(
    key: string,
    completed: Record<string, AgentStateCompletedRequest>
  ): string | null {
    const id = key.slice(PROMPT_PIN_PREFIX.length);
    if (!id.startsWith("h-")) return id;
    if (id in completed) return id;
    for (const candidate of Object.keys(completed)) {
      if (promptPinKey(candidate) === key) return candidate;
    }
    return null;
  }

  /** The session and detail go into the line too: ErrorLogger prints only it. */
  private log(message: string, sessionId?: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : (error ?? null);
    const where = [sessionId && `session ${sessionId}`, detail].filter(Boolean);
    const suffix = where.length > 0 ? ` (${where.join(", ")})` : "";
    this.options.errorLogger?.debug(`pin prompt mirror: ${message}${suffix}`, {
      category: LOG_CATEGORY,
      ...(sessionId ? { sessionId } : {}),
      context: {
        error: detail,
      },
      persist: false,
    });
  }
}
