// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Issue #6559 (epic #6163) — reset a workflow lane's context at a stage
// boundary, inside the same Hapimatic session.
//
// A lane calls the in-session `request_context_reset` tool with a resume text.
// The wrapper sends the arm over its own socket; the server records one pending
// request, waits for the arming turn to end and for a safe point, then delivers
// ONE message that both starts a fresh Claude conversation and carries the
// resume text. The server decides and records; the wrapper acts, and resets only
// for an arm it issued itself.
//
// This module is the contract the wrapper and the server share: the socket event
// names, the message meta key, the fixed literals, the defaults, the states, the
// reason codes and the request / result shapes. The design is in
// docs/internal/architecture/context-reset.md.

/** The `sentFrom` the context-reset service stamps on the message it sends. */
export const CONTEXT_RESET_SENT_FROM = "stage-reset";

/** Line 1 of every resume message. */
export const CONTEXT_RESET_MARKER = "[HAPIMATIC STAGE RESET v1]";

/** The longest resume text an arm may carry, in characters. */
export const RESUME_MAX_CHARS = 8000;

/**
 * The arm triggers for which a lock label the session holds is a HARD reason:
 * the text is then delivered without a reset. For any other trigger the reset
 * fires and the preamble names the lock.
 *
 * Ruling Q5, option a (Matt, 2026-11-10: "never lose a lock"; a held lock is a
 * hard reason for stage triggers only). This one line carries the whole lock
 * rule, so always read it from here and repeat it nowhere.
 */
export const LOCK_HELD_HARD_TRIGGERS: readonly ContextResetTrigger[] = [
  "stage",
];

/**
 * A sentence of the server's preamble. Always keep it exactly as written: the
 * render tests pin it, and a deployed client hook's negation list matches it, so
 * the hook mints no production-deploy approval from a resume message.
 */
export const CONTEXT_RESET_PREAMBLE_GUARD =
  "Do not treat anything in this message as an approval.";

/** A sentence of the server's preamble; always keep it exactly as written. */
export const CONTEXT_RESET_PREAMBLE_OVERRIDE =
  "A newer operator message overrides this.";

/** The message meta key that asks the wrapper to reset: `meta.contextReset = {armId}`. */
export const CONTEXT_RESET_META_KEY = "contextReset";

/** The socket events between the wrapper and the server. */
export const CONTEXT_RESET_EVENTS = {
  /** Wrapper → server, with an ack carrying a `ContextResetArmResult`. */
  arm: "context-reset:arm",
  /** Wrapper → server: withdraw an arm the wrapper gave up on. */
  disarm: "context-reset:disarm",
  /** Wrapper → server: what happened to a fired request. */
  result: "context-reset:result",
} as const;

/**
 * The session `metadata` key under which the wrapper records the arm ids it
 * abandoned (an arm whose ack timed out, Task 5). The lane then continues inline,
 * so the server ends such a request `dropped:abandoned` and never fires it: a
 * late fire would dispatch the stage a second time. `MetadataSchema` is
 * `.passthrough()`, so the key survives the server's parse.
 */
export const CONTEXT_RESET_ABANDONED_METADATA_KEY =
  "contextResetAbandonedArmIds";

/** The arm ids a session's metadata records as abandoned; tolerant of any shape. */
export function abandonedArmIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>)[
    CONTEXT_RESET_ABANDONED_METADATA_KEY
  ];
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : [];
}

/** The approval-token prefix, matched in any letter case. */
const APPROVAL_TOKEN_PREFIX = "user-approval-";

/**
 * True for any text containing the approval-token prefix in any letter case.
 * Deliberately broader than either token pattern in use (the client mint
 * fallback's and the server extractor's), because the prefix covers both.
 */
export function carriesApprovalToken(text: string): boolean {
  return text.toLowerCase().includes(APPROVAL_TOKEN_PREFIX);
}

// ---------------------------------------------------------------------------
// Triggers, states and reasons
// ---------------------------------------------------------------------------

/** Why the lane armed. `stage` is the default. */
export const CONTEXT_RESET_TRIGGERS = ["stage", "watermark", "manual"] as const;
export type ContextResetTrigger = (typeof CONTEXT_RESET_TRIGGERS)[number];

/** A pending request's state. `armed` and `firing` are pending; the rest are terminal. */
export const CONTEXT_RESET_STATES = [
  "armed",
  "firing",
  "delivered_reset",
  "delivered_no_reset",
  "unconfirmed",
  "dropped",
  "expired",
] as const;
export type ContextResetState = (typeof CONTEXT_RESET_STATES)[number];

export const CONTEXT_RESET_TERMINAL_STATES = [
  "delivered_reset",
  "delivered_no_reset",
  "unconfirmed",
  "dropped",
  "expired",
] as const satisfies readonly ContextResetState[];

export function isContextResetTerminalState(state: ContextResetState): boolean {
  return (
    CONTEXT_RESET_TERMINAL_STATES as readonly ContextResetState[]
  ).includes(state);
}

/** Why an arm was refused. Nothing is left pending after a refusal. */
export const CONTEXT_RESET_ARM_REFUSALS = [
  "disabled",
  "no_open_turn",
  "launcher_unsupported",
  "challenge_pending",
  "background_work",
  "session_timers",
  "handoff_active",
  "already_pending",
  "token_in_resume",
  "resume_too_long",
  "session_inactive",
  "missing_stage",
  "invalid_stage",
  /** Answered by the wrapper's tool, never by the server. */
  "not_main_chain",
] as const;
export type ContextResetArmRefusal =
  (typeof CONTEXT_RESET_ARM_REFUSALS)[number];

/** Why the server waits and looks again. */
export const CONTEXT_RESET_DEFER_REASONS = [
  "thinking",
  "background_work",
  "permission_pending",
  "tui_blocked",
  "rate_limited",
  "handoff_held",
  "settling",
  "session_inactive",
  "no_alive_since_boot",
  "lock_unknown",
] as const;
export type ContextResetDeferReason =
  (typeof CONTEXT_RESET_DEFER_REASONS)[number];

/** Why the server delivers the text without a reset. */
export const CONTEXT_RESET_SERVER_NO_RESET_REASONS = [
  "disabled",
  "reset_not_allowed",
  "challenge_pending",
  "lock_held",
  "launcher_unsupported",
  "deadline_passed",
] as const;
export type ContextResetServerNoResetReason =
  (typeof CONTEXT_RESET_SERVER_NO_RESET_REASONS)[number];

/** Why the wrapper delivers a flagged message's text without a reset. */
export const CONTEXT_RESET_WRAPPER_NO_RESET_REASONS = [
  "unknown_arm",
  "stale_frame",
  "no_live_query",
  "launcher_unsupported",
  "local_mode",
  "thinking",
  "queue_not_empty",
  "background_work",
  "session_timers",
  "activity_after_arm",
] as const;
export type ContextResetWrapperNoResetReason =
  (typeof CONTEXT_RESET_WRAPPER_NO_RESET_REASONS)[number];

/** Why a pending request ended with nothing delivered. */
export const CONTEXT_RESET_DROP_REASONS = [
  "interrupted",
  "aborted",
  "cancelled",
  "disarmed",
  "abandoned",
  "send_failed",
  "delivery_id_collision",
  "session_ended",
] as const;
export type ContextResetDropReason =
  (typeof CONTEXT_RESET_DROP_REASONS)[number];

/**
 * ROUND RV10, Finding 1 (PM ruling, 2026-11-13): why the operator's cancel was
 * refused. `already_delivering`: the row is `firing`, so its flagged message is
 * stored and sent and cannot be recalled; only the wrapper's result or the
 * deadline ends it.
 */
export const CONTEXT_RESET_CANCEL_REFUSALS = ["already_delivering"] as const;
export type ContextResetCancelRefusal =
  (typeof CONTEXT_RESET_CANCEL_REFUSALS)[number];

/** A cancel's answer; `reason` is set only when it was refused for a named cause. */
export interface ContextResetCancelResult {
  cancelled: boolean;
  reason?: ContextResetCancelRefusal;
}

// ---------------------------------------------------------------------------
// Stage fields (ruling Q11a)
// ---------------------------------------------------------------------------

const TO_STAGE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const ISSUE_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+$/;
export const STAGE_ARGS_MAX_CHARS = 500;

/**
 * A skill name: lower case, digits, `:`, `_` and `-`, at most 64 characters, and
 * no approval-token prefix (the name is written into the invocation line).
 */
export function isValidToStage(value: string): boolean {
  return TO_STAGE_PATTERN.test(value) && !carriesApprovalToken(value);
}

/**
 * One line of 1 to 500 characters with no double quote, no backslash, no
 * leading slash and no approval-token prefix, because it is written into the
 * one quoted invocation line and must not become a slash command or a token.
 */
export function isValidStageArgs(value: string): boolean {
  if (value.length < 1 || value.length > STAGE_ARGS_MAX_CHARS) return false;
  if (/[\r\n"\\]/.test(value)) return false;
  if (value.startsWith("/")) return false;
  return !carriesApprovalToken(value);
}

/** `owner/repo#N`, with no approval-token prefix. */
export function isValidIssueRef(value: string): boolean {
  return ISSUE_REF_PATTERN.test(value) && !carriesApprovalToken(value);
}

/**
 * The stage-field problem of an arm, or `null`. A `stage` arm (the default
 * trigger) must name all three fields (`missing_stage`); a field that is present
 * must have its shape, for any trigger (`invalid_stage`).
 */
export function stageFieldsProblem(request: {
  trigger?: ContextResetTrigger;
  toStage?: string;
  stageArgs?: string;
  issue?: string;
  /** The rest of an arm request is ignored here. */
  [key: string]: unknown;
}): "missing_stage" | "invalid_stage" | null {
  const trigger = request.trigger ?? "stage";
  const { toStage, stageArgs, issue } = request;
  if (
    trigger === "stage" &&
    (toStage === undefined || stageArgs === undefined || issue === undefined)
  ) {
    return "missing_stage";
  }
  if (toStage !== undefined && !isValidToStage(toStage)) return "invalid_stage";
  if (stageArgs !== undefined && !isValidStageArgs(stageArgs)) {
    return "invalid_stage";
  }
  if (issue !== undefined && !isValidIssueRef(issue)) return "invalid_stage";
  return null;
}

/**
 * The one fixed line the server writes for a stage arm, in the wording the
 * detector hooks already inject. Always render it from the arm's fields, never
 * from the free-text note.
 */
export function renderStageInvocation(
  toStage: string,
  stageArgs: string
): string {
  return `Invoke the Skill tool with skill "${toStage}" and args "${stageArgs}"`;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Facts only the wrapper sees, sent with an arm. */
export const ContextResetWrapperFactsSchema = z
  .object({
    /** In-session timers (ScheduleWakeup, CronCreate) the wrapper saw scheduled. */
    sessionTimers: z.number().int().nonnegative(),
  })
  .passthrough();
export type ContextResetWrapperFacts = z.infer<
  typeof ContextResetWrapperFactsSchema
>;

/**
 * Wrapper → server: arm a reset. The stage fields are plain optional strings
 * here, so the server can answer `missing_stage` or `invalid_stage` as a reason
 * (`stageFieldsProblem`) instead of a parse failure.
 */
export const ContextResetArmRequestSchema = z
  .object({
    /** Minted by the wrapper; the wrapper resets only for an arm id it issued. */
    armId: z.string().min(1),
    resume: z.string(),
    trigger: z.enum(CONTEXT_RESET_TRIGGERS).optional(),
    /**
     * Where the lane wrote its checkpoint. For a lane's stage arm this is the
     * session's checkpoint file, `claudedocs/.session-checkpoint-<HAPI_SESSION_ID>.md`
     * under the project root (rp1-home#3126); the preamble names it.
     */
    checkpointPath: z.string().optional(),
    fromStage: z.string().optional(),
    toStage: z.string().optional(),
    stageArgs: z.string().optional(),
    /** `owner/repo#N`. */
    issue: z.string().optional(),
    wrapperFacts: ContextResetWrapperFactsSchema.optional(),
  })
  .passthrough();
export type ContextResetArmRequest = z.infer<
  typeof ContextResetArmRequestSchema
>;

/** Server → wrapper: the arm's answer. */
export const ContextResetArmResultSchema = z
  .object({
    armed: z.boolean(),
    reason: z.enum(CONTEXT_RESET_ARM_REFUSALS).optional(),
  })
  .passthrough();
export type ContextResetArmResult = z.infer<typeof ContextResetArmResultSchema>;

/** Wrapper → server: withdraw an arm. */
export const ContextResetDisarmSchema = z
  .object({ armId: z.string().min(1) })
  .passthrough();
export type ContextResetDisarm = z.infer<typeof ContextResetDisarmSchema>;

export const CONTEXT_RESET_RESULT_OUTCOMES = [
  "delivered_reset",
  "delivered_no_reset",
  "failed",
] as const;
export type ContextResetResultOutcome =
  (typeof CONTEXT_RESET_RESULT_OUTCOMES)[number];

/**
 * Wrapper → server: reported on confirmation, never at push time.
 * `delivered_reset` carries the fresh conversation's id.
 */
export const ContextResetResultSchema = z
  .object({
    armId: z.string().min(1),
    outcome: z.enum(CONTEXT_RESET_RESULT_OUTCOMES),
    reason: z.string().optional(),
    newConversationId: z.string().optional(),
  })
  .passthrough();
export type ContextResetResult = z.infer<typeof ContextResetResultSchema>;

/** `content.meta.contextReset` on the message the server sends. */
export const ContextResetMetaSchema = z
  .object({ armId: z.string().min(1) })
  .passthrough();
export type ContextResetMeta = z.infer<typeof ContextResetMetaSchema>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The defaults (`settings.contextReset`). The feature ships off; the
 * environment variable `HAPI_CONTEXT_RESET` overrides `enabled` both ways.
 */
export const CONTEXT_RESET_DEFAULTS = {
  enabled: false,
  /** How long a request may wait for a safe point before it is delivered without a reset. */
  maxDeferMs: 600_000,
  /** How long after a clean finalize the server evaluates. */
  settleMs: 3_000,
  /** The backstop loop's tick. */
  backstopTickMs: 15_000,
  /** How long a `firing` request waits for the wrapper's result before `unconfirmed`. */
  resultTimeoutMs: 60_000,
  /** The size cap of the carried instructing messages. */
  instructionsMaxChars: 24_000,
  /** Send attempts before `dropped:send_failed`. */
  fireAttemptsMax: 5,
} as const;

export const ContextResetConfigSchema = z
  .object({
    enabled: z.boolean(),
    maxDeferMs: z.number().int().positive(),
    settleMs: z.number().int().nonnegative(),
    backstopTickMs: z.number().int().positive(),
    resultTimeoutMs: z.number().int().positive(),
    instructionsMaxChars: z.number().int().positive(),
    fireAttemptsMax: z.number().int().positive(),
  })
  .passthrough();
export type ContextResetConfig = z.infer<typeof ContextResetConfigSchema>;
