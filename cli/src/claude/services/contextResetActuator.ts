// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6559: the SDK launcher's share of a context reset, kept out of
 * `claudeRemoteLauncher.ts` (which sits at the 1,500-line lint cap) so the
 * launcher holds call sites only.
 *
 * Task 4 (R2, R4, R6, R8, R9, R14): the wrapper acts on a flagged message. The
 * server stamps `meta.contextReset = {armId}` on the ONE message it sends for a
 * pending request; this module decides, at the moment the message arrives,
 * whether this wrapper can start a fresh conversation with it (a pure decision,
 * {@link decideLocalReset}) and reports what happened on confirmation, never at
 * push time (Q2a):
 *   - `delivered_reset` with the fresh conversation's id, when the session
 *     reports a conversation id different from the one before the reset;
 *   - `delivered_no_reset` with the reason, when the text is handed to the SDK
 *     as an ordinary message;
 *   - `failed` with a reason, when the launch that took the reset item ends with
 *     no new conversation (a launch error, a return, or the launcher leaving
 *     with the item still parked, the credential checks' throw included).
 */
import {
  CONTEXT_RESET_DEFAULTS,
  CONTEXT_RESET_META_KEY,
  CONTEXT_RESET_TRIGGERS,
  ContextResetMetaSchema,
  type ContextResetArmRequest,
  type ContextResetArmResult,
  type ContextResetResult,
  type ContextResetWrapperNoResetReason,
} from "@hapi/protocol";
import {
  sessionBusyReason,
  type SessionBusySignal,
} from "@hapi/protocol/sessionBusy";
import type { SDKMessage } from "@/claude/sdk";
import { WATCHED_CRON_TOOLS } from "@/claude/utils/cronUsageDetector";
import { HAPI_MCP_SERVER_NAME } from "@/claude/utils/scrubHapiOnSpawn";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/ui/logger";
import type { QueueControl, QueuedMessage } from "@/utils/MessageQueue2";
import { z } from "zod";

/**
 * Whether a launch that returned in under `MIN_HEALTHY_DURATION_MS` ended fast
 * on purpose, so the launcher does not count it as a failed start (Task 2, R12).
 * A launch ends fast on purpose when it took a reset item or a typed `/clear`
 * as its first item, or when it returned with an item parked for the next
 * launch (an isolated item or a mode change ends the query by design). Counted,
 * two typed clears under 5 s apart, or three resets, ended the wrapper.
 */
export function isIntentionalFastReturn(
  initial: QueuedMessage<unknown> | null,
  parked: QueuedMessage<unknown> | null
): boolean {
  if (parked) return true;
  if (!initial) return false;
  return (
    initial.control === "reset" ||
    parseSpecialCommand(initial.message).type === "clear"
  );
}

// ---------------------------------------------------------------------------
// The decision (Task 4)
// ---------------------------------------------------------------------------

/** What the wrapper knows at the moment a flagged message arrives. */
export interface LocalResetFacts {
  /** Binding 1: this wrapper issued the arm id (Task 5's tool). */
  armKnown: boolean;
  /** Binding 1: the server answered that arm `armed`. */
  armAcked: boolean;
  /** A main-chain tool call came after the "armed" answer. */
  armTainted: boolean;
  /** The message came in a live socket frame (not a reconnect backfill). */
  liveFrame: boolean;
  /** How old the message is (now minus the server's `createdAt`); null = unknown. */
  frameAgeMs: number | null;
  /** The shared result timeout; the wrapper does not read the server's settings. */
  resultTimeoutMs: number;
  /** `sdk`, `pty` or `tmux`; only the sdk launcher has an actuator. */
  launcherKind: string;
  /** The session runs in local mode (the terminal TUI). */
  localMode: boolean;
  /** `session.getLiveQuery() !== null`. */
  liveSdkQuery: boolean;
  /** A turn is running. */
  thinking: boolean;
  /** Messages already in the session queue. */
  queueSize: number;
  /** The launcher holds an item parked for its next launch. */
  parkedItem: boolean;
  /** `sessionBusyReason` over the wrapper's own background-work tracker. */
  busyReason: ReturnType<typeof sessionBusyReason>;
  /** A ScheduleWakeup or CronCreate this conversation set is still pending. */
  sessionTimers: boolean;
}

export type LocalResetDecision =
  | { kind: "reset" }
  | { kind: "no_reset"; reason: ContextResetWrapperNoResetReason };

const noReset = (
  reason: ContextResetWrapperNoResetReason
): LocalResetDecision => ({ kind: "no_reset", reason });

/**
 * Whether this wrapper resets for a flagged message. Binding 1 comes first and
 * holds with the switch off too: the wrapper resets only for an arm id it
 * issued and saw acknowledged `armed`, on a live frame younger than the result
 * timeout, so a forged or replayed flag delivers its text as plain text. Then
 * the arm's own taint, then whether this launcher can act, then the session's
 * state at this moment (the server's view is up to 2 s old).
 */
export function decideLocalReset(f: LocalResetFacts): LocalResetDecision {
  if (!f.armKnown || !f.armAcked) return noReset("unknown_arm");
  if (
    !f.liveFrame ||
    f.frameAgeMs === null ||
    f.frameAgeMs > f.resultTimeoutMs
  ) {
    return noReset("stale_frame");
  }
  if (f.armTainted) return noReset("activity_after_arm");
  if (f.launcherKind !== "sdk") return noReset("launcher_unsupported");
  if (f.localMode) return noReset("local_mode");
  if (!f.liveSdkQuery) return noReset("no_live_query");
  if (f.thinking || f.busyReason === "mid-inference") {
    return noReset("thinking");
  }
  if (f.queueSize > 0 || f.parkedItem) return noReset("queue_not_empty");
  if (f.busyReason !== null) return noReset("background_work");
  if (f.sessionTimers) return noReset("session_timers");
  return { kind: "reset" };
}

// ---------------------------------------------------------------------------
// The actuator: one per Claude session
// ---------------------------------------------------------------------------

/** How the message reached the wrapper (`ApiSessionClient`). */
export interface IncomingFrame {
  live: boolean;
  createdAt?: number;
}

/** What the actuator needs from the session, as closures (runClaude wires them). */
export interface ContextResetHost {
  /** The current conversation id (`session.sessionId`). */
  conversationId(): string | null;
  launcherKind(): string;
  localMode(): boolean;
  liveSdkQuery(): boolean;
  thinking(): boolean;
  queueSize(): number;
  backgroundAgents(): SessionBusySignal["backgroundAgents"];
  /** Pushes the ONE reset item (Task 2): the text with `control: "reset"`. */
  pushReset(text: string, mode: unknown): void;
  /** Sends `context-reset:result` over the wrapper's own socket. */
  emitResult(result: ContextResetResult): void;
  now(): number;
}

interface ArmRecord {
  acked: boolean;
  /** When the server answered `armed` (for the taint rule). */
  ackedAt: number | null;
  tainted: boolean;
}

/** A flagged message whose outcome is not reported yet. */
interface Delivery {
  armId: string;
  text: string;
  /** `reset`: the reset item; otherwise the reason it goes as plain text. */
  plainReason: ContextResetWrapperNoResetReason | null;
  /** The conversation id when the reset item was pushed. */
  preResetId: string | null;
  /** The launcher handed the reset item to a launch. */
  taken: boolean;
}

interface PendingTimer {
  conversationId: string | null;
  /** A ScheduleWakeup's due time; null = a CronCreate, pending until deleted. */
  dueAt: number | null;
}

/** Arm ids remembered; an older one is forgotten (and reads as unknown). */
const ARMS_REMEMBERED = 32;
/** The arm tool's bare name (`HAPY_MCP_TOOL_NAMES`). */
export const CONTEXT_RESET_TOOL_NAME = "request_context_reset";
/** The name the tool's calls carry in the SDK stream (Claude's MCP prefix). */
const STREAM_TOOL_NAME = `mcp__${HAPI_MCP_SERVER_NAME}__${CONTEXT_RESET_TOOL_NAME}`;
/** Binding 5: how long the tool waits for its call to show in the stream. */
export const MAIN_CHAIN_WAIT_MS = 1_000;
/** How long the tool waits for the server's answer to an arm. */
export const ARM_ACK_TIMEOUT_MS = 10_000;
const REASON_DETAIL_MAX = 200;

/**
 * One per Claude session (`session.contextReset`). Task 5's tool records the
 * arms it issues and the server's answers here (binding 1); runClaude hands it
 * each flagged message; the SDK launcher reports its hand-overs, its SDK stream
 * and the end of each launch.
 */
export class ContextResetActuator {
  private readonly arms = new Map<string, ArmRecord>();
  private readonly deliveries = new Map<string, Delivery>();
  private timers: PendingTimer[] = [];
  private parkedProbe: (() => boolean) | null = null;
  /** Binding 5: the arm tool's main-chain calls in flight, tool-use id to resume text. */
  private readonly toolCalls = new Map<string, string>();
  private callWaiters: Array<(resume: string) => boolean> = [];

  constructor(
    private readonly host: ContextResetHost,
    private readonly resultTimeoutMs: number = CONTEXT_RESET_DEFAULTS.resultTimeoutMs
  ) {}

  // -- binding 1: the arms this wrapper issued (Task 5) ----------------------

  noteArmIssued(armId: string): void {
    this.arms.set(armId, { acked: false, ackedAt: null, tainted: false });
    while (this.arms.size > ARMS_REMEMBERED) {
      const oldest = this.arms.keys().next().value;
      if (oldest === undefined) break;
      this.arms.delete(oldest);
    }
  }

  /** The server's answer to an arm this wrapper issued. */
  noteArmAnswered(armId: string, armed: boolean): void {
    const arm = this.arms.get(armId);
    if (!arm) return;
    arm.acked = armed;
    arm.ackedAt = armed ? this.host.now() : null;
  }

  /** The launcher's parked item, read when a flagged message arrives. */
  setParkedProbe(probe: (() => boolean) | null): void {
    this.parkedProbe = probe;
  }

  /** Whether a timer this conversation set is pending. */
  hasPendingTimers(): boolean {
    return this.pendingTimerCount() > 0;
  }

  /** How many timers this conversation set are pending (Task 5's `wrapperFacts`). */
  pendingTimerCount(): number {
    const now = this.host.now();
    const current = this.host.conversationId();
    this.timers = this.timers.filter(t => t.dueAt === null || t.dueAt > now);
    // A timer recorded before the conversation id was known counts, because a
    // wrongly cut wakeup costs more than a reset that falls back to plain text.
    return this.timers.filter(
      t => t.conversationId === null || t.conversationId === current
    ).length;
  }

  // -- the SDK stream (taint and timers) -------------------------------------

  /**
   * The raw SDK stream, from the launcher's `onMessage` head. A main-chain tool
   * call after an arm's "armed" answer taints that arm; a ScheduleWakeup or a
   * CronCreate is a pending timer of this conversation.
   */
  onSdkMessage(message: SDKMessage): void {
    if (message.type === "user") {
      this.noteToolResults(message);
      return;
    }
    if (message.type !== "assistant") return;
    const m = message as {
      parent_tool_use_id?: string | null;
      message?: { content?: unknown };
    };
    if (m.parent_tool_use_id) return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    const now = this.host.now();
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") {
        continue;
      }
      for (const arm of this.arms.values()) {
        if (arm.acked && arm.ackedAt !== null && arm.ackedAt <= now) {
          arm.tainted = true;
        }
      }
      this.noteToolCall(block);
      this.noteTimer(block.name, block.input, now);
    }
  }

  /** Binding 5: a main-chain call of the arm tool, in flight until its result. */
  private noteToolCall(block: Record<string, unknown>): void {
    if (block.name !== STREAM_TOOL_NAME || typeof block.id !== "string") return;
    const resume = (block.input as { resume?: unknown } | null)?.resume;
    if (typeof resume !== "string") return;
    this.toolCalls.set(block.id, resume);
    this.callWaiters = this.callWaiters.filter(take => !take(resume));
  }

  private noteToolResults(message: SDKMessage): void {
    const m = message as {
      parent_tool_use_id?: string | null;
      message?: { content?: unknown };
    };
    if (m.parent_tool_use_id) return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        this.toolCalls.delete(block.tool_use_id);
      }
    }
  }

  private takeToolCall(resume: string): boolean {
    for (const [id, text] of this.toolCalls) {
      if (text !== resume) continue;
      this.toolCalls.delete(id);
      return true;
    }
    return false;
  }

  /** A4 (#6559 PR 1 round 2): only sdk in remote mode feeds binding 5's stream. */
  armCheck(): "main_chain" | "server" | "local_mode" {
    if (this.host.launcherKind() !== "sdk") return "server";
    return this.host.localMode() ? "local_mode" : "main_chain";
  }

  /**
   * Binding 5: whether this session's main chain has the arm tool's call with
   * this resume text in flight, waiting up to `timeoutMs` for it to show in the
   * stream (the MCP request can reach the tool before the stream message reaches
   * the launcher). A sub-agent's call never shows here. A call is used once.
   */
  awaitMainChainCall(
    resume: string,
    timeoutMs: number = MAIN_CHAIN_WAIT_MS
  ): Promise<boolean> {
    if (this.takeToolCall(resume)) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const take = (seen: string): boolean => {
        if (settled || seen !== resume || !this.takeToolCall(resume)) {
          return settled;
        }
        settled = true;
        clearTimeout(timer);
        resolve(true);
        return true;
      };
      const timer = setTimeout(() => {
        settled = true;
        this.callWaiters = this.callWaiters.filter(w => w !== take);
        resolve(false);
      }, timeoutMs);
      this.callWaiters.push(take);
    });
  }

  private noteTimer(name: string, input: unknown, now: number): void {
    const conversationId = this.host.conversationId();
    if (name === "CronDelete") {
      const at = this.timers.findIndex(t => t.dueAt === null);
      if (at >= 0) this.timers.splice(at, 1);
      return;
    }
    if (!WATCHED_CRON_TOOLS.has(name)) return;
    if (name === "ScheduleWakeup") {
      const seconds = Number(
        (input as { delaySeconds?: unknown } | null)?.delaySeconds
      );
      // An unreadable delay keeps the timer until the conversation changes.
      const dueAt =
        Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : null;
      this.timers.push({ conversationId, dueAt });
      return;
    }
    this.timers.push({ conversationId, dueAt: null });
  }

  // -- a flagged message arrives (runClaude's onUserMessage) -----------------

  /**
   * Returns true when the message was a reset and its ONE item is pushed; the
   * caller then stops. Returns false for every other message, flagged or not,
   * so the caller's ordinary path runs exactly as before: a wrapper that does
   * not reset delivers the text as an ordinary message (R8). A flagged message
   * that goes as plain text is reported when the launcher hands it over.
   */
  onUserMessage(
    message: { content: { text: string }; meta?: Record<string, unknown> },
    frame: IncomingFrame,
    mode: unknown
  ): boolean {
    const raw = message.meta?.[CONTEXT_RESET_META_KEY];
    if (raw === undefined) return false;
    const meta = ContextResetMetaSchema.safeParse(raw);
    if (!meta.success) {
      logger.debug("[context-reset] a malformed flag; delivered as text");
      return false;
    }
    const armId = meta.data.armId;
    const text = message.content.text;
    const arm = this.arms.get(armId);
    const decision = decideLocalReset({
      armKnown: arm !== undefined,
      armAcked: arm?.acked === true,
      armTainted: arm?.tainted === true,
      liveFrame: frame.live,
      frameAgeMs:
        typeof frame.createdAt === "number"
          ? this.host.now() - frame.createdAt
          : null,
      resultTimeoutMs: this.resultTimeoutMs,
      launcherKind: this.host.launcherKind(),
      localMode: this.host.localMode(),
      liveSdkQuery: this.host.liveSdkQuery(),
      thinking: this.host.thinking(),
      queueSize: this.host.queueSize(),
      parkedItem: this.parkedProbe?.() === true,
      busyReason: sessionBusyReason({
        backgroundAgents: this.host.backgroundAgents(),
      }),
      sessionTimers: this.hasPendingTimers(),
    });
    logger.debug(
      `[context-reset] flagged message for arm ${armId}: ${decision.kind === "reset" ? "reset" : `no reset (${decision.reason})`}`
    );
    // The arm is used: a second flagged message for it reads as unknown.
    this.arms.delete(armId);
    if (decision.kind === "no_reset") {
      this.deliveries.set(armId, {
        armId,
        text,
        plainReason: decision.reason,
        preResetId: null,
        taken: false,
      });
      // The tmux and pty launchers take no SDK hand-over this module can see;
      // the queue push is the last point it observes (a named choice).
      if (decision.reason === "launcher_unsupported") {
        this.report(armId, "delivered_no_reset", decision.reason);
      }
      return false;
    }
    this.deliveries.set(armId, {
      armId,
      text,
      plainReason: null,
      preResetId: this.host.conversationId(),
      taken: false,
    });
    this.host.pushReset(text, mode);
    return true;
  }

  // -- the launcher's reports --------------------------------------------------

  /**
   * Wraps the launcher's `nextMessage` closure: every item it returns is handed
   * to the SDK (a launch's first prompt, or a prompt pushed into the live query).
   */
  onHandedOver(item: { message: string; control?: QueueControl }): void {
    for (const d of this.deliveries.values()) {
      if (d.text !== item.message) continue;
      if (d.plainReason === null && item.control === "reset") {
        d.taken = true;
        return;
      }
      if (d.plainReason !== null && item.control === undefined) {
        this.report(d.armId, "delivered_no_reset", d.plainReason);
        return;
      }
    }
  }

  /** The session reported a conversation id (`addSessionFoundCallback`). */
  onSessionFound(conversationId: string): void {
    for (const d of this.deliveries.values()) {
      if (!d.taken) continue;
      if (conversationId === d.preResetId) continue;
      this.report(d.armId, "delivered_reset", undefined, conversationId);
    }
  }

  /** The launch's catch path: a taken reset item ends `failed` with the error. */
  onLaunchFailed(detail: string): void {
    this.failTaken(
      `launch_error: ${detail.slice(0, REASON_DETAIL_MAX)}`,
      d => d.taken
    );
  }

  /** The launch's `finally`: a taken reset item with no new id ends `failed`. */
  onLaunchEnded(): void {
    this.failTaken("ended_without_new_conversation", d => d.taken);
  }

  /**
   * The launcher is leaving (its outer `finally`). A reset item still parked
   * for the next launch dies with it, as when the credential checks before the
   * launch throw.
   */
  onLauncherExit(parked: { message: string; control?: QueueControl } | null) {
    this.parkedProbe = null;
    if (parked?.control !== "reset") return;
    this.failTaken(
      "launcher_exited_before_the_reset_launch",
      d => d.plainReason === null && d.text === parked.message
    );
  }

  private failTaken(reason: string, which: (d: Delivery) => boolean): void {
    for (const d of [...this.deliveries.values()]) {
      if (which(d)) this.report(d.armId, "failed", reason);
    }
  }

  private report(
    armId: string,
    outcome: ContextResetResult["outcome"],
    reason?: string,
    newConversationId?: string
  ): void {
    if (!this.deliveries.delete(armId)) return;
    const result: ContextResetResult = {
      armId,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(newConversationId === undefined ? {} : { newConversationId }),
    };
    logger.debug(
      `[context-reset] result for arm ${armId}: ${outcome}${reason ? ` (${reason})` : ""}`
    );
    try {
      this.host.emitResult(result);
    } catch (error) {
      logger.warn("[context-reset] the result could not be sent", error);
    }
  }
}

/**
 * Wraps the launcher's `nextMessage` so every item it hands out is reported to
 * the actuator; with no actuator (a test session) it returns `fetch` itself.
 */
export function tapNextMessage<
  R extends { message: string; control?: QueueControl } | null,
>(
  actuator: ContextResetActuator | undefined,
  fetch: () => Promise<R>
): () => Promise<R> {
  if (!actuator) return fetch;
  return async () => {
    const item = await fetch();
    if (item) actuator.onHandedOver(item);
    return item;
  };
}

// ---------------------------------------------------------------------------
// Task 5: the arm tool (`request_context_reset`)
// ---------------------------------------------------------------------------

/** What the arm tool needs; `startHappyServer` wires these to the session. */
export interface ContextResetToolDeps {
  /** The session's actuator; absent before the session is ready or off Claude. */
  getActuator(): ContextResetActuator | undefined;
  /** `context-reset:arm` with an ack; rejects when no answer comes in time. */
  arm(
    request: ContextResetArmRequest,
    timeoutMs: number
  ): Promise<ContextResetArmResult>;
  /** `context-reset:disarm`. */
  disarm(armId: string): void;
  /** Records the arm id as abandoned in the session metadata. */
  recordAbandoned(armId: string): void;
  newArmId(): string;
  mainChainWaitMs?: number;
  ackTimeoutMs?: number;
}

export const ContextResetToolInputSchema = z.object({
  resume: z
    .string()
    .describe(
      "Your notes for the fresh conversation: where the checkpoint is and what comes next."
    ),
  trigger: z
    .enum(CONTEXT_RESET_TRIGGERS)
    .optional()
    .describe("Why: stage (the default), watermark or manual."),
  checkpointPath: z
    .string()
    .optional()
    .describe(
      "For a stage arm, the session's checkpoint file: claudedocs/.session-checkpoint-$HAPI_SESSION_ID.md under the project root."
    ),
  fromStage: z.string().optional().describe("The stage skill that is ending."),
  toStage: z
    .string()
    .optional()
    .describe(
      "Required for a stage arm: the next stage's skill, e.g. issue-tester."
    ),
  stageArgs: z
    .string()
    .optional()
    .describe("Required for a stage arm: that skill's arguments, one line."),
  issue: z
    .string()
    .optional()
    .describe("Required for a stage arm: owner/repo#N."),
});
type ContextResetToolInput = z.infer<typeof ContextResetToolInputSchema>;

export const CONTEXT_RESET_TOOL_DESCRIPTION =
  "Arm a context reset: when this turn ends cleanly, Hapimatic continues this session in a fresh conversation that starts with your resume notes. A stage arm (the default trigger) must name toStage, stageArgs and issue, because the fresh conversation has no skill loaded until that line invokes one; pass checkpointPath as claudedocs/.session-checkpoint-$HAPI_SESSION_ID.md under the project root. If armed, end your turn at once with no further tool call.";

const toolText = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError,
});

const refusedText = (why: string) =>
  toolText(
    `Context reset refused: ${why}. Nothing is pending; continue as before.`
  );

/**
 * The arm tool. Binding 5: it arms only for a main-chain call (the session's
 * own SDK stream shows this tool's call with the same resume text), because
 * the in-session MCP endpoint is unauthenticated loopback HTTP that sub-agents
 * share. Then it sends the arm over the wrapper's own socket, remembers the
 * arm id and the answer (binding 1), and on no answer in time withdraws the
 * arm and records it as abandoned, because the lane then continues inline and
 * a late fire must not dispatch the stage a second time. It answers every
 * failure as a refusal, because an unanswered tool call leaves the lane waiting.
 */
export function createContextResetTool(deps: ContextResetToolDeps): {
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodTypeAny;
  };
  handler: (args: ContextResetToolInput) => Promise<{
    content: { type: "text"; text: string }[];
    isError: boolean;
  }>;
} {
  const handler = async (args: ContextResetToolInput) => {
    try {
      const actuator = deps.getActuator();
      if (!actuator) return refusedText("launcher_unsupported");
      const check = actuator.armCheck();
      if (check === "local_mode") return refusedText("local_mode");
      const onMainChain =
        check === "server" || // the server refuses it launcher_unsupported
        (await actuator.awaitMainChainCall(
          args.resume,
          deps.mainChainWaitMs ?? MAIN_CHAIN_WAIT_MS
        ));
      if (!onMainChain) return refusedText("not_main_chain");
      const armId = deps.newArmId();
      actuator.noteArmIssued(armId);
      let answer: ContextResetArmResult;
      try {
        answer = await deps.arm(
          {
            ...args,
            armId,
            wrapperFacts: { sessionTimers: actuator.pendingTimerCount() },
          },
          deps.ackTimeoutMs ?? ARM_ACK_TIMEOUT_MS
        );
      } catch (error) {
        logger.warn(`[context-reset] arm ${armId} got no answer`, error);
        actuator.noteArmAnswered(armId, false);
        deps.disarm(armId);
        deps.recordAbandoned(armId);
        return refusedText("the server did not answer in time");
      }
      actuator.noteArmAnswered(armId, answer.armed === true);
      if (answer.armed !== true) {
        return refusedText(answer.reason ?? "refused by the server");
      }
      return toolText(
        `Context reset armed (${armId}). End your turn now and make no further tool call: this session continues in a fresh conversation that starts with your resume notes.`
      );
    } catch (error) {
      logger.warn("[context-reset] the arm tool failed", error);
      return refusedText("the arm could not be sent");
    }
  };
  return {
    config: {
      title: "Request Context Reset",
      description: CONTEXT_RESET_TOOL_DESCRIPTION,
      inputSchema: ContextResetToolInputSchema,
    },
    handler,
  };
}
