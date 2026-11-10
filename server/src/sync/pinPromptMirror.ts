// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The prompt mirror (issue #6455, epic #6446; design D2 / F7): every prompt a
 * session is blocked on becomes a pin with no agent involvement. A tool-permission
 * request and an `AskUserQuestion` sit in `agentState.requests` until they move to
 * `completedRequests`; a pty/tmux session's terminal prompt shows as
 * `blockedOnTuiPrompt`. Each becomes a `prompt:` pin, which links to the native
 * control and offers none of its own (approvals keep their native controls).
 *
 * ## Level-triggered, not edge-triggered
 * A pin is durable state, so each reconcile compares the session's open `prompt:`
 * pins with what is pending NOW, rather than diffing events the way the push
 * notifier does. A missed event therefore cannot leave a stale pin holding one
 * of the session's open slots. Two known gaps are tracked in #6527: a restart
 * followed by a resume (below), and a withdraw that stays busy on a session that
 * then sends no more events. The first reconcile of each session (on boot,
 * `start()`) reads its open keys from the store.
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
 * Within one server lifetime each request remembers, in memory, the `hostPid` it
 * was first seen under; one still listed under a different `hostPid` belonged to
 * a process that is gone, so its pin is withdrawn rather than reopened. A server
 * restart forgets the pid, so a resumed process that still lists a dead
 * process's request reopens that pin (#6527). A network blip keeps the pid; if
 * it marks the session inactive, the pin is withdrawn and reopens on return.
 */
import { createHash } from "node:crypto";
import {
  isQuestionToolName,
  PinContentSchema,
  PinKeySchema,
  type AgentStateCompletedRequest,
  type AgentStateRequest,
  type PinContent,
  type SyncEvent,
} from "@hapi/protocol";
import { capPinText, cleanPinText } from "./pinText";
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
const CONTEXT_MAX_CHARS = 4000;
const TITLE_MAX_CHARS = 200;
const ANSWER_MAX_CHARS = 4000;
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
    "upsert" | "answer" | "withdraw" | "listKeysByPrefix" | "trimClosedByPrefix"
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

/** A fence that its content cannot close. */
function fenced(body: string, lang = ""): string {
  const fence = body.includes("```") ? "````" : "```";
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** `prompt:<id>`, or a hash when the id does not fit a pin key. */
export function promptPinKey(requestId: string): string {
  const key = `${PROMPT_PIN_PREFIX}${requestId}`;
  if (PinKeySchema.safeParse(key).success) return key;
  const hash = createHash("sha256").update(requestId).digest("hex");
  return `${PROMPT_PIN_PREFIX}h-${hash.slice(0, 24)}`;
}

function questionPrompt(args: Record<string, unknown>): {
  title: string;
  context: string;
} {
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
  return {
    title: title || "Answer the agent's question",
    context: lines.join("\n"),
  };
}

function permissionPrompt(
  tool: string,
  args: Record<string, unknown>
): { title: string; context: string } {
  if (PLAN_TOOLS.has(tool)) {
    return { title: "Approve the plan?", context: str(args.plan) ?? "" };
  }
  if (tool === "Bash") {
    const command = str(args.command) ?? "";
    const firstLine = command.split("\n")[0] ?? "";
    // Scrub before cutting: a key cut at the cap no longer matches its
    // pattern, so most of it would survive the later scrub.
    return {
      title: `Allow Bash: ${capPinText(cleanPinText(firstLine), 120)}?`,
      context: command ? fenced(command, "bash") : "",
    };
  }
  if (EDIT_TOOLS.has(tool)) {
    const path = str(args.file_path) ?? str(args.notebook_path) ?? "";
    return { title: `Allow ${tool}: ${path}?`, context: "" };
  }
  let json = "";
  try {
    json = JSON.stringify(args, null, 2) ?? "";
  } catch {
    json = "";
  }
  return {
    title: `Allow ${tool}?`,
    context: json && json !== "{}" ? fenced(json, "json") : "",
  };
}

/** The pin a pending request becomes: a blocking decision with no options. */
export function buildPromptPin(
  key: string,
  request: Pick<AgentStateRequest, "tool" | "arguments">
): PinContent | null {
  const args = asRecord(request.arguments);
  const tool = request.tool;
  const where = "in the chat";
  const { title, context } = isQuestionToolName(tool)
    ? questionPrompt(args)
    : permissionPrompt(tool, args);
  const cleanTitle = capPinText(
    cleanPinText(title.replace(/\s+/g, " ").trim()),
    TITLE_MAX_CHARS
  );
  const parsed = PinContentSchema.safeParse({
    key,
    kind: "decision",
    title: cleanTitle || `Allow ${tool}?`,
    ...(context
      ? { context: capPinText(cleanPinText(context), CONTEXT_MAX_CHARS) }
      : {}),
    stakes: "costly",
    risk: "medium",
    blocking: true,
    plainText: `${cleanTitle || tool} — waiting for your answer ${where}`,
  });
  return parsed.success ? parsed.data : null;
}

function tuiPromptPin(key: string, message: string): PinContent | null {
  const title = capPinText(
    cleanPinText(message.trim()) || "Claude is waiting in the terminal",
    TITLE_MAX_CHARS
  );
  const parsed = PinContentSchema.safeParse({
    key,
    kind: "decision",
    title,
    context: "Answer this prompt in the session's Terminal tab.",
    stakes: "costly",
    risk: "medium",
    blocking: true,
    plainText: `${title} — waiting for your answer in the terminal`,
  });
  return parsed.success ? parsed.data : null;
}

/** What the operator answered, as the pin's answer text. */
export function promptOutcomeText(
  done: Pick<
    AgentStateCompletedRequest,
    "tool" | "status" | "reason" | "decision" | "answers"
  >
): string {
  if (done.status === "denied") {
    const reason = str(done.reason);
    return capPinText(
      cleanPinText(reason ? `Denied: ${reason}` : "Denied"),
      ANSWER_MAX_CHARS
    );
  }
  const answers = done.answers ?? {};
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
      state = { fingerprint: null, pidById: new Map(), tuiKey: null };
      this.states.set(sessionId, state);
    }
    return state;
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
      if (!state.pidById.has(id)) state.pidById.set(id, hostPid);
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
      const content = buildPromptPin(key, request);
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
          by: "operator",
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
        const content = tuiPromptPin(state.tuiKey, tui.message);
        if (content && "capped" in pins.upsert(ref, content)) retry = true;
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

  private log(message: string, sessionId?: string, error?: unknown): void {
    this.options.errorLogger?.debug(`pin prompt mirror: ${message}`, {
      category: LOG_CATEGORY,
      ...(sessionId ? { sessionId } : {}),
      context: {
        error: error instanceof Error ? error.message : (error ?? null),
      },
      persist: false,
    });
  }
}
